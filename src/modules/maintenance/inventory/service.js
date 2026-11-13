import prisma from "../../../prisma.js";
import { logger } from "../../../config/logger.js";

// ============================================================
// WAREHOUSE SERVICE
// ============================================================

export async function createWarehouse(plantId, name, location) {
  const existing = await prisma.mtWarehouse.findFirst({
    where: { plantId, name },
  });

  if (existing) {
    throw new Error(`Warehouse '${name}' already exists in this plant`);
  }

  return await prisma.mtWarehouse.create({
    data: { plantId, name, location },
  });
}

export async function listWarehouses(plantId) {
  return await prisma.mtWarehouse.findMany({
    where: { plantId },
    include: {
      stocks: {
        include: {
          sparePart: {
            select: { id: true, code: true, name: true, unit: true, minStock: true, maxStock: true },
          },
        },
      },
    },
    orderBy: { name: "asc" },
  });
}

export async function getWarehouse(warehouseId, plantId) {
  const warehouse = await prisma.mtWarehouse.findUnique({
    where: { id: warehouseId },
    include: {
      stocks: {
        include: {
          sparePart: {
            select: { id: true, code: true, name: true, unit: true, minStock: true, maxStock: true, costPerUnit: true },
          },
        },
      },
    },
  });

  if (!warehouse || warehouse.plantId !== plantId) {
    return null;
  }

  return warehouse;
}

// ============================================================
// STOCK SERVICE
// ============================================================

export async function getOrCreateStock(warehouseId, sparePartId, plantId) {
  // Verify warehouse and spare part belong to same plant
  const [warehouse, sparePart] = await Promise.all([
    prisma.mtWarehouse.findUnique({ where: { id: warehouseId } }),
    prisma.mtSparePart.findUnique({ where: { id: sparePartId } }),
  ]);

  if (!warehouse || warehouse.plantId !== plantId) {
    throw new Error("Warehouse not found in this plant");
  }
  if (!sparePart || sparePart.plantId !== plantId) {
    throw new Error("Spare part not found in this plant");
  }

  return await prisma.mtStock.upsert({
    where: {
      warehouseId_sparePartId: { warehouseId, sparePartId },
    },
    update: {},
    create: {
      warehouseId,
      sparePartId,
      quantity: 0,
      lastCost: sparePart.costPerUnit,
    },
  });
}

export async function getStock(stockId, plantId) {
  const stock = await prisma.mtStock.findUnique({
    where: { id: stockId },
    include: {
      warehouse: { select: { id: true, name: true, plantId: true } },
      sparePart: { select: { id: true, code: true, name: true, unit: true, costPerUnit: true } },
      movements: {
        take: -20, // Last 20 movements
        orderBy: { createdAt: "desc" },
        include: {
          createdBy: { select: { id: true, name: true } },
        },
      },
    },
  });

  if (!stock || stock.warehouse.plantId !== plantId) {
    return null;
  }

  return stock;
}

export async function listStockByWarehouse(warehouseId, plantId) {
  const warehouse = await prisma.mtWarehouse.findUnique({
    where: { id: warehouseId },
  });

  if (!warehouse || warehouse.plantId !== plantId) {
    return null;
  }

  const result = await prisma.mtStock.findMany({
    where: { warehouseId },
    include: {
      sparePart: {
        select: {
          id: true,
          code: true,
          name: true,
          unit: true,
          minStock: true,
          maxStock: true,
          costPerUnit: true,
          category: true,
        },
      },
    },
    orderBy: { sparePart: { code: "asc" } },
  });

  if (result.length > 0) {
    console.log('[listStockByWarehouse] Primer stock con fechas:', {
      id: result[0].id,
      createdAt: result[0].createdAt,
      updatedAt: result[0].updatedAt,
    });
  }

  return result;
}

// ============================================================
// STOCK MOVEMENT SERVICE
// ============================================================

