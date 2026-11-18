import express from "express";
import prisma from "../../../prisma.js";
import { logger } from "../../../config/logger.js";
import { buildCycleKey, startOfLocalDay } from "../scheduler/dates.js";
import { computeNextDueAt, nextCycleAfter, isTimeSchedulable } from "../plans/schedule.js";

const router = express.Router();

const CLOSED = ["FINISHED", "VALIDATED", "REJECTED", "CANCELLED"];
const MAX_ITEMS = 1500;
const DAILY_CAPACITY_MIN = 8 * 60; // jornada de referencia para detectar sobrecarga
const DAY_MS = 24 * 60 * 60 * 1000;

const dayKey = (date) => {
  // Día local de la planta (YYYY-MM-DD) a partir de la medianoche local en UTC
  const d = startOfLocalDay(date);
  return new Date(d.getTime() + 12 * 60 * 60 * 1000).toISOString().slice(0, 10);
};

/** Ciclos futuros de un plan dentro de [from, to] (sin los que ya tienen OT). */
function projectPlan(plan, { from, to, today, existingKeys }) {
  if (!isTimeSchedulable(plan)) return [];
  let due = plan.nextDueAt ? new Date(plan.nextDueAt) : computeNextDueAt(plan, today);
  if (!due) return [];

  const cycles = [];
  // FLOATING: solo el siguiente ciclo es seguro (los demás dependen de cuándo se termine)
  const maxCycles = plan.scheduleMode === "FLOATING" ? 1 : 400;
  for (let i = 0; i < maxCycles && due <= to; i++) {
    if (due >= from && due >= today && !existingKeys.has(`${plan.id}|${buildCycleKey(plan, due, "TIME")}`)) {
      cycles.push(new Date(due));
    }
    due = nextCycleAfter(plan, due);
  }
  return cycles;
}

async function technicianNames(plantId, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const techs = await prisma.technician.findMany({ where: { id: { in: unique }, plantId }, select: { id: true, name: true } });
  return new Map(techs.map((t) => [t.id, t.name]));
}

/**
 * Calendario de la planta en [from, to]: OTs programadas (por scheduledAt o, si no tiene, dueAt)
 * y ciclos proyectados de los planes preventivos. Incluye carga por técnico y día.
 */
async function buildCalendar(plantId, { from, to, technicianId }) {
  const today = startOfLocalDay(new Date());

  const [orders, plans] = await Promise.all([
    prisma.mtWorkOrder.findMany({
      where: {
        plantId,
        ...(technicianId ? { assignedTo: technicianId } : {}),
        OR: [{ scheduledAt: { gte: from, lte: to } }, { scheduledAt: null, dueAt: { gte: from, lte: to } }],
      },
      select: {
        id: true, number: true, title: true, type: true, status: true, priority: true,
        scheduledAt: true, dueAt: true, assignedTo: true, planId: true, cycleKey: true,
        asset: { select: { id: true, code: true, name: true } },
      },
      orderBy: { scheduledAt: "asc" },
      take: MAX_ITEMS,
    }),
    prisma.mtPlan.findMany({
      where: {
        plantId, active: true, deletedAt: null, triggerType: "TIME",
        ...(technicianId ? { defaultAssigneeId: technicianId } : {}),
      },
      select: {
        id: true, code: true, title: true, type: true, priority: true, anchorDate: true, frequencyUnit: true, frequencyEvery: true,
        scheduleMode: true, triggerType: true, nextDueAt: true, lastCompletedAt: true, leadDays: true, defaultAssigneeId: true, estimatedMinutes: true,
        asset: { select: { id: true, code: true, name: true } },
      },
    }),
  ]);

  // Ciclos que ya tienen OT (en cualquier fecha) para no proyectarlos dos veces
  const planIds = plans.map((p) => p.id);
  const generated = planIds.length
    ? await prisma.mtWorkOrder.findMany({
        where: { plantId, planId: { in: planIds }, cycleKey: { startsWith: "T:" } },
        select: { planId: true, cycleKey: true },
      })
    : [];
  const existingKeys = new Set(generated.map((w) => `${w.planId}|${w.cycleKey}`));
  const planById = new Map(plans.map((p) => [p.id, p]));

  const names = await technicianNames(plantId, [...orders.map((o) => o.assignedTo), ...plans.map((p) => p.defaultAssigneeId)]);

  const items = orders.map((wo) => {
    const date = wo.scheduledAt || wo.dueAt;
    return {
      id: `wo-${wo.id}`,
      kind: "WORK_ORDER",
      workOrderId: wo.id,
      number: wo.number,
      title: wo.title,
      type: wo.type,
      status: wo.status,
      priority: wo.priority,
      date,
      day: dayKey(date),
      overdue: !CLOSED.includes(wo.status) && date < today,
      asset: wo.asset,
      technicianId: wo.assignedTo,
      technician: wo.assignedTo ? names.get(wo.assignedTo) || null : null,
      estimatedMinutes: wo.planId ? planById.get(wo.planId)?.estimatedMinutes ?? null : null,
      planCode: wo.planId ? planById.get(wo.planId)?.code ?? null : null,
    };
  });

  for (const plan of plans) {
    for (const due of projectPlan(plan, { from, to, today, existingKeys })) {
      if (items.length >= MAX_ITEMS) break;
      items.push({
        id: `plan-${plan.id}-${due.getTime()}`,
        kind: "PROJECTED",
        planId: plan.id,
        planCode: plan.code,
        title: plan.title,
        type: plan.type,
        status: null,
        priority: plan.priority,
        date: due,
        day: dayKey(due),
        overdue: false,
        tentative: plan.scheduleMode === "FLOATING",
        asset: plan.asset,
        technicianId: plan.defaultAssigneeId,
        technician: plan.defaultAssigneeId ? names.get(plan.defaultAssigneeId) || null : null,
        estimatedMinutes: plan.estimatedMinutes ?? null,
      });
    }
  }

  items.sort((a, b) => new Date(a.date) - new Date(b.date));

  // Carga por técnico y día (solo trabajo pendiente: no cuenta lo cerrado)
  const loadMap = new Map();
  for (const item of items) {
    if (!item.technicianId || (item.status && CLOSED.includes(item.status))) continue;
    const key = `${item.technicianId}|${item.day}`;
    const entry = loadMap.get(key) || { technicianId: item.technicianId, technician: item.technician, day: item.day, items: 0, minutes: 0, withoutEstimate: 0 };
    entry.items++;
    if (item.estimatedMinutes) entry.minutes += item.estimatedMinutes;
    else entry.withoutEstimate++;
    loadMap.set(key, entry);
  }
  const load = [...loadMap.values()].map((l) => ({ ...l, overloaded: l.minutes > DAILY_CAPACITY_MIN }));

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    items,
    load,
    conflicts: load.filter((l) => l.overloaded),
    truncated: items.length >= MAX_ITEMS,
  };
}

