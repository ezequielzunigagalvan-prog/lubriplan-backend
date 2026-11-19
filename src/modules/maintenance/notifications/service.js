import prisma from "../../../prisma.js";
import { logger } from "../../../config/logger.js";
import { getLowStockAlerts } from "../inventory/service.js";
import { isOverdue, daysOverdue, CLOSED_STATUSES } from "../workOrders/due.js";

const DAY = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 30;
const OPEN_WO = ["APPROVED", "ASSIGNED", "IN_PROGRESS", "WAITING_PARTS", "WAITING_PRODUCTION"];
export const OVERLOAD_THRESHOLD = 5; // órdenes abiertas por técnico

/** Tipo de notificación -> campo de preferencia que la habilita (los que no aparecen siempre se envían). */
const TYPE_PREFERENCE = {
  LOW_STOCK: "lowStockEnabled",
  OVERDUE_WO: "overdueWoEnabled",
  TECHNICIAN_OVERLOAD: "technicianOverloadEnabled",
  PREVENTIVE_SOON: "preventiveSoonEnabled",
  PLAN_DUE: "preventiveSoonEnabled",
  CRITICAL_FAILURE: "criticalFailureEnabled",
};
export const PREFERENCE_FIELDS = [...new Set([...Object.values(TYPE_PREFERENCE), "inAppEnabled", "emailEnabled"])];

const woNumber = (n) => `OT-${String(n).padStart(5, "0")}`;

// ============================================================
// DESTINATARIOS
// ============================================================

