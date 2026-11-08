import { Router } from "express";
import { requireRole } from "../../../middleware/requireRole.js";
import { logger } from "../../../config/logger.js";
import {
  createSparePart,
  getSparePart,
  listSpareParts,
  updateSparePart,
  linkSparePartToAsset,
  getSparePartsForAsset,
} from "./service.js";

const router = Router();

// POST /api/maintenance/spare-parts - Create spare part
router.post("/", requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const { code, name, description, category, brand, partNumber, unit, minStock, maxStock, location, costPerUnit } = req.body;

    if (!code || !name) {
      return res.status(422).json({ error: "Missing required fields: code, name" });
    }

    const sparePart = await createSparePart(plantId, {
      code,
      name,
      description,
      category,
      brand,
      partNumber,
      unit,
      minStock,
      maxStock,
      location,
      costPerUnit,
    });

    res.status(201).json(sparePart);
  } catch (error) {
    logger.error("[POST /spare-parts]", error);
    if (error.message.includes("already exists")) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: "Error creating spare part" });
  }
});

// GET /api/maintenance/spare-parts - List spare parts
router.get("/", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const { status, category, search, skip = 0, take = 50 } = req.query;

    const result = await listSpareParts(
      plantId,
      { status, category, search },
      { skip: parseInt(skip), take: Math.min(parseInt(take), 100) }
    );

    res.json(result);
  } catch (error) {
    logger.error("[GET /spare-parts]", error);
    res.status(500).json({ error: "Error listing spare parts" });
  }
});

// GET /api/maintenance/spare-parts/:id - Get spare part
router.get("/:id", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const sparePart = await getSparePart(parseInt(req.params.id), plantId);

    if (!sparePart) {
      return res.status(404).json({ error: "Spare part not found" });
    }

    res.json(sparePart);
  } catch (error) {
    logger.error("[GET /spare-parts/:id]", error);
    res.status(500).json({ error: "Error fetching spare part" });
  }
});

// PATCH /api/maintenance/spare-parts/:id - Update spare part
router.patch("/:id", requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const sparePart = await updateSparePart(parseInt(req.params.id), plantId, req.body);

    if (!sparePart) {
      return res.status(404).json({ error: "Spare part not found" });
    }

    res.json(sparePart);
  } catch (error) {
    logger.error("[PATCH /spare-parts/:id]", error);
    res.status(500).json({ error: "Error updating spare part" });
  }
});

// POST /api/maintenance/spare-parts/:id/assets/:assetId - Link spare part to asset
router.post("/:id/assets/:assetId", requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const link = await linkSparePartToAsset(parseInt(req.params.id), parseInt(req.params.assetId), plantId);

    res.status(201).json(link);
  } catch (error) {
    logger.error("[POST /spare-parts/:id/assets/:assetId]", error);
    res.status(400).json({ error: error.message });
  }
});

// GET /api/maintenance/assets/:assetId/spare-parts - Get spare parts for asset
router.get("/assets/:assetId/spare-parts", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const spareParts = await getSparePartsForAsset(parseInt(req.params.assetId), plantId);

    if (spareParts === null) {
      return res.status(404).json({ error: "Asset not found" });
    }

    res.json(spareParts);
  } catch (error) {
    logger.error("[GET /assets/:assetId/spare-parts]", error);
    res.status(500).json({ error: "Error fetching spare parts for asset" });
  }
});

export default router;
