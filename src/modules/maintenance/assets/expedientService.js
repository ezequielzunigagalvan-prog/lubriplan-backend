import prisma from "../../../prisma.js";

const DONE_STATUSES = ["FINISHED", "VALIDATED"];
const MONTH_LABELS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];

const toNumber = (d) => (d == null ? 0 : Number(d));
const round = (n, d = 2) => Number((n || 0).toFixed(d));

/** Minutos de paro: el capturado, o la duración de ejecución si no se capturó. */
function downtimeMinutesOf(wo) {
  if (wo.downtimeMinutes != null) return wo.downtimeMinutes;
  if (wo.startedAt && wo.finishedAt) return Math.max(0, (wo.finishedAt - wo.startedAt) / 60000);
  return 0;
}

/** Ruta de ancestros (de la raíz al padre directo) de un activo. */
export async function getAssetPath(asset) {
  const path = [];
  const seen = new Set([asset.id]);
  let parentId = asset.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = await prisma.mtAsset.findFirst({
      where: { id: parentId, plantId: asset.plantId },
      select: { id: true, code: true, name: true, level: true, parentId: true },
    });
    if (!parent) break;
    path.unshift({ id: parent.id, code: parent.code, name: parent.name, level: parent.level });
    parentId = parent.parentId;
  }
  return path;
}

/**
 * assignedTo se guarda a veces como id de técnico y a veces como id de usuario:
 * se resuelve el nombre buscando en ambos.
 */
async function resolvePeople(plantId, ids) {
  const names = new Map();
  if (ids.length === 0) return names;
  const [technicians, users] = await Promise.all([
    prisma.technician.findMany({ where: { id: { in: ids }, plantId }, select: { id: true, name: true } }),
    prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
  ]);
  for (const u of users) if (u.name) names.set(u.id, u.name);
  for (const t of technicians) if (t.name) names.set(t.id, t.name);
  return names;
}

