import { Router } from "express";
import { requireRole } from "../../../middleware/requireRole.js";
import { logger } from "../../../config/logger.js";
import {
  seedFailureCodesForPlant,
  createFailureCode,
  getFailureCode,
  listFailureCodes,
  updateFailureCode,
  assignFailureToWorkOrder,
  getWorkOrderFailure,
} from "./service.js";

const router = Router();

// POST /api/maintenance/failure-codes/seed - Initialize base failure codes
router.post("/seed", requireRole("ADMIN"), async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const result = await seedFailureCodesForPlant(plantId);

    res.json({
      message: "Failure codes seeded successfully",
      created: result.created,
      skipped: result.skipped,
    });
  } catch (error) {
    logger.error("[POST /seed]", error);
    res.status(500).json({ error: "Error seeding failure codes" });
  }
});

// POST /api/maintenance/failure-codes - Create custom failure code
router.post("/", requireRole("ADMIN", "SUPERVISOR"), async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const { code, name, category, parentId, assetClass } = req.body;

    if (!code || !name || !category) {
      return res.status(422).json({ error: "Missing required fields: code, name, category" });
    }

    const failureCode = await createFailureCode(plantId, {
      code,
      name,
      category,
      parentId,
      assetClass,
    });

    res.status(201).json(failureCode);
  } catch (error) {
    logger.error("[POST /]", error);
    if (error.message.includes("already exists")) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: "Error creating failure code" });
  }
});

// GET /api/maintenance/failure-codes - List all failure codes (hierarchized)
router.get("/", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const { category, status, search, assetClass } = req.query;

    const codes = await listFailureCodes(plantId, {
      category,
      status,
      search,
      assetClass,
    });

    res.json(codes);
  } catch (error) {
    logger.error("[GET /]", error);
    res.status(500).json({ error: "Error listing failure codes" });
  }
});

// GET /api/maintenance/failure-codes/:id - Get single failure code
router.get("/:id", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const code = await getFailureCode(parseInt(req.params.id), plantId);

    if (!code) {
      return res.status(404).json({ error: "Failure code not found" });
    }

    res.json(code);
  } catch (error) {
    logger.error("[GET /:id]", error);
    res.status(500).json({ error: "Error fetching failure code" });
  }
});

// PATCH /api/maintenance/failure-codes/:id - Update custom failure code
router.patch("/:id", requireRole("ADMIN", "SUPERVISOR"), async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const code = await updateFailureCode(parseInt(req.params.id), plantId, req.body);

    if (!code) {
      return res.status(404).json({ error: "Failure code not found" });
    }

    res.json(code);
  } catch (error) {
    logger.error("[PATCH /:id]", error);
    if (error.message.includes("Cannot modify base")) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: "Error updating failure code" });
  }
});

// ============================================================
// WORK ORDER FAILURE ENDPOINTS
// ============================================================

// POST /api/maintenance/work-orders/:workOrderId/failure - Assign failure codes to WO
router.post("/work-orders/:workOrderId/failure", requireRole("ADMIN", "SUPERVISOR", "TECHNICIAN"), async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const { failureModeId, mechanismId, rootCauseId, productionEffect } = req.body;

    const failure = await assignFailureToWorkOrder(
      parseInt(req.params.workOrderId),
      failureModeId ? parseInt(failureModeId) : null,
      mechanismId ? parseInt(mechanismId) : null,
      rootCauseId ? parseInt(rootCauseId) : null,
      productionEffect,
      plantId
    );

    res.json(failure);
  } catch (error) {
    logger.error("[POST /work-orders/:workOrderId/failure]", error);
    const statusCode = error.message.includes("not found") ? 404 : 400;
    res.status(statusCode).json({ error: error.message });
  }
});

// GET /api/maintenance/work-orders/:workOrderId/failure - Get failure for WO
router.get("/work-orders/:workOrderId/failure", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const failure = await getWorkOrderFailure(parseInt(req.params.workOrderId), plantId);

    if (!failure) {
      return res.status(404).json({ error: "No failure record for this work order" });
    }

    res.json(failure);
  } catch (error) {
    logger.error("[GET /work-orders/:workOrderId/failure]", error);
    res.status(500).json({ error: "Error fetching failure" });
  }
});

export default router;
