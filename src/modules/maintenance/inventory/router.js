import { Router } from "express";
import { requireRole } from "../../../middleware/requireRole.js";
import { logger } from "../../../config/logger.js";
import {
  createWarehouse,
  listWarehouses,
  getWarehouse,
  getOrCreateStock,
  getStock,
  listStockByWarehouse,
  recordStockMovement,
  recordSparePartConsumption,
  getStockMovementHistory,
  getLowStockAlerts,
  getInventoryOverview,
  setStockQuantity,
  InventoryError,
} from "./service.js";

const router = Router();

/** Responde con el código del InventoryError (400/404/409) o 500 si es inesperado. */
function sendError(res, error, tag, fallback) {
  if (error instanceof InventoryError) return res.status(error.status).json({ error: error.message });
  logger.error(tag, error);
  return res.status(500).json({ error: fallback });
}

// GET /api/maintenance/inventory/overview — catálogo con existencias por almacén e indicadores
router.get("/overview", async (req, res) => {
  try {
    res.json({ data: await getInventoryOverview(req.currentPlantId) });
  } catch (error) {
    logger.error("[GET /inventory/overview]", error);
    res.status(500).json({ error: "Error fetching inventory" });
  }
});

// ============================================================
// WAREHOUSE ENDPOINTS
// ============================================================

// POST /api/maintenance/inventory/warehouses
router.post("/warehouses", requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const { name, location } = req.body;

    if (!name) {
      return res.status(422).json({ error: "Missing required field: name" });
    }

    const warehouse = await createWarehouse(plantId, name, location);
    res.status(201).json(warehouse);
  } catch (error) {
    logger.error("[POST /warehouses]", error);
    if (error.message.includes("already exists")) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: "Error creating warehouse" });
  }
});

// GET /api/maintenance/inventory/warehouses
router.get("/warehouses", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const warehouses = await listWarehouses(plantId);
    res.json(warehouses);
  } catch (error) {
    logger.error("[GET /warehouses]", error);
    res.status(500).json({ error: "Error listing warehouses" });
  }
});

// GET /api/maintenance/inventory/warehouses/:id
router.get("/warehouses/:id", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const warehouse = await getWarehouse(parseInt(req.params.id), plantId);

    if (!warehouse) {
      return res.status(404).json({ error: "Warehouse not found" });
    }

    res.json(warehouse);
  } catch (error) {
    logger.error("[GET /warehouses/:id]", error);
    res.status(500).json({ error: "Error fetching warehouse" });
  }
});

// ============================================================
// STOCK ENDPOINTS
// ============================================================

// POST /api/maintenance/inventory/stock - Get or create stock entry
router.post("/stock", requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const { warehouseId, sparePartId } = req.body;

    if (!warehouseId || !sparePartId) {
      return res.status(422).json({ error: "Missing required fields: warehouseId, sparePartId" });
    }

    const stock = await getOrCreateStock(parseInt(warehouseId), parseInt(sparePartId), plantId);
    res.status(201).json(stock);
  } catch (error) {
    logger.error("[POST /stock]", error);
    res.status(400).json({ error: error.message });
  }
});

// GET /api/maintenance/inventory/stock/:id
router.get("/stock/:id", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const stock = await getStock(parseInt(req.params.id), plantId);

    if (!stock) {
      return res.status(404).json({ error: "Stock not found" });
    }

    res.json(stock);
  } catch (error) {
    logger.error("[GET /stock/:id]", error);
    res.status(500).json({ error: "Error fetching stock" });
  }
});

// GET /api/maintenance/inventory/warehouses/:warehouseId/stock
router.get("/warehouses/:warehouseId/stock", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const stock = await listStockByWarehouse(parseInt(req.params.warehouseId), plantId);

    if (stock === null) {
      return res.status(404).json({ error: "Warehouse not found" });
    }

    res.json(stock);
  } catch (error) {
    logger.error("[GET /warehouses/:warehouseId/stock]", error);
    res.status(500).json({ error: "Error listing stock" });
  }
});