// GET /api/maintenance/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD[&technicianId=]
router.get("/", async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
      return res.status(400).json({ error: "from and to query parameters (YYYY-MM-DD) are required" });
    }
    const fromDate = startOfLocalDay(new Date(`${String(from).slice(0, 10)}T12:00:00Z`));
    const toDate = new Date(startOfLocalDay(new Date(`${String(to).slice(0, 10)}T12:00:00Z`)).getTime() + DAY_MS - 1);
    if (toDate < fromDate) return res.status(400).json({ error: "to must be after from" });
    if (toDate - fromDate > 400 * DAY_MS) return res.status(400).json({ error: "Range too large (max 400 days)" });

    const technicianId = parseInt(req.query.technicianId, 10) || undefined;
    const data = await buildCalendar(req.currentPlantId, { from: fromDate, to: toDate, technicianId });
    return res.json({ data });
  } catch (err) {
    logger.error("[calendar GET]", err);
    return res.status(500).json({ error: "Error fetching calendar" });
  }
});

// GET /api/maintenance/calendar/preventive?days=30
// Cronograma de preventivos: lo vencido (OTs preventivas abiertas atrasadas) y lo próximo (OTs y ciclos proyectados).
router.get("/preventive", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
    const today = startOfLocalDay(new Date());
    const until = new Date(today.getTime() + days * DAY_MS - 1);

    const [calendar, overdueOrders, plans] = await Promise.all([
      buildCalendar(plantId, { from: today, to: until }),
      prisma.mtWorkOrder.findMany({
        where: {
          plantId,
          type: { not: "CORRECTIVE" },
          status: { notIn: CLOSED },
          OR: [{ dueAt: { lt: today } }, { dueAt: null, scheduledAt: { lt: today } }],
        },
        select: {
          id: true, number: true, title: true, status: true, priority: true, dueAt: true, scheduledAt: true, assignedTo: true, planId: true,
          asset: { select: { id: true, code: true, name: true } },
        },
        orderBy: { dueAt: "asc" },
      }),
      prisma.mtPlan.findMany({
        where: { plantId, deletedAt: null },
        select: { id: true, active: true, triggerType: true, frequencyUnit: true, frequencyEvery: true },
      }),
    ]);

    const names = await technicianNames(plantId, overdueOrders.map((o) => o.assignedTo));
    const overdue = overdueOrders.map((wo) => {
      const due = wo.dueAt || wo.scheduledAt;
      return {
        id: `wo-${wo.id}`,
        kind: "WORK_ORDER",
        workOrderId: wo.id,
        number: wo.number,
        title: wo.title,
        status: wo.status,
        priority: wo.priority,
        date: due,
        daysOverdue: Math.floor((today - startOfLocalDay(due)) / DAY_MS),
        asset: wo.asset,
        technician: wo.assignedTo ? names.get(wo.assignedTo) || null : null,
      };
    });

    const upcoming = calendar.items.filter((i) => i.type !== "CORRECTIVE" && !(i.status && CLOSED.includes(i.status)));
    const in7 = new Date(today.getTime() + 7 * DAY_MS);

    return res.json({
      data: {
        days,
        overdue,
        upcoming,
        stats: {
          overdue: overdue.length,
          next7Days: upcoming.filter((i) => new Date(i.date) < in7).length,
          nextPeriod: upcoming.length,
          activePlans: plans.filter((p) => p.active).length,
          pausedPlans: plans.filter((p) => !p.active).length,
          meterPlans: plans.filter((p) => p.active && p.triggerType === "METER").length,
        },
      },
    });
  } catch (err) {
    logger.error("[calendar/preventive GET]", err);
    return res.status(500).json({ error: "Error fetching preventive schedule" });
  }
});

export default router;
