// src/ia/chatContextBuilder.js
// Compila un snapshot de la planta activa para usar como contexto en el chat.
// Usa la misma lógica de queries que buildDashboardSummary para garantizar datos correctos.
// Para modelos en TENANTED_MODELS (Execution, ConditionReport, Technician, Lubricant)
// el middleware de Prisma auto-agrega plantId; además lo pasamos explícitamente como red de seguridad.
// PurchaseOrder y Plant NO están en TENANTED_MODELS → filtro manual por plantId siempre.

// Copia local de helpers de timezone (igual que buildDashboardSummary.js)
const DEFAULT_TIMEZONE = "America/Mexico_City";

function dateKeyInTimezone(value, timezone = DEFAULT_TIMEZONE) {
  const dt = new Date(value);
  if (!Number.isFinite(dt.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(dt);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : "";
}

function isBeforeTodayInTimezone(value, todayKey, timezone = DEFAULT_TIMEZONE) {
  const valueKey = dateKeyInTimezone(value, timezone);
  return Boolean(valueKey) && Boolean(todayKey) && valueKey < todayKey;
}

export async function buildChatContext(prisma, { plantId }) {
  const pid = Number(plantId);
  if (!Number.isFinite(pid) || pid <= 0) return null;

  const now = new Date();

  // Paso 1: obtener planta y timezone primero (igual que buildDashboardSummary)
  const plant = await prisma.plant.findUnique({
    where: { id: pid },
    select: { name: true, timezone: true },
  });
  const plantTimezone = String(plant?.timezone || DEFAULT_TIMEZONE);
  const todayKey = dateKeyInTimezone(now, plantTimezone);

  // Rango mes actual (para completadas y contexto)
  const monthFrom = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const monthTo = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

  // Ventana para ejecuciones abiertas: 90 días atrás → 30 días adelante
  // Así capturamos vencidas de meses anteriores y próximas actividades
  const openFrom = new Date(now);
  openFrom.setDate(openFrom.getDate() - 90);
  const openTo = new Date(now);
  openTo.setDate(openTo.getDate() + 30);

  const [
    openExecs,
    completedCount,
    openConditionReports,
    technicians,
    lubricants,
    purchaseOrders,
  ] = await Promise.all([
    // Ejecuciones NO completadas en ventana — mismo patrón que buildDashboardSummary
    // plantId explícito como red de seguridad + status: { not: "COMPLETED" }
    prisma.execution.findMany({
      where: {
        plantId: pid,
        scheduledAt: { gte: openFrom, lte: openTo },
        status: { not: "COMPLETED" },
      },
      select: { scheduledAt: true, status: true },
      take: 500,
    }),

    // Completadas en el mes actual (igual que dashboard)
    prisma.execution.count({
      where: {
        plantId: pid,
        status: "COMPLETED",
        executedAt: { gte: monthFrom, lte: monthTo },
      },
    }),

    // Reportes de condición abiertos con info del equipo (tenant-scoped + plantId explícito)
    prisma.conditionReport.findMany({
      where: {
        plantId: pid,
        status: { in: ["OPEN", "IN_PROGRESS"] },
      },
      include: {
        equipment: {
          select: { name: true, code: true, criticality: true },
        },
      },
      orderBy: [{ condition: "desc" }, { createdAt: "asc" }],
      take: 8,
    }),

    // Técnicos activos con sus ejecuciones abiertas (tenant-scoped + plantId explícito)
    prisma.technician.findMany({
      where: { plantId: pid, status: "Activo", deletedAt: null },
      select: {
        name: true,
        code: true,
        specialty: true,
        executions: {
          where: { status: { not: "COMPLETED" } },
          select: { id: true, scheduledAt: true },
        },
      },
      take: 10,
    }),

    // Lubricantes con minStock definido (tenant-scoped + plantId explícito)
    prisma.lubricant.findMany({
      where: { plantId: pid, minStock: { not: null } },
      select: {
        name: true,
        code: true,
        stock: true,
        minStock: true,
        unit: true,
        brand: true,
      },
      take: 30,
    }),

    // Órdenes de compra activas: NOT tenant-scoped → filtro manual por plantId siempre
    prisma.purchaseOrder.findMany({
      where: {
        plantId: pid,
        status: { in: ["REQUESTED", "APPROVED"] },
      },
      orderBy: { createdAt: "desc" },
      include: {
        items: {
          include: {
            lubricant: { select: { name: true, unit: true } },
          },
        },
      },
      take: 3,
    }),
  ]);

  // Clasificar vencidas vs pendientes en JS con comparación de fechas en timezone de la planta
  // (igual que buildDashboardSummary — evita errores UTC vs hora local)
  let overdueCount = 0;
  let pendingCount = 0;
  for (const e of openExecs) {
    if (isBeforeTodayInTimezone(e.scheduledAt, todayKey, plantTimezone)) {
      overdueCount++;
    } else {
      pendingCount++;
    }
  }

  // Stock bajo: usa <= igual que el dashboard (stock <= minStock)
  const lowStockLubricants = lubricants.filter(
    (l) => l.minStock != null && l.stock <= l.minStock
  );

  // Carga real por técnico con comparación timezone-aware
  const techniciansSummary = technicians.map((t) => {
    const overdueAssigned = t.executions.filter(
      (e) => isBeforeTodayInTimezone(e.scheduledAt, todayKey, plantTimezone)
    ).length;
    return {
      name: t.name,
      code: t.code,
      specialty: t.specialty,
      pendingCount: t.executions.length,
      overdueCount: overdueAssigned,
    };
  });

  return {
    plantName: plant?.name || "Planta activa",
    plantTimezone,
    activities: {
      completed: completedCount,
      pending: pendingCount,
      overdue: overdueCount,
      total: completedCount + pendingCount + overdueCount,
    },
    openConditionReports: openConditionReports.map((r) => ({
      status: r.status,
      condition: String(r.condition || ""),
      category: r.category || null,
      equipment: r.equipment?.name || "Equipo",
      equipmentCode: r.equipment?.code || "",
      criticality: r.equipment?.criticality || null,
      ageHours: Math.round((now - new Date(r.createdAt)) / 3_600_000),
    })),
    activeTechnicians: techniciansSummary,
    lowStockLubricants: lowStockLubricants.map((l) => ({
      name: l.name,
      code: l.code || "",
      stock: l.stock,
      minStock: l.minStock,
      unit: l.unit,
      brand: l.brand || "",
    })),
    activePurchaseOrders: purchaseOrders.map((po) => ({
      id: po.id,
      status: po.status,
      createdAt: po.createdAt,
      items: po.items.map((item) => ({
        lubricant: item.lubricant?.name || "Lubricante",
        quantity: item.quantity,
        unit: item.lubricant?.unit || "",
      })),
    })),
  };
}
