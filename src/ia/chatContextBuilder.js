// src/ia/chatContextBuilder.js
// Compila un snapshot de la planta activa para usar como contexto en el chat.
// Las queries a modelos en TENANTED_MODELS (Execution, ConditionReport, Technician, Lubricant)
// son auto-scoped por el Prisma middleware al plantId activo via AsyncLocalStorage.
// PurchaseOrder y Plant NO están en TENANTED_MODELS → se filtra manualmente por plantId.

export async function buildChatContext(prisma, { plantId }) {
  const pid = Number(plantId);
  if (!Number.isFinite(pid) || pid <= 0) return null;

  const now = new Date();

  const [
    plant,
    overdueCount,
    pendingCount,
    completedCount,
    openConditionReports,
    technicians,
    lubricants,
    purchaseOrders,
  ] = await Promise.all([
    // Plant: NOT tenant-scoped, query directo por id
    prisma.plant.findUnique({
      where: { id: pid },
      select: { name: true, timezone: true },
    }),

    // Actividades vencidas: PENDING con scheduledAt pasado (tenant-scoped)
    prisma.execution.count({
      where: { status: "PENDING", scheduledAt: { lt: now } },
    }),

    // Actividades pendientes a tiempo: PENDING con scheduledAt futuro (tenant-scoped)
    prisma.execution.count({
      where: { status: "PENDING", scheduledAt: { gte: now } },
    }),

    // Actividades completadas: cualquier estado que no sea PENDING (tenant-scoped)
    prisma.execution.count({
      where: { status: { not: "PENDING" } },
    }),

    // Reportes de condición abiertos con info del equipo (tenant-scoped)
    prisma.conditionReport.findMany({
      where: { status: { in: ["OPEN", "IN_PROGRESS"] } },
      include: {
        equipment: {
          select: { name: true, code: true, criticality: true },
        },
      },
      orderBy: [{ condition: "desc" }, { createdAt: "asc" }],
      take: 8,
    }),

    // Técnicos activos con su carga de ejecuciones pendientes (tenant-scoped)
    prisma.technician.findMany({
      where: { status: "Activo", deletedAt: null },
      select: {
        name: true,
        code: true,
        specialty: true,
        executions: {
          where: { status: "PENDING" },
          select: { id: true, scheduledAt: true },
        },
      },
      take: 10,
    }),

    // Lubricantes con minStock definido (tenant-scoped) — filtramos bajo stock en JS
    prisma.lubricant.findMany({
      where: { minStock: { not: null } },
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

    // Órdenes de compra activas: NOT tenant-scoped → filtro manual por plantId
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

  // Derivar stock bajo en JS (minStock != null ya filtrado por query)
  const lowStockLubricants = lubricants.filter(
    (l) => l.minStock != null && l.stock < l.minStock
  );

  // Calcular carga real por técnico (pendientes + vencidos)
  const techniciansSummary = technicians.map((t) => {
    const overdueAssigned = t.executions.filter(
      (e) => new Date(e.scheduledAt) < now
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
    plantTimezone: plant?.timezone || "America/Mexico_City",
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
