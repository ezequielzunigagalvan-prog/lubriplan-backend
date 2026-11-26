// src/routes/plantsOverview.routes.js
// Dashboard multiplanta: cómo va cada planta, de un vistazo.
//  - ADMIN ve todas las plantas activas; SUPERVISOR solo las que tiene asignadas (UserPlant).
//  - Todas las fechas se calculan con la zona horaria de cada planta.
//  - Definiciones (las mismas para todas las plantas, para poder compararlas):
//      atrasadas      = actividades abiertas con fecha anterior a hoy
//      hoy            = actividades abiertas programadas para hoy
//      sin técnico    = actividades abiertas sin técnico asignado
//      cumplimiento   = del mes elegido, actividades programadas hasta hoy que ya están completadas
//      a tiempo       = de esas completadas, las hechas a más tardar el día programado
import express from "express";
import { logger } from "../config/logger.js";
import { logAudit } from "../services/audit.service.js";
import { safeTimeZone, zonedStartOfDay, zonedEndOfDay, zonedMonthRange, zonedYmd } from "../utils/tzRange.js";

const OPEN = ["PENDING", "OVERDUE"];
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

/** Semáforo de la planta a partir de sus indicadores. */
export function plantHealth(m) {
  const reasons = [];
  if (m.overdue > 0) reasons.push(`${m.overdue} atrasada${m.overdue === 1 ? "" : "s"}`);
  if (m.criticalReports > 0) reasons.push(`${m.criticalReports} reporte${m.criticalReports === 1 ? "" : "s"} crítico${m.criticalReports === 1 ? "" : "s"}`);
  if (m.compliance != null && m.compliance < 80) reasons.push(`cumplimiento ${m.compliance}%`);
  if (m.lowStock > 0) reasons.push(`${m.lowStock} lubricante${m.lowStock === 1 ? "" : "s"} en mínimo`);
  if (m.unassigned > 0) reasons.push(`${m.unassigned} sin técnico`);

  let level = "ok";
  if (m.criticalReports > 0 || (m.compliance != null && m.compliance < 70) || m.overdue >= 10) level = "critical";
  else if (m.overdue > 0 || m.lowStock > 0 || m.unassigned > 0 || (m.compliance != null && m.compliance < 90)) level = "warning";

  // Puntaje 0–100 para ordenar y comparar plantas.
  let score = m.compliance ?? 100;
  score -= Math.min(30, m.overdue * 3);
  score -= Math.min(20, m.criticalReports * 10);
  score -= Math.min(10, m.lowStock * 2);
  score -= Math.min(10, m.unassigned);
  score = Math.max(0, Math.round(score));
  return { level, score, reasons };
}

async function plantsForUser(prisma, user) {
  const role = String(user?.role || "").toUpperCase();
  if (role === "ADMIN") {
    return prisma.plant.findMany({ where: { active: true }, select: { id: true, name: true, timezone: true }, orderBy: { name: "asc" } });
  }
  const links = await prisma.userPlant.findMany({
    where: { userId: user.id, active: true, plant: { active: true } },
    select: { plant: { select: { id: true, name: true, timezone: true } } },
  });
  return links.map((l) => l.plant).sort((a, b) => a.name.localeCompare(b.name));
}

