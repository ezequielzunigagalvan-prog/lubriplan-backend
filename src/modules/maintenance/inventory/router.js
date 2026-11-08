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
} from "./service.js";

const router = Router();

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

// ============================================================
// STOCK MOVEMENT ENDPOINTS
// ============================================================

// POST /api/maintenance/inventory/movements - Record stock movement
router.post("/movements", requireRole(["ADMIN", "SUPERVISOR", "TECHNICIAN"]), async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const userId = req.user.id;
    const { stockId, type, quantity, reason, costPerUnit, referenceId, referenceType } = req.body;

    if (!stockId || !type || !quantity) {
      return res.status(422).json({ error: "Missing required fields: stockId, type, quantity" });
    }

    const movement = await recordStockMovement(
      parseInt(stockId),
      type,
      parseFloat(quantity),
      plantId,
      userId,
      { reason, costPerUnit: costPerUnit ? parseFloat(costPerUnit) : null, referenceId, referenceType }
    );

    res.status(201).json(movement);
  } catch (error) {
    logger.error("[POST /movements]", error);
    const statusCode = error.message.includes("Insufficient") ? 400 : 500;
    res.status(statusCode).json({ error: error.message });
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
    const { workOrderId, sparePartId, quantity, costPerUnit } = req.body;

    if (!workOrderId || !sparePartId || !quantity) {
      return res.status(422).json({ error: "Missing required fields: workOrderId, sparePartId, quantity" });
    }

    const movement = await recordSparePartConsumption(
      parseInt(workOrderId),
      parseInt(sparePartId),
      parseFloat(quantity),
      costPerUnit ? parseFloat(costPerUnit) : null,
      plantId,
      userId
    );

    res.status(201).json(movement);
  } catch (error) {
    logger.error("[POST /consume]", error);
    const statusCode = error.message.includes("not found") ? 404 : 500;
    res.status(statusCode).json({ error: error.message });
  }
});

// ============================================================
// ALERTS ENDPOINT
// ============================================================

// GET /api/maintenance/inventory/alerts/low-stock
router.get("/alerts/low-stock", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const alerts = await getLowStockAlerts(plantId);

    const filtered = alerts.filter((item) => item.quantity < item.sparePart.minStock);

    res.json({
      alerts: filtered,
      total: filtered.length,
    });
  } catch (error) {
    logger.error("[GET /alerts/low-stock]", error);
    res.status(500).json({ error: "Error fetching alerts" });
  }
});

export default router;
