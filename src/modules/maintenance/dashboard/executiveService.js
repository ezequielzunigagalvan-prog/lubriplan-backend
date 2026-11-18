import prisma from "../../../prisma.js";

// Estados que se consideran "cerrados" (ya no son trabajo pendiente)
const CLOSED_STATUSES = ["FINISHED", "VALIDATED", "REJECTED", "CANCELLED"];
const DONE_STATUSES = ["FINISHED", "VALIDATED"];
// Pendientes que todavía no se empiezan a ejecutar
const NOT_STARTED_STATUSES = ["REQUESTED", "APPROVED", "ASSIGNED", "WAITING_PARTS", "WAITING_PRODUCTION"];

const MONTH_LABELS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const HOUR_MS = 1000 * 60 * 60;

const round = (n, d = 1) => (n == null || !Number.isFinite(n) ? null : Number(n.toFixed(d)));

/** Fecha compromiso de una OT: dueAt si existe, si no scheduledAt. */
const dueDateOf = (wo) => wo.dueAt || wo.scheduledAt || null;

/** Minutos de paro de una OT: el valor capturado, o la duración de ejecución si no se capturó. */
function downtimeMinutesOf(wo) {
  if (wo.downtimeMinutes != null) return wo.downtimeMinutes;
  if (wo.startedAt && wo.finishedAt) return Math.max(0, (wo.finishedAt - wo.startedAt) / 60000);
  return 0;
}

/** Costo de refacciones consumidas en una OT. */
const partsCostOf = (wo) =>
  (wo.parts || []).reduce((sum, p) => sum + Number(p.quantity) * Number(p.costPerUnitAtTime), 0);

/** % de OTs preventivas con fecha compromiso en el periodo que se terminaron a tiempo. */
function complianceOf(preventives) {
  if (preventives.length === 0) return null;
  const onTime = preventives.filter((wo) => {
    const due = dueDateOf(wo);
    return wo.finishedAt && DONE_STATUSES.includes(wo.status) && wo.finishedAt <= endOfDay(due);
  }).length;
  return round((onTime / preventives.length) * 100, 0);
}

function endOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

function topBy(map, limit) {
  return [...map.values()].sort((a, b) => b.value - a.value).slice(0, limit);
}

/**
 * Indicadores del dashboard ejecutivo para una planta.
 * Todo se calcula con datos reales; cuando no hay datos suficientes el valor es null
 * (el frontend lo muestra como "Sin datos" en lugar de inventar un número).
 */