// PATCH /api/maintenance/inventory/stock/:id — fija la existencia (conteo físico) registrando un ajuste
router.patch("/stock/:id", requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
  try {
    const { quantity, reason } = req.body;
    if (quantity === undefined || quantity === null || quantity === "") {
      return res.status(422).json({ error: "Missing required field: quantity" });
    }
    const updated = await setStockQuantity(parseInt(req.params.id, 10), quantity, req.currentPlantId, req.user.id, reason);
    res.json(updated);
  } catch (error) {
    sendError(res, error, "[PATCH /stock/:id]", "Error updating stock");
  }
});

// ============================================================
// STOCK MOVEMENT ENDPOINTS
// ============================================================

// POST /api/maintenance/inventory/movements - Record stock movement
router.post("/movements", requireRole(["ADMIN", "SUPERVISOR", "TECHNICIAN"]), async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const userId = req.user.id;
    const { stockId, type, quantity, reason, costPerUnit, referenceId, referenceType } = req.body;

    if (!stockId || !type || quantity === undefined || quantity === null || quantity === "") {
      return res.status(422).json({ error: "Missing required fields: stockId, type, quantity" });
    }
    // Las salidas por OT van por /consume (registran la refacción en la orden)
    if (referenceType === "WORK_ORDER") {
      return res.status(400).json({ error: "Use /inventory/consume to register parts used in a work order" });
    }

    const movement = await recordStockMovement(
      parseInt(stockId, 10),
      type,
      quantity,
      plantId,
      userId,
      { reason, costPerUnit: costPerUnit !== undefined && costPerUnit !== "" ? costPerUnit : null, referenceId, referenceType }
    );

    res.status(201).json(movement);
  } catch (error) {
    sendError(res, error, "[POST /movements]", "Error recording movement");
  }
});

// GET /api/maintenance/inventory/stock/:stockId/movements
router.get("/stock/:stockId/movements", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const limit = Math.min(parseInt(req.query.limit || 50), 200);

    const movements = await getStockMovementHistory(parseInt(req.params.stockId), plantId, limit);

    if (movements === null) {
      return res.status(404).json({ error: "Stock not found" });
    }

    res.json(movements);
  } catch (error) {
    logger.error("[GET /stock/:stockId/movements]", error);
    res.status(500).json({ error: "Error fetching movements" });
  }
});

// ============================================================
// WORK ORDER PARTS ENDPOINT
// ============================================================

// POST /api/maintenance/inventory/consume - Record spare part consumption in work order
router.post("/consume", requireRole(["ADMIN", "SUPERVISOR", "TECHNICIAN"]), async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const userId = req.user.id;
    const { workOrderId, sparePartId, quantity, costPerUnit, warehouseId } = req.body;

    if (!workOrderId || !sparePartId || !quantity) {
      return res.status(422).json({ error: "Missing required fields: workOrderId, sparePartId, quantity" });
    }

    const movement = await recordSparePartConsumption(
      parseInt(workOrderId),
      parseInt(sparePartId),
      parseFloat(quantity),
      costPerUnit ? parseFloat(costPerUnit) : null,
      plantId,
      userId,
      warehouseId ? parseInt(warehouseId, 10) : null
    );

    res.status(201).json(movement);
  } catch (error) {
    sendError(res, error, "[POST /consume]", "Error registering consumption");
  }
});

// ============================================================
// ALERTS ENDPOINT
// ============================================================

// GET /api/maintenance/inventory/alerts/low-stock
router.get("/alerts/low-stock", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    // Las comparaciones se hacen con números en el servicio (Decimal < Decimal comparaba texto: "10" < "9")
    const alerts = await getLowStockAlerts(plantId);
    res.json({ alerts, total: alerts.length });
  } catch (error) {
    logger.error("[GET /alerts/low-stock]", error);
    res.status(500).json({ error: "Error fetching alerts" });
  }
});

export default router;
