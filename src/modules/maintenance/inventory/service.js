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

  return await prisma.mtStock.findMany({
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
}

// ============================================================
// STOCK MOVEMENT SERVICE
// ============================================================

const MOVEMENT_TYPES = ["IN", "OUT", "ADJUST", "TRANSFER"];
const CLOSED_WO = ["FINISHED", "VALIDATED", "REJECTED", "CANCELLED"];
const num = (d) => (d == null ? 0 : Number(d));

/** Error con código HTTP para que el router responda 400/404/409 en lugar de 500. */
export class InventoryError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * Registra un movimiento y actualiza la existencia en la misma transacción.
 * - IN: suma `quantity`. OUT/TRANSFER: resta `quantity` (nunca deja negativo).
 * - ADJUST: `quantity` es un delta con signo (+/-) y requiere motivo.
 * Las cantidades se operan como números (stock.quantity es Decimal: sumarlo con `+=` concatenaba texto)
 * y el descuento es atómico (updateMany con condición), así que dos consumos simultáneos no dejan negativos.
 */
export async function recordStockMovement(stockId, type, quantity, plantId, userId, data = {}, client = null) {
  const { reason, costPerUnit, referenceId, referenceType } = data;
  const qty = Number(quantity);

  if (!MOVEMENT_TYPES.includes(type)) throw new InventoryError(`Tipo de movimiento inválido: ${type}`);
  if (!Number.isFinite(qty) || qty === 0) throw new InventoryError("La cantidad debe ser un número distinto de 0");
  if (type !== "ADJUST" && qty < 0) throw new InventoryError("La cantidad debe ser mayor a 0");
  if (type === "ADJUST" && !String(reason || "").trim()) throw new InventoryError("El motivo es obligatorio en un ajuste");

  const run = async (tx) => {
    const stock = await tx.mtStock.findUnique({
      where: { id: stockId },
      include: {
        warehouse: { select: { plantId: true } },
        sparePart: { select: { costPerUnit: true, status: true } },
      },
    });
    if (!stock || stock.warehouse.plantId !== plantId) throw new InventoryError("Existencia no encontrada en esta planta", 404);
    if (stock.sparePart.status !== "ACTIVE") throw new InventoryError("La refacción está inactiva");

    const delta = type === "IN" ? qty : type === "ADJUST" ? qty : -qty;
    const unitCost = costPerUnit != null && Number.isFinite(Number(costPerUnit)) ? Number(costPerUnit) : num(stock.sparePart.costPerUnit);

    if (delta < 0) {
      const { count } = await tx.mtStock.updateMany({
        where: { id: stockId, quantity: { gte: -delta } },
        data: { quantity: { decrement: -delta }, version: { increment: 1 } },
      });
      if (count === 0) {
        const current = await tx.mtStock.findUnique({ where: { id: stockId }, select: { quantity: true } });
        throw new InventoryError(`Existencia insuficiente. Disponible: ${num(current?.quantity)}, solicitado: ${-delta}`, 409);
      }
    } else {
      await tx.mtStock.update({
        where: { id: stockId },
        data: { quantity: { increment: delta }, version: { increment: 1 }, ...(type === "IN" ? { lastCost: unitCost } : {}) },
      });
    }

    return tx.mtStockMovement.create({
      data: {
        stockId,
        type,
        quantity: type === "ADJUST" ? delta : qty,
        reason: reason || null,
        costPerUnit: unitCost,
        referenceId: referenceId ?? null,
        referenceType: referenceType ?? null,
        createdById: userId,
      },
    });
  };

  return client ? run(client) : prisma.$transaction(run);
}

/** Fija la existencia en un valor (conteo físico) registrando un ADJUST por la diferencia. */
export async function setStockQuantity(stockId, newQuantity, plantId, userId, reason) {
  const target = Number(newQuantity);
  if (!Number.isFinite(target) || target < 0) throw new InventoryError("La cantidad debe ser un número mayor o igual a 0");

  return prisma.$transaction(async (tx) => {
    const stock = await tx.mtStock.findUnique({ where: { id: stockId }, include: { warehouse: { select: { plantId: true } } } });
    if (!stock || stock.warehouse.plantId !== plantId) throw new InventoryError("Existencia no encontrada en esta planta", 404);

    const delta = Number((target - num(stock.quantity)).toFixed(4));
    if (delta !== 0) {
      await recordStockMovement(stockId, "ADJUST", delta, plantId, userId, { reason: reason || "Ajuste manual de existencia" }, tx);
    }
    return tx.mtStock.findUnique({ where: { id: stockId }, include: { sparePart: true } });
  });
}

/**
 * Consumo de refacción en una OT: descuenta del almacén indicado o, si no se indica, del que tenga
 * existencia suficiente (el de mayor cantidad), y registra la refacción en la OT. Todo en una transacción.
 */
export async function recordSparePartConsumption(workOrderId, sparePartId, quantity, costPerUnit, plantId, userId, warehouseId = null) {
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) throw new InventoryError("La cantidad debe ser mayor a 0");

  return prisma.$transaction(async (tx) => {
    const [workOrder, sparePart] = await Promise.all([
      tx.mtWorkOrder.findFirst({ where: { id: workOrderId, plantId }, select: { id: true, number: true, status: true } }),
      tx.mtSparePart.findFirst({ where: { id: sparePartId, plantId }, select: { id: true, costPerUnit: true, status: true } }),
    ]);
    if (!workOrder) throw new InventoryError("Orden de trabajo no encontrada", 404);
    if (CLOSED_WO.includes(workOrder.status)) throw new InventoryError(`No se pueden registrar refacciones en una orden ${workOrder.status}`, 409);
    if (!sparePart) throw new InventoryError("Refacción no encontrada", 404);

    const stocks = await tx.mtStock.findMany({
      where: { sparePartId, warehouse: { plantId }, ...(warehouseId ? { warehouseId } : {}) },
      select: { id: true, quantity: true },
    });
    const candidate = stocks.filter((s) => num(s.quantity) >= qty).sort((a, b) => num(b.quantity) - num(a.quantity))[0];
    if (!candidate) {
      const available = stocks.reduce((s, x) => s + num(x.quantity), 0);
      throw new InventoryError(`Existencia insuficiente. Disponible${warehouseId ? " en el almacén" : ""}: ${available}, solicitado: ${qty}`, 409);
    }

    const unitCost = costPerUnit != null && Number.isFinite(Number(costPerUnit)) ? Number(costPerUnit) : num(sparePart.costPerUnit);
    const movement = await recordStockMovement(
      candidate.id,
      "OUT",
      qty,
      plantId,
      userId,
      { reason: `Consumo en OT-${String(workOrder.number).padStart(5, "0")}`, costPerUnit: unitCost, referenceId: workOrderId, referenceType: "WORK_ORDER" },
      tx
    );

    await tx.mtWorkOrderPart.create({
      data: { workOrderId, sparePartId, quantity: qty, costPerUnitAtTime: unitCost },
    });

    return movement;
  });
}

