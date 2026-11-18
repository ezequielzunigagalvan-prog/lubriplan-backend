import prisma from "../../../prisma.js";

export const HISTORY_CATEGORIES = ["WORK_ORDER", "FAILURE", "PREVENTIVE_MAINTENANCE", "SPARE_PARTS"];
const SOURCE_LIMIT = 2000; // tope por fuente para no cargar de más en plantas grandes

const toNumber = (d) => (d == null ? 0 : Number(d));

/** Clasifica un evento de OT en tipo y categoría del historial. */
function classifyEvent(ev, wo) {
  const preventive = wo.type !== "CORRECTIVE";
  if (!ev.fromStatus) {
    if (!preventive) return { type: "FAILURE_REPORTED", category: "FAILURE" };
    return { type: "WORK_ORDER_CREATED", category: "PREVENTIVE_MAINTENANCE" };
  }
  const category = preventive ? "PREVENTIVE_MAINTENANCE" : "WORK_ORDER";
  const byStatus = {
    FINISHED: "WORK_ORDER_FINISHED",
    VALIDATED: "WORK_ORDER_VALIDATED",
    REJECTED: "WORK_ORDER_REJECTED",
    CANCELLED: "WORK_ORDER_CANCELLED",
    ASSIGNED: "WORK_ORDER_ASSIGNED",
    IN_PROGRESS: "WORK_ORDER_STARTED",
  };
  return { type: byStatus[ev.toStatus] || "WORK_ORDER_STATUS", category };
}

/**
 * Historial unificado de la planta: eventos de órdenes de trabajo, refacciones consumidas
 * y corridas de planes preventivos. Todo sale de tablas reales; no hay eventos sintéticos.
 */
