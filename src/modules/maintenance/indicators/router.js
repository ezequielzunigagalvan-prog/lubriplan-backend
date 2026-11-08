import { Router } from "express";
import { logger } from "../../../config/logger.js";
import {
  calculateWorkOrderCost,
  getCostsByPeriod,
  calculateMTTR,
  calculateMTBF,
  getRecurrence,
  calculateAvailability,
  getTopAssets,
  getDashboardSummary,
} from "./service.js";

const router = Router();

// GET /api/maintenance/indicators/dashboard
router.get("/dashboard", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const summary = await getDashboardSummary(plantId);
    res.json(summary);
  } catch (error) {
    logger.error("[GET /indicators/dashboard]", error);
    res.status(500).json({ error: "Error fetching dashboard" });
  }
});

// GET /api/maintenance/indicators/costs
router.get("/costs", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const { startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), endDate = new Date() } =
      req.query;

    const costs = await getCostsByPeriod(plantId, new Date(startDate), new Date(endDate));
    res.json(costs);
  } catch (error) {
    logger.error("[GET /costs]", error);
    res.status(500).json({ error: "Error calculating costs" });
  }
});

// GET /api/maintenance/indicators/work-orders/:id/cost
router.get("/work-orders/:id/cost", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const cost = await calculateWorkOrderCost(parseInt(req.params.id), plantId);

    if (!cost) {
      return res.status(404).json({ error: "Work order not found" });
    }

    res.json(cost);
  } catch (error) {
    logger.error("[GET /work-orders/:id/cost]", error);
    res.status(500).json({ error: "Error calculating cost" });
  }
});

// GET /api/maintenance/indicators/mttr
router.get("/mttr", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const { days = 30 } = req.query;

    const mttr = await calculateMTTR(plantId, parseInt(days));
    res.json(mttr);
  } catch (error) {
    logger.error("[GET /mttr]", error);
    res.status(500).json({ error: "Error calculating MTTR" });
  }
});

// GET /api/maintenance/indicators/assets/:id/mtbf
router.get("/assets/:id/mtbf", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const mtbf = await calculateMTBF(parseInt(req.params.id), plantId);

    if (!mtbf) {
      return res.status(404).json({ error: "Asset not found" });
    }

    res.json(mtbf);
  } catch (error) {
    logger.error("[GET /assets/:id/mtbf]", error);
    res.status(500).json({ error: "Error calculating MTBF" });
  }
});

// GET /api/maintenance/indicators/assets/:id/availability
router.get("/assets/:id/availability", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const { days = 30 } = req.query;

    const availability = await calculateAvailability(
      parseInt(req.params.id),
      plantId,
      parseInt(days)
    );

    if (!availability) {
      return res.status(404).json({ error: "Asset not found" });
    }

    res.json(availability);
  } catch (error) {
    logger.error("[GET /assets/:id/availability]", error);
    res.status(500).json({ error: "Error calculating availability" });
  }
});

// GET /api/maintenance/indicators/recurrence
router.get("/recurrence", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const { days = 30 } = req.query;

    const recurrence = await getRecurrence(plantId, parseInt(days));
    res.json(recurrence);
  } catch (error) {
    logger.error("[GET /recurrence]", error);
    res.status(500).json({ error: "Error calculating recurrence" });
  }
});

// GET /api/maintenance/indicators/top-assets
router.get("/top-assets", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const { metric = "cost", limit = 10, days = 30 } = req.query;

    const topAssets = await getTopAssets(plantId, metric, parseInt(limit), parseInt(days));
    res.json(topAssets);
  } catch (error) {
    logger.error("[GET /top-assets]", error);
    res.status(500).json({ error: "Error fetching top assets" });
  }
});

export default router;