export async function getStockMovementHistory(stockId, plantId, limit = 50) {
  const stock = await prisma.mtStock.findUnique({
    where: { id: stockId },
    include: { warehouse: { select: { plantId: true } } },
  });

  if (!stock || !stock.warehouse || stock.warehouse.plantId !== plantId) {
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

/** Refacciones activas por debajo de su mínimo (sumando todos los almacenes; incluye las que no tienen existencia). */
export async function getLowStockAlerts(plantId) {
  const parts = await prisma.mtSparePart.findMany({
    where: { plantId, status: "ACTIVE", minStock: { gt: 0 } },
    select: {
      id: true, code: true, name: true, unit: true, minStock: true, maxStock: true,
      stocks: { select: { id: true, quantity: true, warehouse: { select: { id: true, name: true } } } },
    },
  });
  return parts
    .map((p) => ({ ...p, totalQuantity: p.stocks.reduce((s, x) => s + num(x.quantity), 0), minStock: num(p.minStock), maxStock: num(p.maxStock) }))
    .filter((p) => p.totalQuantity < p.minStock)
    .map(({ stocks, ...p }) => ({ ...p, warehouses: stocks.map((s) => ({ ...s.warehouse, stockId: s.id, quantity: num(s.quantity) })) }));
}

/**
 * Vista completa del inventario: catálogo de refacciones activas con su existencia por almacén
 * (incluye las que todavía no tienen existencia en ningún almacén), almacenes con totales e indicadores.
 */
export async function getInventoryOverview(plantId) {
  const [warehouses, parts] = await Promise.all([
    prisma.mtWarehouse.findMany({ where: { plantId }, select: { id: true, name: true, location: true }, orderBy: { name: "asc" } }),
    prisma.mtSparePart.findMany({
      where: { plantId, status: "ACTIVE" },
      select: {
        id: true, code: true, name: true, description: true, category: true, brand: true, partNumber: true, unit: true,
        minStock: true, maxStock: true, costPerUnit: true, location: true, updatedAt: true,
        stocks: { select: { id: true, warehouseId: true, quantity: true, updatedAt: true } },
      },
      orderBy: { code: "asc" },
    }),
  ]);

  const items = parts.map((p) => {
    const stocks = p.stocks.map((s) => ({ stockId: s.id, warehouseId: s.warehouseId, quantity: num(s.quantity), updatedAt: s.updatedAt }));
    const total = stocks.reduce((s, x) => s + x.quantity, 0);
    const minStock = num(p.minStock);
    const cost = num(p.costPerUnit);
    const lastUpdate = [p.updatedAt, ...stocks.map((s) => s.updatedAt)].sort((a, b) => b - a)[0];
    return {
      ...p,
      stocks,
      minStock,
      maxStock: num(p.maxStock),
      costPerUnit: cost,
      totalQuantity: total,
      value: Number((total * cost).toFixed(2)),
      // "Bajo" = debajo del mínimo; "agotado" = sin existencia teniendo mínimo definido
      status: minStock > 0 && total === 0 ? "OUT" : minStock > 0 && total < minStock ? "LOW" : "OK",
      lastUpdate,
    };
  });

  const warehouseSummary = warehouses.map((w) => {
    const rows = items.flatMap((i) => i.stocks.filter((s) => s.warehouseId === w.id).map((s) => ({ ...s, cost: i.costPerUnit })));
    return {
      ...w,
      parts: rows.length,
      units: rows.reduce((s, r) => s + r.quantity, 0),
      value: Number(rows.reduce((s, r) => s + r.quantity * r.cost, 0).toFixed(2)),
    };
  });

  return {
    warehouses: warehouseSummary,
    parts: items,
    stats: {
      parts: items.length,
      withoutStock: items.filter((i) => i.stocks.length === 0).length,
      low: items.filter((i) => i.status === "LOW").length,
      out: items.filter((i) => i.status === "OUT").length,
      value: Number(items.reduce((s, i) => s + i.value, 0).toFixed(2)),
    },
  };
}