export async function getExecutiveDashboard({ plantId, userId, days = 30 }) {
  const now = new Date();
  const periodStart = new Date(now.getTime() - days * 24 * HOUR_MS);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const trendStart = new Date(now.getFullYear(), now.getMonth() - 5, 1); // últimos 6 meses

  const [openOrders, finishedSinceTrend, preventivesDue, activeAssets, plans, memberships] = await Promise.all([
    prisma.mtWorkOrder.findMany({
      where: { plantId, status: { notIn: CLOSED_STATUSES } },
      select: { id: true, type: true, status: true, dueAt: true, scheduledAt: true, assignedTo: true },
    }),
    prisma.mtWorkOrder.findMany({
      where: { plantId, status: { in: DONE_STATUSES }, finishedAt: { gte: trendStart } },
      select: {
        id: true,
        type: true,
        assetId: true,
        startedAt: true,
        finishedAt: true,
        downtimeMinutes: true,
        asset: { select: { code: true, name: true } },
        parts: { select: { quantity: true, costPerUnitAtTime: true } },
      },
    }),
    prisma.mtWorkOrder.findMany({
      where: {
        plantId,
        type: { not: "CORRECTIVE" },
        status: { notIn: ["REJECTED", "CANCELLED"] },
        OR: [
          { dueAt: { gte: periodStart, lte: now } },
          { dueAt: null, scheduledAt: { gte: periodStart, lte: now } },
        ],
      },
      select: { id: true, planId: true, status: true, dueAt: true, scheduledAt: true, finishedAt: true },
    }),
    prisma.mtAsset.count({ where: { plantId, deletedAt: null } }),
    prisma.mtPlan.findMany({
      where: { plantId, deletedAt: null },
      select: { id: true, code: true, title: true },
    }),
    userId
      ? prisma.userPlant.findMany({
          where: { userId, active: true },
          select: { plantId: true, plant: { select: { name: true, active: true } } },
        })
      : [],
  ]);

  // ---------- Órdenes ----------
  const overdueOrders = openOrders.filter((wo) => {
    const due = dueDateOf(wo);
    return due && due < now;
  }).length;
  const correctivePending = openOrders.filter((wo) => wo.type === "CORRECTIVE").length;
  const preventivePending = openOrders.length - correctivePending;
  const backlog = openOrders.filter((wo) => NOT_STARTED_STATUSES.includes(wo.status)).length;

  const finishedInPeriod = finishedSinceTrend.filter((wo) => wo.finishedAt >= periodStart);
  const correctivesInPeriod = finishedInPeriod.filter((wo) => wo.type === "CORRECTIVE");

  // ---------- Confiabilidad ----------
  const repairs = correctivesInPeriod.filter((wo) => wo.startedAt && wo.finishedAt);
  const mttr = repairs.length
    ? repairs.reduce((s, wo) => s + (wo.finishedAt - wo.startedAt) / HOUR_MS, 0) / repairs.length
    : null;

  const downtimeHours = correctivesInPeriod.reduce((s, wo) => s + downtimeMinutesOf(wo), 0) / 60;
  const calendarHours = activeAssets * days * 24;
  const availability = calendarHours > 0 ? ((calendarHours - downtimeHours) / calendarHours) * 100 : null;
  const mtbf = correctivesInPeriod.length > 0 ? (calendarHours - downtimeHours) / correctivesInPeriod.length : null;

  // ---------- Costos (refacciones consumidas en OTs terminadas) ----------
  const monthly = new Map();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthly.set(`${d.getFullYear()}-${d.getMonth()}`, { month: MONTH_LABELS[d.getMonth()], year: d.getFullYear(), cost: 0 });
  }
  for (const wo of finishedSinceTrend) {
    const key = `${wo.finishedAt.getFullYear()}-${wo.finishedAt.getMonth()}`;
    if (monthly.has(key)) monthly.get(key).cost += partsCostOf(wo);
  }
  const monthlyCosts = [...monthly.values()].map((m) => ({ ...m, cost: round(m.cost, 2) }));
  const currentMonthCost = monthlyCosts[monthlyCosts.length - 1].cost;
  const prevMonthCost = monthlyCosts[monthlyCosts.length - 2].cost;
  const costsTrend = prevMonthCost > 0 ? round(((currentMonthCost - prevMonthCost) / prevMonthCost) * 100, 0) : null;

  // ---------- Por equipo ----------
  const failures = new Map();
  const downtime = new Map();
  for (const wo of correctivesInPeriod) {
    if (!wo.assetId) continue;
    const label = wo.asset ? `${wo.asset.code} · ${wo.asset.name}` : `Activo ${wo.assetId}`;
    const f = failures.get(wo.assetId) || { assetId: wo.assetId, equipment: label, value: 0 };
    f.value += 1;
    failures.set(wo.assetId, f);
    const d = downtime.get(wo.assetId) || { assetId: wo.assetId, equipment: label, value: 0 };
    d.value += downtimeMinutesOf(wo) / 60;
    downtime.set(wo.assetId, d);
  }
  const failuresByEquipment = topBy(failures, 5).map(({ value, ...r }) => ({ ...r, failures: value }));
  const equipmentDowntime = topBy(downtime, 5)
    .filter((r) => r.value > 0)
    .map(({ value, ...r }) => ({ ...r, hours: round(value, 1) }));

  // ---------- Cumplimiento preventivo ----------
  const preventiveCompliance = complianceOf(preventivesDue);
  const planById = new Map(plans.map((p) => [p.id, p]));
  const byPlan = new Map();
  for (const wo of preventivesDue) {
    if (!wo.planId || !planById.has(wo.planId)) continue;
    if (!byPlan.has(wo.planId)) byPlan.set(wo.planId, []);
    byPlan.get(wo.planId).push(wo);
  }
  const maintenanceCompliance = [...byPlan.entries()]
    .map(([planId, wos]) => {
      const p = planById.get(planId);
      return { planId, plan: `${p.code} · ${p.title}`, orders: wos.length, compliance: complianceOf(wos) };
    })
    .sort((a, b) => a.compliance - b.compliance) // los peores primero: son los que requieren atención
    .slice(0, 6);

  // ---------- Por especialidad (OTs abiertas) ----------
  const assigneeIds = [...new Set(openOrders.map((wo) => wo.assignedTo).filter(Boolean))];
  const specialtyByAssignee = await resolveSpecialties(plantId, assigneeIds);
  const specialtyCounts = new Map();
  for (const wo of openOrders) {
    const specialty = wo.assignedTo ? specialtyByAssignee.get(wo.assignedTo) || "Sin especialidad" : "Sin asignar";
    specialtyCounts.set(specialty, (specialtyCounts.get(specialty) || 0) + 1);
  }
  const ordersBySpecialty = [...specialtyCounts.entries()]
    .map(([specialty, orders]) => ({ specialty, orders }))
    .sort((a, b) => b.orders - a.orders);

  // ---------- Por planta (plantas del usuario con Maintenance habilitado) ----------
  const maintenanceByPlant = await getByPlant({ plantId, memberships, monthStart });

  return {
    generatedAt: now.toISOString(),
    periodDays: days,
    openOrders: openOrders.length,
    correctivePending,
    preventivePending,
    overdueOrders,
    completedOrders: finishedInPeriod.length,
    maintenanceBacklog: backlog,
    preventiveCompliance,
    preventiveDueCount: preventivesDue.length,
    operationalAvailability: round(availability, 1),
    activeAssets,
    mttr: round(mttr, 1),
    mtbf: round(mtbf, 0),
    correctiveFailures: correctivesInPeriod.length,
    maintenanceCosts: currentMonthCost,
    previousMonthCosts: prevMonthCost,
    costsTrend,
    correctiveVsPreventive: { corrective: correctivePending, preventive: preventivePending },
    maintenanceByPlant,
    failuresByEquipment,
    equipmentDowntime,
    monthlyCosts,
    maintenanceCompliance,
    ordersBySpecialty,
  };
}

