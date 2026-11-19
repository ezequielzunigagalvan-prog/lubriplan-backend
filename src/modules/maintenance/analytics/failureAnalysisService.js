import prisma from "../../../prisma.js";

const HOUR = 3600000;
const round = (n, d = 1) => Number((n || 0).toFixed(d));
const downtimeHours = (wo) =>
  wo.downtimeMinutes != null ? wo.downtimeMinutes / 60 : wo.startedAt && wo.finishedAt ? Math.max(0, (wo.finishedAt - wo.startedAt) / HOUR) : 0;

/** Pareto: ordena de mayor a menor y agrega el % acumulado. */
function pareto(map) {
  const rows = [...map.values()].sort((a, b) => b.count - a.count || b.downtimeHours - a.downtimeHours);
  const total = rows.reduce((s, r) => s + r.count, 0);
  let acc = 0;
  return rows.map((r) => {
    acc += r.count;
    return { ...r, downtimeHours: round(r.downtimeHours), share: total ? round((r.count / total) * 100, 0) : 0, cumulative: total ? round((acc / total) * 100, 0) : 0 };
  });
}

/**
 * Análisis de fallas (ISO 14224) de las órdenes correctivas creadas en los últimos `days` días:
 * Pareto por modo, mecanismo y causa raíz, efecto en producción, equipos con más fallas
 * y cuántas correctivas siguen sin clasificar.
 */
export async function getFailureAnalysis(plantId, { days = 180 } = {}) {
  const since = new Date(Date.now() - days * 24 * HOUR);

  const [orders, codes] = await Promise.all([
    prisma.mtWorkOrder.findMany({
      where: { plantId, type: "CORRECTIVE", createdAt: { gte: since }, status: { notIn: ["REJECTED", "CANCELLED"] } },
      select: {
        id: true, status: true, downtimeMinutes: true, startedAt: true, finishedAt: true,
        asset: { select: { id: true, code: true, name: true } },
        failure: { select: { failureModeId: true, mechanismId: true, rootCauseId: true, productionEffect: true } },
      },
    }),
    prisma.mtFailureCode.findMany({ where: { plantId }, select: { id: true, code: true, name: true, category: true } }),
  ]);
  const codeById = new Map(codes.map((c) => [c.id, c]));

  const groups = { FAILURE_MODE: new Map(), MECHANISM: new Map(), ROOT_CAUSE: new Map() };
  const fields = { FAILURE_MODE: "failureModeId", MECHANISM: "mechanismId", ROOT_CAUSE: "rootCauseId" };
  const effects = new Map();
  const assets = new Map();

  for (const wo of orders) {
    const hours = downtimeHours(wo);
    for (const [category, field] of Object.entries(fields)) {
      const id = wo.failure?.[field];
      const code = id ? codeById.get(id) : null;
      const key = code ? code.id : "none";
      const row = groups[category].get(key) || {
        id: code?.id ?? null,
        code: code?.code ?? null,
        name: code ? code.name : "Sin clasificar",
        count: 0,
        downtimeHours: 0,
      };
      row.count++;
      row.downtimeHours += hours;
      groups[category].set(key, row);
    }

    const effect = wo.failure?.productionEffect || "UNKNOWN";
    effects.set(effect, (effects.get(effect) || 0) + 1);

    if (wo.asset) {
      const a = assets.get(wo.asset.id) || { ...wo.asset, count: 0, downtimeHours: 0, modes: new Map() };
      a.count++;
      a.downtimeHours += hours;
      const mode = wo.failure?.failureModeId ? codeById.get(wo.failure.failureModeId)?.name : null;
      if (mode) a.modes.set(mode, (a.modes.get(mode) || 0) + 1);
      assets.set(wo.asset.id, a);
    }
  }

  const classified = orders.filter((wo) => wo.failure?.failureModeId).length;

  return {
    periodDays: days,
    summary: {
      correctives: orders.length,
      closed: orders.filter((wo) => ["FINISHED", "VALIDATED"].includes(wo.status)).length,
      classified,
      unclassified: orders.length - classified,
      classifiedPercent: orders.length ? round((classified / orders.length) * 100, 0) : null,
      downtimeHours: round(orders.reduce((s, wo) => s + downtimeHours(wo), 0)),
      catalogSize: codes.length,
    },
    modes: pareto(groups.FAILURE_MODE),
    mechanisms: pareto(groups.MECHANISM),
    rootCauses: pareto(groups.ROOT_CAUSE),
    productionEffects: [...effects.entries()].map(([effect, count]) => ({ effect, count })).sort((a, b) => b.count - a.count),
    assets: [...assets.values()]
      .map(({ modes, ...a }) => ({
        ...a,
        downtimeHours: round(a.downtimeHours),
        topMode: [...modes.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] || null,
      }))
      .sort((a, b) => b.count - a.count || b.downtimeHours - a.downtimeHours)
      .slice(0, 10),
  };
}