/** Usuarios ADMIN/SUPERVISOR activos de la planta. */
export async function managerUserIds(plantId) {
  const rows = await prisma.userPlant.findMany({
    where: { plantId, active: true, user: { active: true, role: { in: ["ADMIN", "SUPERVISOR"] } } },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

/** Usuario vinculado a un técnico (o null). */
async function technicianUserId(technicianId) {
  if (!technicianId) return null;
  const user = await prisma.user.findFirst({ where: { technicianId, active: true }, select: { id: true } });
  return user?.id ?? null;
}

// ============================================================
// CREACIÓN
// ============================================================

/**
 * Crea una notificación por destinatario (cada uno la lee por separado), respetando sus preferencias
 * y sin repetir el mismo aviso (tipo + referencia + usuario) dentro de `dedupeHours`.
 */
export async function notifyUsers(plantId, userIds, data, { dedupeHours = 24 } = {}) {
  const recipients = [...new Set(userIds.filter(Boolean))];
  if (recipients.length === 0) return [];

  const prefField = TYPE_PREFERENCE[data.type];
  const prefs = await prisma.mtNotificationPreference.findMany({
    where: { userId: { in: recipients } },
  });
  const prefOf = new Map(prefs.map((p) => [p.userId, p]));
  const allowed = recipients.filter((id) => {
    const p = prefOf.get(id);
    if (!p) return true; // sin preferencias guardadas = todo habilitado
    return p.inAppEnabled !== false && (!prefField || p[prefField] !== false);
  });
  if (allowed.length === 0) return [];

  let targets = allowed;
  if (dedupeHours > 0 && data.referenceId != null) {
    const recent = await prisma.mtNotification.findMany({
      where: {
        plantId,
        type: data.type,
        referenceId: data.referenceId,
        userId: { in: allowed },
        createdAt: { gte: new Date(Date.now() - dedupeHours * 3600000) },
      },
      select: { userId: true },
    });
    const already = new Set(recent.map((r) => r.userId));
    targets = allowed.filter((id) => !already.has(id));
  }
  if (targets.length === 0) return [];

  const expiresAt = new Date(Date.now() + RETENTION_DAYS * DAY);
  await prisma.mtNotification.createMany({
    data: targets.map((userId) => ({
      plantId,
      userId,
      type: data.type,
      title: data.title,
      message: data.message,
      severity: data.severity || "INFO",
      referenceId: data.referenceId ?? null,
      referenceType: data.referenceType ?? null,
      actionUrl: data.actionUrl ?? null,
      actionLabel: data.actionLabel ?? null,
      expiresAt,
    })),
  });
  return targets;
}

/** Compatibilidad: notificación individual. */
export async function createNotification(plantId, data) {
  return notifyUsers(plantId, [data.userId], data, { dedupeHours: 0 });
}

// ============================================================
// CONSULTA Y LECTURA
// ============================================================

/** Visibles para el usuario: las suyas y las antiguas de difusión (userId null). */
function visibleWhere(plantId, userId) {
  return { plantId, OR: [{ userId }, { userId: null }], expiresAt: { gt: new Date() } };
}

/** Tipos que el usuario desactivó en sus preferencias (no se muestran). */
async function disabledTypes(userId) {
  const prefs = await prisma.mtNotificationPreference.findUnique({ where: { userId } });
  if (!prefs) return [];
  return Object.entries(TYPE_PREFERENCE).filter(([, field]) => prefs[field] === false).map(([type]) => type);
}

export async function getUserNotifications(plantId, userId, { limit = 50, unreadOnly = false, type } = {}) {
  const hidden = await disabledTypes(userId);
  return prisma.mtNotification.findMany({
    where: {
      ...visibleWhere(plantId, userId),
      ...(unreadOnly ? { isRead: false } : {}),
      ...(type ? { type } : hidden.length ? { type: { notIn: hidden } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

export async function getUnreadCount(plantId, userId) {
  const hidden = await disabledTypes(userId);
  return prisma.mtNotification.count({
    where: { ...visibleWhere(plantId, userId), isRead: false, ...(hidden.length ? { type: { notIn: hidden } } : {}) },
  });
}

/** Marca como leída solo si la notificación es del usuario (o de difusión). */
export async function markNotificationAsRead(notificationId, plantId, userId) {
  const notif = await prisma.mtNotification.findFirst({ where: { id: notificationId, ...visibleWhere(plantId, userId) } });
  if (!notif) return null;
  if (notif.isRead) return notif;
  return prisma.mtNotification.update({ where: { id: notificationId }, data: { isRead: true, readAt: new Date() } });
}

export async function markAllAsRead(plantId, userId) {
  const { count } = await prisma.mtNotification.updateMany({
    where: { plantId, userId, isRead: false },
    data: { isRead: true, readAt: new Date() },
  });
  return count;
}

// ============================================================
// ALERTAS PERIÓDICAS (deduplicadas por día)
// ============================================================

export async function checkLowStockAlerts(plantId, managers) {
  const parts = await getLowStockAlerts(plantId); // compara con números, suma todos los almacenes
  let sent = 0;
  for (const part of parts) {
    const out = part.totalQuantity === 0;
    const users = await notifyUsers(plantId, managers, {
      type: "LOW_STOCK",
      title: `${out ? "Sin existencia" : "Stock bajo"}: ${part.code}`,
      message: `${part.name}: ${part.totalQuantity} ${part.unit} (mínimo ${part.minStock})`,
      severity: out ? "CRITICAL" : "WARNING",
      referenceId: part.id,
      referenceType: "SPARE_PART",
      actionUrl: "/maintenance/app/inventory",
      actionLabel: "Ir a Inventario",
    });
    sent += users.length;
  }
  return sent;
}

/**
 * OTs preventivas y correctivas atrasadas (regla única de workOrders/due.js: preventivas por fecha
 * compromiso, correctivas por plazo según prioridad). Avisa a supervisores y al técnico asignado.
 */
export async function checkOverdueWorkOrders(plantId, managers) {
  const now = new Date();
  const open = await prisma.mtWorkOrder.findMany({
    where: { plantId, status: { notIn: CLOSED_STATUSES } },
    select: {
      id: true, number: true, title: true, type: true, status: true, priority: true,
      dueAt: true, scheduledAt: true, createdAt: true, assignedTo: true,
      asset: { select: { code: true } },
    },
  });

  let sent = 0;
  for (const wo of open.filter((w) => isOverdue(w, now))) {
    const days = daysOverdue(wo, now);
    const corrective = wo.type === "CORRECTIVE";
    const techUser = await technicianUserId(wo.assignedTo);
    const users = await notifyUsers(plantId, [...managers, techUser], {
      type: "OVERDUE_WO",
      title: `${corrective ? "Correctiva" : "Preventiva"} atrasada: ${woNumber(wo.number)}`,
      message: `${wo.title}${wo.asset ? ` (${wo.asset.code})` : ""} — ${days} día(s) de atraso${wo.assignedTo ? "" : " · sin técnico asignado"}`,
      severity: corrective && ["CRITICAL", "HIGH"].includes(wo.priority) ? "CRITICAL" : "WARNING",
      referenceId: wo.id,
      referenceType: "WORK_ORDER",
      actionUrl: `/maintenance/app/work-orders/${wo.id}`,
      actionLabel: "Ver orden",
    });
    sent += users.length;
  }
  return sent;
}

/** Planes cuyo ciclo ya venció y todavía no tiene OT generada (p. ej. con el scheduler apagado). */
export async function checkPlansDueWithoutOrder(plantId, managers) {
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  const plans = await prisma.mtPlan.findMany({
    where: { plantId, active: true, deletedAt: null, triggerType: "TIME", nextDueAt: { lte: endOfToday } },
    select: { id: true, code: true, title: true, nextDueAt: true, asset: { select: { code: true } } },
  });

  let sent = 0;
  for (const plan of plans) {
    const late = plan.nextDueAt < new Date(new Date().setHours(0, 0, 0, 0));
    const users = await notifyUsers(plantId, managers, {
      type: "PLAN_DUE",
      title: `${late ? "Preventivo vencido" : "Preventivo vence hoy"} sin OT: ${plan.code}`,
      message: `${plan.title} (${plan.asset?.code ?? "sin activo"}) — genera la orden en Planes`,
      severity: late ? "CRITICAL" : "WARNING",
      referenceId: plan.id,
      referenceType: "PLAN",
      actionUrl: "/maintenance/app/preventive-plans",
      actionLabel: "Ir a Planes",
    });
    sent += users.length;
  }
  return sent;
}

/** Técnicos con más de OVERLOAD_THRESHOLD órdenes abiertas de Maintenance. */
export async function checkTechnicianOverload(plantId, managers) {
  const counts = await prisma.mtWorkOrder.groupBy({
    by: ["assignedTo"],
    where: { plantId, assignedTo: { not: null }, status: { in: OPEN_WO } },
    _count: { _all: true },
  });
  const overloaded = counts.filter((c) => c._count._all > OVERLOAD_THRESHOLD);
  if (overloaded.length === 0) return 0;

  const techs = await prisma.technician.findMany({
    where: { id: { in: overloaded.map((c) => c.assignedTo) }, plantId },
    select: { id: true, name: true },
  });
  let sent = 0;
  for (const tech of techs) {
    const open = overloaded.find((c) => c.assignedTo === tech.id)._count._all;
    const users = await notifyUsers(plantId, [...managers, await technicianUserId(tech.id)], {
      type: "TECHNICIAN_OVERLOAD",
      title: `Sobrecarga: ${tech.name}`,
      message: `${tech.name} tiene ${open} órdenes abiertas (recomendado: máximo ${OVERLOAD_THRESHOLD})`,
      severity: "WARNING",
      referenceId: tech.id,
      referenceType: "TECHNICIAN",
      actionUrl: `/maintenance/app/personnel/${tech.id}`,
      actionLabel: "Ver técnico",
    });
    sent += users.length;
  }
  return sent;
}

export async function checkPreventivesSoon(plantId, managers, daysAhead = 7) {
  const plans = await prisma.mtPlan.findMany({
    where: { plantId, active: true, deletedAt: null, nextDueAt: { gte: new Date(), lte: new Date(Date.now() + daysAhead * DAY) } },
    select: { id: true, code: true, title: true, nextDueAt: true, defaultAssigneeId: true, asset: { select: { code: true, name: true } } },
  });

  let sent = 0;
  for (const plan of plans) {
    const days = Math.max(0, Math.ceil((new Date(plan.nextDueAt) - Date.now()) / DAY));
    const users = await notifyUsers(plantId, [...managers, await technicianUserId(plan.defaultAssigneeId)], {
      type: "PREVENTIVE_SOON",
      title: `Preventivo próximo: ${plan.code}`,
      message: `${plan.title} (${plan.asset?.code ?? "sin activo"}) vence ${days === 0 ? "hoy" : `en ${days} día(s)`}`,
      severity: "INFO",
      referenceId: plan.id,
      referenceType: "PLAN",
      actionUrl: "/maintenance/app/maintenance-calendar",
      actionLabel: "Ver cronograma",
    });
    sent += users.length;
  }
  return sent;
}

export async function runAllAlertChecks(plantId) {
  const managers = await managerUserIds(plantId);
  const [lowStock, overdue, overload, preventives, plansDue] = await Promise.all([
    checkLowStockAlerts(plantId, managers),
    checkOverdueWorkOrders(plantId, managers),
    checkTechnicianOverload(plantId, managers),
    checkPreventivesSoon(plantId, managers),
    checkPlansDueWithoutOrder(plantId, managers),
  ]);

  // Limpieza de notificaciones expiradas
  await prisma.mtNotification.deleteMany({ where: { plantId, expiresAt: { lt: new Date() } } });

  return {
    total: lowStock + overdue + overload + preventives + plansDue,
    alerts: { lowStock, overdue, technicianOverload: overload, preventivesSoon: preventives, plansDue },
  };
}

// ============================================================
// EVENTOS (se llaman desde órdenes de trabajo; nunca deben romper la operación)
// ============================================================

/** Falla crítica reportada: avisa a supervisores y admins. */
export async function notifyCriticalFailure(plantId, wo) {
  try {
    if (wo.type !== "CORRECTIVE" || wo.priority !== "CRITICAL") return;
    await notifyUsers(plantId, await managerUserIds(plantId), {
      type: "CRITICAL_FAILURE",
      title: `Falla crítica: ${woNumber(wo.number)}`,
      message: `${wo.title}${wo.assetName ? ` — ${wo.assetName}` : ""}`,
      severity: "CRITICAL",
      referenceId: wo.id,
      referenceType: "WORK_ORDER",
      actionUrl: `/maintenance/app/work-orders/${wo.id}`,
      actionLabel: "Revisar orden",
    }, { dedupeHours: 0 });
  } catch (err) {
    logger.error("[notifyCriticalFailure]", err);
  }
}

/** OT asignada: avisa al técnico (si tiene usuario vinculado). */
export async function notifyAssignment(plantId, wo, technicianId) {
  try {
    const userId = await technicianUserId(technicianId);
    if (!userId) return;
    await notifyUsers(plantId, [userId], {
      type: "WO_ASSIGNED",
      title: `Nueva orden asignada: ${woNumber(wo.number)}`,
      message: wo.title,
      severity: wo.priority === "CRITICAL" ? "CRITICAL" : "INFO",
      referenceId: wo.id,
      referenceType: "WORK_ORDER",
      actionUrl: `/maintenance/app/work-orders/${wo.id}`,
      actionLabel: "Ver orden",
    }, { dedupeHours: 0 });
  } catch (err) {
    logger.error("[notifyAssignment]", err);
  }
}

// ============================================================
// PREFERENCIAS
// ============================================================

export async function getOrCreatePreferences(userId, plantId) {
  try {
    return await prisma.mtNotificationPreference.upsert({
      where: { userId },
      update: {},
      create: { userId, plantId },
    });
  } catch (err) {
    // Dos peticiones simultáneas pueden intentar crearlas a la vez: la segunda solo las lee
    if (err.code === "P2002") return prisma.mtNotificationPreference.findUnique({ where: { userId } });
    throw err;
  }
}

/** Solo acepta los interruptores conocidos (booleanos); ignora cualquier otro campo del body. */
export async function updatePreferences(userId, plantId, data) {
  const clean = {};
  for (const field of PREFERENCE_FIELDS) {
    if (typeof data?.[field] === "boolean") clean[field] = data[field];
  }
  await getOrCreatePreferences(userId, plantId);
  return prisma.mtNotificationPreference.update({ where: { userId }, data: clean });
}

// ============================================================
// CICLO AUTOMÁTICO DE ALERTAS
// ============================================================

let alertsInterval = null;

/**
 * Revisa las alertas de todas las plantas con Maintenance habilitado cada N minutos.
 * Es independiente del scheduler de OTs (solo lee y crea notificaciones deduplicadas por día).
 * Se desactiva con MAINTENANCE_ALERTS_ENABLED=false.
 */
export function startMaintenanceAlerts() {
  if (process.env.MAINTENANCE_ALERTS_ENABLED === "false") {
    logger.info("[Maintenance Alerts] Disabled (MAINTENANCE_ALERTS_ENABLED=false)");
    return;
  }
  const intervalMs = (parseInt(process.env.MAINTENANCE_ALERTS_INTERVAL_MIN || "15", 10) || 15) * 60 * 1000;
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      const access = await prisma.mtPlantAccess.findMany({ where: { enabled: true }, select: { plantId: true } });
      for (const { plantId } of access) {
        try {
          const r = await runAllAlertChecks(plantId);
          if (r.total) logger.info(`[Maintenance Alerts] Plant ${plantId}: ${r.total} notification(s)`, r.alerts);
        } catch (err) {
          logger.error(`[Maintenance Alerts] Plant ${plantId} failed`, err);
        }
      }
    } catch (err) {
      logger.error("[Maintenance Alerts] Unexpected error", err);
    } finally {
      running = false;
    }
  };

  setTimeout(run, 20 * 1000);
  alertsInterval = setInterval(run, intervalMs);
  logger.info("[Maintenance Alerts] Started", { intervalMs });
}

export function stopMaintenanceAlerts() {
  if (alertsInterval) clearInterval(alertsInterval);
  alertsInterval = null;
}