/** Expediente digital completo de un activo, con datos reales. Devuelve null si no existe. */
export async function getAssetExpedient(assetId, plantId) {
  const asset = await prisma.mtAsset.findFirst({
    where: { id: assetId, plantId, deletedAt: null },
  });
  if (!asset) return null;

  const [path, plant, children, workOrders, plans] = await Promise.all([
    getAssetPath(asset),
    prisma.plant.findUnique({ where: { id: plantId }, select: { name: true } }),
    prisma.mtAsset.findMany({
      where: { parentId: assetId, plantId, deletedAt: null },
      select: { id: true, code: true, name: true, level: true, status: true, criticality: true },
      orderBy: { code: "asc" },
    }),
    prisma.mtWorkOrder.findMany({
      where: { assetId, plantId },
      select: {
        id: true,
        number: true,
        type: true,
        status: true,
        priority: true,
        title: true,
        description: true,
        diagnosis: true,
        failureCause: true,
        workDone: true,
        assignedTo: true,
        scheduledAt: true,
        startedAt: true,
        finishedAt: true,
        downtimeMinutes: true,
        createdAt: true,
        failure: { select: { failureModeId: true, mechanismId: true, rootCauseId: true, productionEffect: true } },
        parts: {
          select: {
            id: true,
            quantity: true,
            costPerUnitAtTime: true,
            createdAt: true,
            sparePart: { select: { id: true, code: true, name: true, unit: true } },
          },
        },
        photos: { select: { id: true, kind: true, url: true, createdAt: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.mtPlan.findMany({
      where: { assetId, plantId, deletedAt: null },
      select: { id: true, code: true, title: true, active: true, nextDueAt: true, frequencyEvery: true, frequencyUnit: true },
      orderBy: { nextDueAt: "asc" },
    }),
  ]);

  // Nombres de códigos de falla (la relación no está declarada en el esquema, se resuelven por id)
  const failureCodeIds = [
    ...new Set(
      workOrders.flatMap((wo) => (wo.failure ? [wo.failure.failureModeId, wo.failure.mechanismId, wo.failure.rootCauseId] : [])).filter(Boolean)
    ),
  ];
  const [failureCodes, people] = await Promise.all([
    failureCodeIds.length
      ? prisma.mtFailureCode.findMany({ where: { id: { in: failureCodeIds }, plantId }, select: { id: true, code: true, name: true } })
      : [],
    resolvePeople(plantId, [...new Set(workOrders.map((wo) => wo.assignedTo).filter(Boolean))]),
  ]);
  const codeById = new Map(failureCodes.map((c) => [c.id, c]));
  const describeCode = (id) => (id && codeById.has(id) ? codeById.get(id) : null);

  const partsCostOf = (wo) => wo.parts.reduce((s, p) => s + toNumber(p.quantity) * toNumber(p.costPerUnitAtTime), 0);

  const maintenanceOrders = workOrders.map((wo) => ({
    id: wo.id,
    number: wo.number,
    type: wo.type,
    status: wo.status,
    priority: wo.priority,
    title: wo.title,
    description: wo.description,
    technician: wo.assignedTo ? people.get(wo.assignedTo) || null : null,
    date: wo.finishedAt || wo.startedAt || wo.scheduledAt || wo.createdAt,
    createdAt: wo.createdAt,
    finishedAt: wo.finishedAt,
    downtimeHours: round(downtimeMinutesOf(wo) / 60, 1),
    partsCost: round(partsCostOf(wo)),
  }));

  const correctives = workOrders.filter((wo) => wo.type === "CORRECTIVE");
  const failureHistory = correctives.map((wo) => ({
    id: wo.id,
    workOrderId: wo.id,
    number: wo.number,
    date: wo.finishedAt || wo.createdAt,
    title: wo.title,
    status: wo.status,
    priority: wo.priority,
    mode: describeCode(wo.failure?.failureModeId),
    mechanism: describeCode(wo.failure?.mechanismId),
    rootCause: describeCode(wo.failure?.rootCauseId),
    productionEffect: wo.failure?.productionEffect || null,
    diagnosis: wo.diagnosis,
    cause: wo.failureCause,
    downtimeHours: round(downtimeMinutesOf(wo) / 60, 1),
    partsCost: round(partsCostOf(wo)),
  }));

  const spareParts = workOrders.flatMap((wo) =>
    wo.parts.map((p) => ({
      id: p.id,
      workOrderId: wo.id,
      workOrderNumber: wo.number,
      sparePartId: p.sparePart?.id,
      code: p.sparePart?.code,
      name: p.sparePart?.name,
      unit: p.sparePart?.unit,
      quantity: toNumber(p.quantity),
      unitCost: toNumber(p.costPerUnitAtTime),
      total: round(toNumber(p.quantity) * toNumber(p.costPerUnitAtTime)),
      date: p.createdAt,
    }))
  ).sort((a, b) => new Date(b.date) - new Date(a.date));

  const photos = workOrders.flatMap((wo) =>
    wo.photos.map((ph) => ({ id: ph.id, url: ph.url, kind: ph.kind, date: ph.createdAt, workOrderId: wo.id, workOrderNumber: wo.number, title: wo.title }))
  ).sort((a, b) => new Date(b.date) - new Date(a.date));

  // Costos de refacciones de los últimos 12 meses, por mes de cierre de la OT
  const now = new Date();
  const monthly = new Map();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthly.set(`${d.getFullYear()}-${d.getMonth()}`, { month: MONTH_LABELS[d.getMonth()], year: d.getFullYear(), cost: 0, orders: 0 });
  }
  for (const wo of workOrders) {
    if (!DONE_STATUSES.includes(wo.status) || !wo.finishedAt) continue;
    const key = `${wo.finishedAt.getFullYear()}-${wo.finishedAt.getMonth()}`;
    if (!monthly.has(key)) continue;
    const m = monthly.get(key);
    m.cost += partsCostOf(wo);
    m.orders += 1;
  }

  const finished = workOrders.filter((wo) => DONE_STATUSES.includes(wo.status));
  const lastIntervention = finished.reduce((max, wo) => (wo.finishedAt && (!max || wo.finishedAt > max) ? wo.finishedAt : max), null);

  return {
    asset: { ...asset, plantName: plant?.name || null, path },
    children,
    plans,
    kpis: {
      totalWorkOrders: workOrders.length,
      openWorkOrders: workOrders.filter((wo) => !["FINISHED", "VALIDATED", "REJECTED", "CANCELLED"].includes(wo.status)).length,
      preventiveOrders: workOrders.filter((wo) => wo.type !== "CORRECTIVE").length,
      correctiveOrders: correctives.length,
      totalDowntimeHours: round(correctives.reduce((s, wo) => s + downtimeMinutesOf(wo), 0) / 60, 1),
      accumulatedPartsCost: round(finished.reduce((s, wo) => s + partsCostOf(wo), 0)),
      lastIntervention,
    },
    maintenanceOrders,
    failureHistory,
    spareParts,
    photos,
    monthlyCosts: [...monthly.values()].map((m) => ({ ...m, cost: round(m.cost) })),
  };
}

/** Árbol completo de activos de la planta (raíces = activos sin padre o con padre eliminado). */
export async function getAssetHierarchy(plantId) {
  const [plant, assets] = await Promise.all([
    prisma.plant.findUnique({ where: { id: plantId }, select: { id: true, name: true } }),
    prisma.mtAsset.findMany({
      where: { plantId, deletedAt: null },
      select: {
        id: true, parentId: true, code: true, name: true, level: true, status: true,
        criticality: true, location: true, manufacturer: true, model: true,
      },
      orderBy: { code: "asc" },
    }),
  ]);

  const nodes = new Map(assets.map((a) => [a.id, { ...a, children: [] }]));
  const roots = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  return {
    plant: { id: plant?.id ?? plantId, name: plant?.name || `Planta ${plantId}` },
    total: assets.length,
    roots,
  };
}