/**
 * assignedTo se guarda a veces como id de técnico y a veces como id de usuario,
 * así que se resuelven ambos (primero técnico, luego el técnico vinculado al usuario).
 */
async function resolveSpecialties(plantId, ids) {
  const result = new Map();
  if (ids.length === 0) return result;
  const [technicians, users] = await Promise.all([
    prisma.technician.findMany({
      where: { id: { in: ids }, plantId, deletedAt: null },
      select: { id: true, specialty: true },
    }),
    prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, technician: { select: { specialty: true } } },
    }),
  ]);
  for (const u of users) if (u.technician?.specialty) result.set(u.id, u.technician.specialty);
  for (const t of technicians) if (t.specialty) result.set(t.id, t.specialty);
  return result;
}

async function getByPlant({ plantId, memberships, monthStart }) {
  const plantNames = new Map(memberships.filter((m) => m.plant?.active !== false).map((m) => [m.plantId, m.plant?.name]));
  if (!plantNames.has(plantId)) {
    const current = await prisma.plant.findUnique({ where: { id: plantId }, select: { name: true } });
    plantNames.set(plantId, current?.name);
  }

  const enabled = await prisma.mtPlantAccess.findMany({
    where: { plantId: { in: [...plantNames.keys()] }, enabled: true },
    select: { plantId: true },
  });
  const plantIds = enabled.map((e) => e.plantId);

  const [openCounts, monthOrders] = await Promise.all([
    prisma.mtWorkOrder.groupBy({
      by: ["plantId"],
      where: { plantId: { in: plantIds }, status: { notIn: CLOSED_STATUSES } },
      _count: { _all: true },
    }),
    prisma.mtWorkOrder.findMany({
      where: { plantId: { in: plantIds }, status: { in: DONE_STATUSES }, finishedAt: { gte: monthStart } },
      select: { plantId: true, parts: { select: { quantity: true, costPerUnitAtTime: true } } },
    }),
  ]);

  return plantIds
    .map((id) => ({
      plantId: id,
      plant: plantNames.get(id) || `Planta ${id}`,
      current: id === plantId,
      orders: openCounts.find((c) => c.plantId === id)?._count._all || 0,
      cost: round(monthOrders.filter((wo) => wo.plantId === id).reduce((s, wo) => s + partsCostOf(wo), 0), 2),
    }))
    .sort((a, b) => b.orders - a.orders);
}
