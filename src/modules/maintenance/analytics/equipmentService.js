import prisma from "../../../prisma.js";

const DONE = ["FINISHED", "VALIDATED"];
const CLOSED = ["FINISHED", "VALIDATED", "REJECTED", "CANCELLED"];
const MONTHS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const HOUR = 3600000;

const round = (n, d = 1) => (n == null || !Number.isFinite(n) ? null : Number(n.toFixed(d)));
const toNumber = (d) => (d == null ? 0 : Number(d));
const partsCost = (wo) => wo.parts.reduce((s, p) => s + toNumber(p.quantity) * toNumber(p.costPerUnitAtTime), 0);
const repairHours = (wo) => (wo.startedAt && wo.finishedAt ? Math.max(0, (wo.finishedAt - wo.startedAt) / HOUR) : null);
const downtimeHours = (wo) => (wo.downtimeMinutes != null ? wo.downtimeMinutes / 60 : repairHours(wo) ?? 0);

/** Indicadores de confiabilidad de un conjunto de OTs sobre `assetCount` equipos en `hoursInPeriod`. */
function reliability(orders, assetCount, hoursInPeriod) {
  const correctives = orders.filter((w) => w.type === "CORRECTIVE" && DONE.includes(w.status) && w.finishedAt);
  const repairs = correctives.map(repairHours).filter((h) => h != null);
  const downtime = correctives.reduce((s, w) => s + downtimeHours(w), 0);
  const calendar = assetCount * hoursInPeriod;
  return {
    failures: correctives.length,
    downtimeHours: round(downtime),
    mttr: repairs.length ? round(repairs.reduce((a, b) => a + b, 0) / repairs.length) : null,
    mtbf: correctives.length ? round((calendar - downtime) / correctives.length, 0) : null,
    availability: calendar > 0 ? round(((calendar - downtime) / calendar) * 100) : null,
  };
}

/** % de preventivas con fecha compromiso en el periodo terminadas a tiempo. */
function planCompliance(orders, now) {
  const due = orders.filter((w) => w.type !== "CORRECTIVE" && !["REJECTED", "CANCELLED"].includes(w.status) && (w.dueAt || w.scheduledAt) && new Date(w.dueAt || w.scheduledAt) <= now);
  if (due.length === 0) return null;
  const onTime = due.filter((w) => {
    if (!w.finishedAt || !DONE.includes(w.status)) return false;
    const limit = new Date(w.dueAt || w.scheduledAt);
    limit.setHours(23, 59, 59, 999);
    return w.finishedAt <= limit;
  }).length;
  return round((onTime / due.length) * 100, 0);
}

function monthBuckets(now, count) {
  const buckets = new Map();
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    buckets.set(`${d.getFullYear()}-${d.getMonth()}`, { month: MONTHS[d.getMonth()], year: d.getFullYear(), orders: 0, preventive: 0, corrective: 0, failures: 0, cost: 0, downtime: 0 });
  }
  return buckets;
}

function addToBuckets(buckets, wo) {
  const created = buckets.get(`${wo.createdAt.getFullYear()}-${wo.createdAt.getMonth()}`);
  if (created) {
    created.orders++;
    if (wo.type === "CORRECTIVE") created.corrective++;
    else created.preventive++;
  }
  if (wo.finishedAt && DONE.includes(wo.status)) {
    const finished = buckets.get(`${wo.finishedAt.getFullYear()}-${wo.finishedAt.getMonth()}`);
    if (finished) {
      finished.cost += partsCost(wo);
      if (wo.type === "CORRECTIVE") {
        finished.failures++;
        finished.downtime += downtimeHours(wo);
      }
    }
  }
}

const finalizeBuckets = (buckets) => [...buckets.values()].map((b) => ({ ...b, cost: round(b.cost, 2), downtime: round(b.downtime) }));

/**
 * Analítica de equipos de la planta en los últimos `days` días: KPIs de planta, tendencia mensual
 * y métricas por equipo (fallas, paro, MTBF/MTTR, disponibilidad, costo, modos de falla y técnicos).
 * Solo se usan datos registrados; lo que no se puede calcular se devuelve como null.
 */