async function plantMetrics(prisma, plant, ym) {
  const tz = safeTimeZone(plant.timezone);
  const now = new Date();
  const today = zonedYmd(now, tz);
  const todayStart = zonedStartOfDay(today, tz);
  const todayEnd = zonedEndOfDay(today, tz);
  const month = zonedMonthRange(ym, tz) || zonedMonthRange(today.slice(0, 7), tz);
  const dueUntil = todayEnd < month.to ? todayEnd : month.to;
  const plantId = plant.id;
  const trendFrom = zonedStartOfDay(zonedYmd(new Date(now.getTime() - 13 * 86400000), tz), tz);

  const [
    equipments, routes, technicians, overdue, todayOpen, unassigned, next7,
    dueRows, criticalReports, openReports, lubricants, lastDone, trendRows,
  ] = await Promise.all([
    prisma.equipment.count({ where: { plantId, NOT: { status: { equals: "INACTIVO", mode: "insensitive" } } } }),
    prisma.route.count({ where: { plantId, isEmergency: false } }),
    prisma.technician.count({ where: { plantId, deletedAt: null, status: { in: ["Activo", "ACTIVO", "Active", "ACTIVE", "activo"] } } }),
    prisma.execution.count({ where: { plantId, status: { in: OPEN }, scheduledAt: { lt: todayStart } } }),
    prisma.execution.count({ where: { plantId, status: { in: OPEN }, scheduledAt: { gte: todayStart, lte: todayEnd } } }),
    prisma.execution.count({ where: { plantId, status: { in: OPEN }, technicianId: null } }),
    prisma.execution.count({ where: { plantId, status: { in: OPEN }, scheduledAt: { gt: todayEnd, lte: new Date(todayEnd.getTime() + 7 * 86400000) } } }),
    prisma.execution.findMany({
      where: { plantId, scheduledAt: { gte: month.from, lte: dueUntil } },
      select: { status: true, scheduledAt: true, executedAt: true },
    }),
    prisma.conditionReport.count({ where: { plantId, status: { in: ["OPEN", "IN_PROGRESS"] }, condition: "CRITICO" } }),
    prisma.conditionReport.count({ where: { plantId, status: { in: ["OPEN", "IN_PROGRESS"] } } }),
    prisma.lubricant.findMany({ where: { plantId }, select: { stock: true, minStock: true } }),
    prisma.execution.findFirst({ where: { plantId, status: "COMPLETED", executedAt: { not: null } }, orderBy: { executedAt: "desc" }, select: { executedAt: true } }),
    prisma.execution.findMany({
      where: { plantId, status: "COMPLETED", executedAt: { gte: trendFrom, lte: todayEnd } },
      select: { executedAt: true },
    }),
  ]);

  const due = dueRows.length;
  const done = dueRows.filter((r) => r.status === "COMPLETED");
  const onTime = done.filter((r) => r.executedAt && zonedYmd(r.executedAt, tz) <= zonedYmd(r.scheduledAt, tz)).length;
  const lowStock = lubricants.filter((l) => l.minStock != null && Number(l.stock) <= Number(l.minStock)).length;

  const trend = [];
  for (let i = 13; i >= 0; i--) {
    const day = zonedYmd(new Date(now.getTime() - i * 86400000), tz);
    trend.push({ day, done: trendRows.filter((r) => zonedYmd(r.executedAt, tz) === day).length });
  }

  const metrics = {
    equipments,
    routes,
    technicians,
    overdue,
    today: todayOpen,
    unassigned,
    next7,
    dueThisMonth: due,
    doneThisMonth: done.length,
    compliance: pct(done.length, due),
    onTimeRate: pct(onTime, done.length),
    criticalReports,
    openReports,
    lowStock,
    lastActivityAt: lastDone?.executedAt || null,
    trend,
  };
  return { id: plant.id, name: plant.name, timezone: tz, today, ...metrics, health: plantHealth(metrics) };
}

export default function plantsOverviewRoutes({ prisma, auth, requireRole }) {
  const router = express.Router();

  router.get("/dashboard/plants-overview", auth, requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
    try {
      const ymRaw = String(req.query.month || "");
      const onlyId = Number(req.query.plantId) || null;
      const plants = (await plantsForUser(prisma, req.user)).filter((p) => !onlyId || p.id === onlyId);
      const ym = /^\d{4}-\d{2}$/.test(ymRaw) ? ymRaw : zonedYmd(new Date(), safeTimeZone(plants[0]?.timezone)).slice(0, 7);
      const items = [];
      for (const p of plants) items.push(await plantMetrics(prisma, p, ym));
      const mine = new Set(
        (await prisma.userPlant.findMany({ where: { userId: req.user.id, active: true }, select: { plantId: true } })).map((m) => m.plantId)
      );
      items.forEach((i) => (i.hasAccess = mine.has(i.id)));

      const sum = (k) => items.reduce((n, i) => n + (Number(i[k]) || 0), 0);
      const due = sum("dueThisMonth");
      return res.json({
        ok: true,
        month: ym,
        generatedAt: new Date().toISOString(),
        totals: {
          plants: items.length,
          overdue: sum("overdue"),
          today: sum("today"),
          unassigned: sum("unassigned"),
          criticalReports: sum("criticalReports"),
          lowStock: sum("lowStock"),
          equipments: sum("equipments"),
          technicians: sum("technicians"),
          dueThisMonth: due,
          doneThisMonth: sum("doneThisMonth"),
          compliance: pct(sum("doneThisMonth"), due),
          attention: items.filter((i) => i.health.level !== "ok").length,
        },
        items,
      });
    } catch (e) {
      logger.error("GET /dashboard/plants-overview", e);
      return res.status(500).json({ error: "No se pudo cargar el resumen de plantas" });
    }
  });

  // ADMIN abre una planta en la que aún no está dado de alta: se le da acceso (queda en auditoría).
  router.post("/dashboard/plants/:id/enter", auth, requireRole(["ADMIN"]), async (req, res) => {
    try {
      const plantId = Number(req.params.id);
      const plant = await prisma.plant.findFirst({ where: { id: plantId, active: true }, select: { id: true, name: true } });
      if (!plant) return res.status(404).json({ error: "Planta no encontrada" });
      const link = await prisma.userPlant.findFirst({ where: { userId: req.user.id, plantId }, select: { id: true, active: true } });
      if (link?.active) return res.json({ ok: true, granted: false });
      if (link) await prisma.userPlant.update({ where: { id: link.id }, data: { active: true } });
      else await prisma.userPlant.create({ data: { userId: req.user.id, plantId, active: true, isDefault: false } });
      logAudit({ plantId, userId: req.user.id, action: "CREATE", model: "UserPlant", recordId: `${req.user.id}:${plantId}`, changes: { after: { access: true, via: "plants-overview" } }, ip: req.ip });
      return res.json({ ok: true, granted: true });
    } catch (e) {
      logger.error("POST /dashboard/plants/:id/enter", e);
      return res.status(500).json({ error: "No se pudo abrir la planta" });
    }
  });

  return router;
}