export async function getHistory(plantId, { days = 30, category, search, assetId, page = 1, limit = 50 } = {}) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const woFilter = assetId ? { assetId } : {};

  const [events, parts, runs] = await Promise.all([
    prisma.mtWorkOrderEvent.findMany({
      where: { plantId, createdAt: { gte: since }, workOrder: woFilter },
      orderBy: { createdAt: "desc" },
      take: SOURCE_LIMIT,
      include: {
        workOrder: {
          select: {
            id: true, number: true, title: true, type: true, priority: true, description: true,
            workDone: true, downtimeMinutes: true, assetId: true,
            asset: { select: { id: true, code: true, name: true } },
          },
        },
      },
    }),
    prisma.mtWorkOrderPart.findMany({
      where: { createdAt: { gte: since }, workOrder: { plantId, ...woFilter } },
      orderBy: { createdAt: "desc" },
      take: SOURCE_LIMIT,
      include: {
        sparePart: { select: { id: true, code: true, name: true, unit: true } },
        workOrder: {
          select: { id: true, number: true, title: true, type: true, priority: true, asset: { select: { id: true, code: true, name: true } } },
        },
      },
    }),
    prisma.mtPlanRun.findMany({
      where: { plantId, runAt: { gte: since }, dryRun: false, decision: { in: ["GENERATED", "SKIPPED_OPEN", "ERROR"] }, ...(assetId ? { plan: { assetId } } : {}) },
      orderBy: { runAt: "desc" },
      take: SOURCE_LIMIT,
      include: {
        plan: { select: { id: true, code: true, title: true, priority: true, asset: { select: { id: true, code: true, name: true } } } },
      },
    }),
  ]);

  // OTs creadas antes de que se registrara el evento de creación: se usa su createdAt real
  const createdLogged = new Set(events.filter((e) => !e.fromStatus).map((e) => e.workOrderId));
  const unloggedCreations = await prisma.mtWorkOrder.findMany({
    where: { plantId, createdAt: { gte: since }, id: { notIn: [...createdLogged] }, events: { none: { fromStatus: null } }, ...woFilter },
    select: {
      id: true, number: true, title: true, type: true, priority: true, description: true, requestedBy: true, createdAt: true,
      asset: { select: { id: true, code: true, name: true } },
    },
    take: SOURCE_LIMIT,
  });

  const userIds = [...new Set([...events.map((e) => e.userId), ...unloggedCreations.map((w) => w.requestedBy)])];
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
    : [];
  const userName = new Map(users.map((u) => [u.id, u.name]));

  const items = [
    ...events.map((ev) => {
      const wo = ev.workOrder;
      const { type, category } = classifyEvent(ev, wo);
      return {
        id: `event-${ev.id}`,
        type,
        category,
        timestamp: ev.createdAt,
        title: wo.title,
        description: ev.comment || (type === "FAILURE_REPORTED" ? wo.description : null),
        asset: wo.asset,
        workOrder: { id: wo.id, number: wo.number },
        user: userName.get(ev.userId) || null,
        priority: wo.priority,
        fromStatus: ev.fromStatus,
        toStatus: ev.toStatus,
        details: {
          ...(ev.metadata?.assignedToName && { assignedTo: ev.metadata.assignedToName }),
          ...(type === "WORK_ORDER_FINISHED" && wo.workDone && { workDone: wo.workDone }),
          ...(type === "WORK_ORDER_FINISHED" && wo.downtimeMinutes != null && { downtimeMinutes: wo.downtimeMinutes }),
        },
      };
    }),
    ...unloggedCreations.map((wo) => ({
      id: `created-${wo.id}`,
      type: wo.type === "CORRECTIVE" ? "FAILURE_REPORTED" : "WORK_ORDER_CREATED",
      category: wo.type === "CORRECTIVE" ? "FAILURE" : "PREVENTIVE_MAINTENANCE",
      timestamp: wo.createdAt,
      title: wo.title,
      description: wo.description,
      asset: wo.asset,
      workOrder: { id: wo.id, number: wo.number },
      user: userName.get(wo.requestedBy) || null,
      priority: wo.priority,
      fromStatus: null,
      toStatus: "REQUESTED",
      details: {},
    })),
    ...parts.map((p) => ({
      id: `part-${p.id}`,
      type: "SPARE_PART_USED",
      category: "SPARE_PARTS",
      timestamp: p.createdAt,
      title: `${p.sparePart?.code ?? ""} · ${p.sparePart?.name ?? "Refacción"}`,
      description: `${toNumber(p.quantity)} ${p.sparePart?.unit || "pza"} en ${p.workOrder.title}`,
      asset: p.workOrder.asset,
      workOrder: { id: p.workOrder.id, number: p.workOrder.number },
      user: null,
      priority: p.workOrder.priority,
      details: {
        quantity: toNumber(p.quantity),
        unitCost: toNumber(p.costPerUnitAtTime),
        totalCost: Number((toNumber(p.quantity) * toNumber(p.costPerUnitAtTime)).toFixed(2)),
      },
    })),
    ...runs.map((r) => ({
      id: `run-${r.id}`,
      type: r.decision === "GENERATED" ? "PREVENTIVE_GENERATED" : r.decision === "ERROR" ? "PREVENTIVE_ERROR" : "PREVENTIVE_SKIPPED",
      category: "PREVENTIVE_MAINTENANCE",
      timestamp: r.runAt,
      title: `${r.plan.code} · ${r.plan.title}`,
      description:
        r.decision === "GENERATED"
          ? `OT generada (${r.trigger === "MANUAL" ? "manual" : "automática"})`
          : r.decision === "ERROR"
            ? `Error al generar: ${r.detail?.error || "desconocido"}`
            : "Ciclo omitido: el plan tenía una OT abierta",
      asset: r.plan.asset,
      // detail.workOrderNumber se guarda formateado ("OT-000011"): se normaliza a número
      workOrder: r.workOrderId ? { id: r.workOrderId, number: Number.parseInt(String(r.detail?.workOrderNumber ?? "").replace(/\D/g, ""), 10) || null } : null,
      user: null,
      priority: r.plan.priority,
      details: { cycleKey: r.cycleKey, missedCycles: r.missedCycles || 0 },
    })),
  ];

  // Stats sobre todo el periodo (antes de filtrar por categoría/búsqueda)
  const stats = {
    total: items.length,
    ordersFinished: items.filter((i) => i.type === "WORK_ORDER_FINISHED").length,
    failuresReported: items.filter((i) => i.type === "FAILURE_REPORTED").length,
    partsUsed: items.filter((i) => i.type === "SPARE_PART_USED").length,
    partsCost: Number(items.filter((i) => i.type === "SPARE_PART_USED").reduce((s, i) => s + i.details.totalCost, 0).toFixed(2)),
    preventivesGenerated: items.filter((i) => i.type === "PREVENTIVE_GENERATED").length,
  };

  const term = search?.trim().toLowerCase();
  const filtered = items
    .filter((i) => !category || i.category === category)
    .filter(
      (i) =>
        !term ||
        [i.title, i.description, i.user, i.asset?.code, i.asset?.name, i.details?.assignedTo, i.workOrder?.number && String(i.workOrder.number)]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(term))
    )
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  const start = (page - 1) * limit;
  return {
    data: filtered.slice(start, start + limit),
    total: filtered.length,
    page,
    totalPages: Math.ceil(filtered.length / limit),
    periodDays: days,
    stats,
    truncated: [events, parts, runs].some((src) => src.length === SOURCE_LIMIT),
  };
}