export async function getEquipmentAnalytics(plantId, { days = 90 } = {}) {
  const now = new Date();
  const since = new Date(now.getTime() - days * 24 * HOUR);
  const since30 = new Date(now.getTime() - 30 * 24 * HOUR);
  const hoursInPeriod = days * 24;

  const [assets, orders] = await Promise.all([
    prisma.mtAsset.findMany({
      where: { plantId, deletedAt: null },
      select: { id: true, code: true, name: true, level: true, criticality: true, status: true, location: true },
      orderBy: { code: "asc" },
    }),
    prisma.mtWorkOrder.findMany({
      where: { plantId, OR: [{ createdAt: { gte: since } }, { finishedAt: { gte: since } }, { status: { notIn: CLOSED } }] },
      select: {
        id: true, number: true, type: true, status: true, priority: true, assetId: true, assignedTo: true,
        createdAt: true, startedAt: true, finishedAt: true, dueAt: true, scheduledAt: true, downtimeMinutes: true,
        parts: { select: { quantity: true, costPerUnitAtTime: true } },
        failure: { select: { failureModeId: true } },
      },
    }),
  ]);

  const inPeriod = orders.filter((w) => w.createdAt >= since || (w.finishedAt && w.finishedAt >= since));
  const finishedInPeriod = inPeriod.filter((w) => DONE.includes(w.status) && w.finishedAt >= since);

  // Nombres de modos de falla y técnicos
  const modeIds = [...new Set(inPeriod.map((w) => w.failure?.failureModeId).filter(Boolean))];
  const techIds = [...new Set(inPeriod.map((w) => w.assignedTo).filter(Boolean))];
  const [modes, techs] = await Promise.all([
    modeIds.length ? prisma.mtFailureCode.findMany({ where: { id: { in: modeIds }, plantId }, select: { id: true, code: true, name: true } }) : [],
    techIds.length ? prisma.technician.findMany({ where: { id: { in: techIds }, plantId }, select: { id: true, name: true } }) : [],
  ]);
  const modeName = new Map(modes.map((m) => [m.id, `${m.code} · ${m.name}`]));
  const techName = new Map(techs.map((t) => [t.id, t.name]));

  const monthCount = Math.min(12, Math.max(3, Math.ceil(days / 30)));

  const equipment = assets.map((asset) => {
    const own = inPeriod.filter((w) => w.assetId === asset.id);
    const done = own.filter((w) => DONE.includes(w.status) && w.finishedAt >= since);
    const rel = reliability(own.filter((w) => w.finishedAt >= since), 1, hoursInPeriod);
    const failures30d = own.filter((w) => w.type === "CORRECTIVE" && DONE.includes(w.status) && w.finishedAt >= since30).length;
    const openOrders = orders.filter((w) => w.assetId === asset.id && !CLOSED.includes(w.status)).length;

    const modeCount = new Map();
    for (const w of own.filter((x) => x.type === "CORRECTIVE")) {
      const label = w.failure?.failureModeId ? modeName.get(w.failure.failureModeId) || "Modo no encontrado" : "Sin clasificar";
      modeCount.set(label, (modeCount.get(label) || 0) + 1);
    }

    const techStats = new Map();
    for (const w of done) {
      if (!w.assignedTo) continue;
      const t = techStats.get(w.assignedTo) || { name: techName.get(w.assignedTo) || `Técnico ${w.assignedTo}`, interventions: 0, hours: 0 };
      t.interventions++;
      t.hours += repairHours(w) ?? 0;
      techStats.set(w.assignedTo, t);
    }

    const buckets = monthBuckets(now, monthCount);
    own.forEach((w) => addToBuckets(buckets, w));

    // Semáforo simple y explicable: fallas recientes y disponibilidad, ponderadas por criticidad
    let risk = "OK";
    if (failures30d >= 2 || (rel.availability != null && rel.availability < 90)) risk = asset.criticality === "C" ? "WARNING" : "CRITICAL";
    else if (failures30d === 1 || own.some((w) => w.type === "CORRECTIVE" && !CLOSED.includes(w.status))) risk = "WARNING"; // falla reciente o correctiva abierta

    return {
      ...asset,
      risk,
      openOrders,
      totalOrders: own.length,
      preventive: own.filter((w) => w.type !== "CORRECTIVE").length,
      corrective: own.filter((w) => w.type === "CORRECTIVE").length,
      failures: rel.failures,
      failures30d,
      downtimeHours: rel.downtimeHours,
      mtbf: rel.mtbf,
      mttr: rel.mttr,
      availability: rel.availability,
      partsCost: round(done.reduce((s, w) => s + partsCost(w), 0), 2),
      planCompliance: planCompliance(own, now),
      failureModes: [...modeCount.entries()].map(([mode, count]) => ({ mode, count })).sort((a, b) => b.count - a.count),
      technicians: [...techStats.values()].map((t) => ({ ...t, hours: round(t.hours) })).sort((a, b) => b.interventions - a.interventions),
      monthly: finalizeBuckets(buckets),
    };
  });

  const plantRel = reliability(finishedInPeriod, assets.length, hoursInPeriod);
  const plantBuckets = monthBuckets(now, monthCount);
  inPeriod.forEach((w) => addToBuckets(plantBuckets, w));
  const finishedPreventive = finishedInPeriod.filter((w) => w.type !== "CORRECTIVE").length;

  return {
    generatedAt: now.toISOString(),
    periodDays: days,
    summary: {
      totalOrders: inPeriod.length,
      finishedOrders: finishedInPeriod.length,
      preventive: inPeriod.filter((w) => w.type !== "CORRECTIVE").length,
      corrective: inPeriod.filter((w) => w.type === "CORRECTIVE").length,
      openOrders: orders.filter((w) => !CLOSED.includes(w.status)).length,
      downtimeHours: plantRel.downtimeHours,
      partsCost: round(finishedInPeriod.reduce((s, w) => s + partsCost(w), 0), 2),
      equipmentCount: assets.length,
      criticality: {
        A: assets.filter((a) => a.criticality === "A").length,
        B: assets.filter((a) => a.criticality === "B").length,
        C: assets.filter((a) => a.criticality === "C").length,
      },
      risk: {
        CRITICAL: equipment.filter((e) => e.risk === "CRITICAL").length,
        WARNING: equipment.filter((e) => e.risk === "WARNING").length,
        OK: equipment.filter((e) => e.risk === "OK").length,
      },
    },
    kpis: {
      mtbf: plantRel.mtbf,
      mttr: plantRel.mttr,
      availability: plantRel.availability,
      preventiveRatio: finishedInPeriod.length ? round((finishedPreventive / finishedInPeriod.length) * 100, 0) : null,
      planCompliance: planCompliance(inPeriod, now),
      failures: plantRel.failures,
    },
    monthly: finalizeBuckets(plantBuckets),
    equipment: equipment.sort((a, b) => ({ CRITICAL: 0, WARNING: 1, OK: 2 })[a.risk] - ({ CRITICAL: 0, WARNING: 1, OK: 2 })[b.risk] || b.failures - a.failures || b.totalOrders - a.totalOrders),
  };
}