export async function recordStockMovement(stockId, type, quantity, plantId, userId, data = {}) {
  const { reason, costPerUnit, referenceId, referenceType } = data;

  const stock = await prisma.mtStock.findUnique({
    where: { id: stockId },
    include: {
      warehouse: { select: { plantId: true } },
      sparePart: { select: { costPerUnit: true, status: true } },
    },
  });

  if (!stock || stock.warehouse.plantId !== plantId) {
    throw new Error("Stock not found in this plant");
  }

  if (stock.sparePart.status !== "ACTIVE") {
    throw new Error("Cannot use inactive spare part");
  }

  // Validate quantity
  if (type === "OUT" && stock.quantity < quantity) {
    throw new Error(`Insufficient stock. Available: ${stock.quantity}, Requested: ${quantity}`);
  }

  if (type === "ADJUST" && !reason) {
    throw new Error("Reason is required for stock adjustments");
  }

  // Record movement in transaction
  return await prisma.$transaction(async (tx) => {
    // Record movement
    const movement = await tx.mtStockMovement.create({
      data: {
        stockId,
        type,
        quantity,
        reason,
        costPerUnit: costPerUnit || stock.sparePart.costPerUnit || 0,
        referenceId,
        referenceType,
        createdById: userId,
      },
    });

    // Update stock quantity
    let newQuantity = stock.quantity;
    if (type === "IN" || type === "ADJUST") {
      newQuantity += quantity;
    } else if (type === "OUT" || type === "TRANSFER") {
      newQuantity -= quantity;
    }

    await tx.mtStock.update({
      where: { id: stockId },
      data: {
        quantity: newQuantity,
        lastCost: costPerUnit || stock.sparePart.costPerUnit,
        version: { increment: 1 },
      },
    });

    return movement;
  });
}

export async function recordSparePartConsumption(workOrderId, sparePartId, quantity, costPerUnit, plantId, userId) {
  // Get stock for this spare part (use first warehouse available or create in default)
  const [workOrder, sparePart] = await Promise.all([
    prisma.mtWorkOrder.findUnique({
      where: { id: workOrderId },
      select: { plantId: true, id: true },
    }),
    prisma.mtSparePart.findUnique({
      where: { id: sparePartId },
      select: { plantId: true, costPerUnit: true },
    }),
  ]);

  if (!workOrder || workOrder.plantId !== plantId) {
    throw new Error("Work order not found");
  }
  if (!sparePart || sparePart.plantId !== plantId) {
    throw new Error("Spare part not found");
  }

  // Find or create warehouse
  let warehouse = await prisma.mtWarehouse.findFirst({
    where: { plantId },
  });

  if (!warehouse) {
    warehouse = await prisma.mtWarehouse.create({
      data: {
        plantId,
        name: "Almacén Principal",
      },
    });
  }

  // Get or create stock
  const stock = await getOrCreateStock(warehouse.id, sparePartId, plantId);

  // Record consumption as OUT movement
  const movement = await recordStockMovement(stock.id, "OUT", quantity, plantId, userId, {
    reason: `Consumed in work order MT-${plantId}-*-${workOrder.id}`,
    costPerUnit: costPerUnit || sparePart.costPerUnit,
    referenceId: workOrderId,
    referenceType: "WORK_ORDER",
  });

  // Record in work order parts
  await prisma.mtWorkOrderPart.create({
    data: {
      workOrderId,
      sparePartId,
      quantity,
      costPerUnitAtTime: costPerUnit || sparePart.costPerUnit,
    },
  });

  return movement;
}

export async function getStockMovementHistory(stockId, plantId, limit = 50) {
  const stock = await prisma.mtStock.findUnique({
    where: { id: stockId },
    select: { warehouse: { select: { plantId: true } } },
  });

  if (!stock || stock.warehouse.plantId !== plantId) {
    return null;
  }

  return await prisma.mtStockMovement.findMany({
    where: { stockId },
    include: {
      createdBy: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

// Get low stock alerts
export async function getLowStockAlerts(plantId) {
  return await prisma.mtStock.findMany({
    where: {
      warehouse: { plantId },
      sparePart: { status: "ACTIVE" },
    },
    select: {
      id: true,
      quantity: true,
      warehouse: { select: { id: true, name: true } },
      sparePart: {
        select: {
          id: true,
          code: true,
          name: true,
          unit: true,
          minStock: true,
          maxStock: true,
        },
      },
    },
  });
}
