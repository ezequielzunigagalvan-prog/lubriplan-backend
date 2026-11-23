// src/jobs/overdueReminder.job.js
// Recordatorio diario DENTRO del sistema (campana) de actividades vencidas.
//  - Técnico: "Tienes N actividades vencidas" (solo las suyas).
//  - Supervisor / Admin de la planta: total de vencidas, cuántas críticas y cuántas sin técnico.
// Una sola vez por usuario, planta y día (hora local de la planta), a partir de REMINDER_HOUR.
// No requiere cambios de base de datos: el control de "ya enviado hoy" es la propia notificación.

import { logger } from "../config/logger.js";
import { notifyUser } from "../notifications/notify.js";
import { safeTimeZone, zonedStartOfDay, zonedYmd } from "../utils/tzRange.js";

const REMINDER_HOUR = Number(process.env.OVERDUE_REMINDER_HOUR || 7);
const OPEN = ["PENDING", "OVERDUE"];
// Equipos registrados antes de normalizar la criticidad pueden traerla en minúsculas o con acento.
const HIGH_CRIT = ["ALTA", "CRITICA", "CRÍTICA", "Alta", "Critica", "Crítica", "alta", "critica", "crítica"];

function localHour(now, tz) {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(now);
  return Number(h);
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function technicianMessage({ overdue, today }) {
  const parts = [plural(overdue, "actividad vencida", "actividades vencidas")];
  if (today) parts.push(`${today} para hoy`);
  return `${parts.join(" · ")}. ${overdue === 1 ? "Complétala" : "Complétalas"} o avisa a tu supervisor si no se pueden hacer.`;
}

export function managerMessage({ overdue, critical, unassigned }) {
  const parts = [plural(overdue, "actividad vencida", "actividades vencidas")];
  if (critical) parts.push(`${critical} en equipos críticos`);
  if (unassigned) parts.push(`${unassigned} sin técnico`);
  return parts.join(" · ");
}

async function alreadyNotified(prisma, { userId, plantId, since }) {
  const found = await prisma.notification.findFirst({
    where: { userId, plantId, type: "EXEC_OVERDUE", createdAt: { gte: since } },
    select: { id: true },
  });
  return Boolean(found);
}

export async function runOverdueReminders({ prisma, now = new Date(), hour = REMINDER_HOUR } = {}) {
  const plants = await prisma.plant.findMany({ select: { id: true, name: true, timezone: true } });
  const results = [];

  for (const plant of plants) {
    const tz = safeTimeZone(plant.timezone);
    if (localHour(now, tz) < hour) {
      results.push({ plantId: plant.id, skipped: "BEFORE_WINDOW" });
      continue;
    }

    const ymd = zonedYmd(now, tz);
    const dayStart = zonedStartOfDay(ymd, tz);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000 - 1);
    const overdueWhere = { plantId: plant.id, status: { in: OPEN }, scheduledAt: { lt: dayStart } };

    const [byTech, todayByTech, critical, unassigned] = await Promise.all([
      prisma.execution.groupBy({ by: ["technicianId"], where: overdueWhere, _count: { _all: true } }),
      prisma.execution.groupBy({
        by: ["technicianId"],
        where: { plantId: plant.id, status: { in: OPEN }, scheduledAt: { gte: dayStart, lte: dayEnd } },
        _count: { _all: true },
      }),
      prisma.execution.count({
        where: {
          ...overdueWhere,
          OR: [
            { equipment: { is: { criticality: { in: HIGH_CRIT } } } },
            { route: { is: { equipment: { is: { criticality: { in: HIGH_CRIT } } } } } },
          ],
        },
      }),
      prisma.execution.count({ where: { ...overdueWhere, technicianId: null } }),
    ]);

    const totalOverdue = byTech.reduce((s, r) => s + r._count._all, 0);
    let sent = 0;

    // Técnicos con vencidas
    const techCounts = new Map(byTech.filter((r) => r.technicianId != null).map((r) => [r.technicianId, r._count._all]));
    const todayCounts = new Map(todayByTech.filter((r) => r.technicianId != null).map((r) => [r.technicianId, r._count._all]));
    if (techCounts.size) {
      const users = await prisma.user.findMany({
        where: { active: true, role: "TECHNICIAN", technicianId: { in: [...techCounts.keys()] } },
        select: { id: true, technicianId: true },
      });
      for (const u of users) {
        if (await alreadyNotified(prisma, { userId: u.id, plantId: plant.id, since: dayStart })) continue;
        const overdue = techCounts.get(u.technicianId) || 0;
        await notifyUser(prisma, u.id, {
          plantId: plant.id,
          type: "EXEC_OVERDUE",
          title: overdue === 1 ? "Tienes 1 actividad vencida" : `Tienes ${overdue} actividades vencidas`,
          message: technicianMessage({ overdue, today: todayCounts.get(u.technicianId) || 0 }),
          link: "/activities?filter=overdue",
        });
        sent++;
      }
    }

    // Supervisores y administradores de la planta
    if (totalOverdue > 0) {
      const managers = await prisma.user.findMany({
        where: {
          active: true,
          role: { in: ["ADMIN", "SUPERVISOR"] },
          userPlants: { some: { plantId: plant.id, active: true } },
        },
        select: { id: true },
      });
      for (const m of managers) {
        if (await alreadyNotified(prisma, { userId: m.id, plantId: plant.id, since: dayStart })) continue;
        await notifyUser(prisma, m.id, {
          plantId: plant.id,
          type: "EXEC_OVERDUE",
          title: `Actividades vencidas en ${plant.name}`,
          message: managerMessage({ overdue: totalOverdue, critical, unassigned }),
          link: "/activities?filter=overdue",
        });
        sent++;
      }
    }

    results.push({ plantId: plant.id, totalOverdue, sent });
  }

  return results;
}

export function startOverdueReminderScheduler({ prisma }) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const results = await runOverdueReminders({ prisma });
      const sent = results.reduce((s, r) => s + (r.sent || 0), 0);
      if (sent) logger.info("🔔 overdueReminder:", { sent, results });
    } catch (e) {
      logger.error("❌ overdueReminder:", e);
    } finally {
      running = false;
    }
  };
  setTimeout(run, 45_000);
  const interval = setInterval(run, 15 * 60 * 1000);
  logger.info(`✅ Recordatorio de vencidas en la campana iniciado (desde las ${REMINDER_HOUR}:00 hora de planta)`);
  return interval;
}
