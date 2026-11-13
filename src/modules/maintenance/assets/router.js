import express from "express";
import { z } from "zod";
import prisma from "../../../prisma.js";
import { logger } from "../../../config/logger.js";
import { canDeleteAsset } from "../permissions.js";
import historyRouter from "./historyRouter.js";

const router = express.Router();

const createAssetSchema = z.object({
  parentId: z.number().nullable().optional(),
  level: z.enum(["AREA", "LINE", "EQUIPMENT", "SUBASSEMBLY", "COMPONENT"]),
  code: z.string().min(1),
  name: z.string().min(1),
  location: z.string().optional(),
  manufacturer: z.string().optional(),
  model: z.string().optional(),
  serialNumber: z.string().optional(),
  installedAt: z.string().datetime().optional(),
  criticality: z.enum(["A", "B", "C"]).optional(),
  status: z.enum(["OPERATING", "STOPPED", "OUT_OF_SERVICE"]).default("OPERATING"),
  notes: z.string().optional(),
});

router.get("/", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const { search, parentId, status, page = 1, limit = 50 } = req.query;

    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 50));
    const skip = (pageNum - 1) * limitNum;

    const where = {
      plantId,
      deletedAt: null,
    };
    if (parentId) where.parentId = parseInt(parentId);
    if (status) where.status = status;

    console.log(`[ASSETS GET] Query params:`, { search, parentId, status, page, limit });
    console.log(`[ASSETS GET] Where clause:`, where);

    const assets = await prisma.mtAsset.findMany({
      where,
      select: {
        id: true,
        code: true,
        name: true,
        level: true,
        status: true,
        criticality: true,
        parentId: true,
        location: true,
        manufacturer: true,
        model: true,
        serialNumber: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limitNum,
    });

    console.log(`[ASSETS GET] Assets found:`, assets.length);
    if (assets.length > 0) {
      console.log(`[ASSETS GET] First asset:`, JSON.stringify(assets[0], null, 2));
    }

    // Filter by search term if provided
    const filtered = search
      ? assets.filter(a =>
          a.code?.toLowerCase().includes(search.toLowerCase()) ||
          a.name?.toLowerCase().includes(search.toLowerCase())
        )
      : assets;

    console.log(`[ASSETS GET] After filter:`, filtered.length);
    if (filtered.length > 0) {
      console.log(`[ASSETS GET] First filtered asset:`, JSON.stringify(filtered[0], null, 2));
    }

    const total = await prisma.mtAsset.count({ where });

    return res.json({
      data: filtered,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum),
    });
  } catch (err) {
    logger.error("[assets GET]", err);
    return res.status(500).json({ error: "Error fetching assets" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const assetId = parseInt(req.params.id);

    const asset = await prisma.mtAsset.findFirst({
      where: {
        id: assetId,
        plantId,
        deletedAt: null,
      },
    });

    if (!asset) {
      return res.status(404).json({ error: "Asset not found" });
    }

    const recentWorkOrders = await prisma.mtWorkOrder.findMany({
      where: {
        assetId,
        plantId,
      },
      select: {
        id: true,
        number: true,
        status: true,
        type: true,
        title: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    return res.json({ asset, recentWorkOrders });
  } catch (err) {
    logger.error("[assets/:id GET]", err);
    return res.status(500).json({ error: "Error fetching asset" });
  }
});

router.post("/", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const parsed = createAssetSchema.parse(req.body);

    if (parsed.installedAt && isNaN(Date.parse(parsed.installedAt))) {
      return res.status(400).json({ error: "Invalid installedAt date" });
    }

    const result = await prisma.mtAsset.create({
      data: {
        plantId,
        parentId: parsed.parentId || null,
        level: parsed.level,
        code: parsed.code,
        name: parsed.name,
        location: parsed.location || null,
        manufacturer: parsed.manufacturer || null,
        model: parsed.model || null,
        serialNumber: parsed.serialNumber || null,
        installedAt: parsed.installedAt ? new Date(parsed.installedAt) : null,
        criticality: parsed.criticality || null,
        status: parsed.status,
        notes: parsed.notes || null,
      },
    });

    return res.status(201).json(result);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors[0]?.message });
    }
    if (err.message?.includes("duplicate")) {
      return res.status(409).json({ error: "Asset code already exists in this plant" });
    }
    logger.error("[assets POST]", err);
    return res.status(500).json({ error: "Error creating asset" });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const assetId = parseInt(req.params.id);

    console.log(`[ASSETS PATCH] Request received for asset ${assetId}`, {
      plantId,
      body: req.body,
      bodyKeys: Object.keys(req.body)
    });

    const asset = await prisma.mtAsset.findFirst({
      where: {
        id: assetId,
        plantId,
        deletedAt: null,
      },
    });

    if (!asset) {
      console.log(`[ASSETS PATCH] Asset ${assetId} not found`);
      return res.status(404).json({ error: "Asset not found" });
    }

    console.log(`[ASSETS PATCH] Found asset:`, {
      id: asset.id,
      code: asset.code,
      name: asset.name,
      status: asset.status
    });

    const updateData = {};
    const allowedFields = ["code", "name", "location", "manufacturer", "model", "serialNumber", "criticality", "status", "notes"];

    for (const field of allowedFields) {
      if (field in req.body) {
        updateData[field] = req.body[field];
        console.log(`[ASSETS PATCH] Adding field ${field} = ${JSON.stringify(req.body[field])}`);
      }
    }

    if ("installedAt" in req.body) {
      updateData.installedAt = req.body.installedAt ? new Date(req.body.installedAt) : null;
      console.log(`[ASSETS PATCH] Adding installedAt`);
    }

    console.log(`[ASSETS PATCH] Update data:`, updateData);
    console.log(`[ASSETS PATCH] Update data keys count:`, Object.keys(updateData).length);

    if (Object.keys(updateData).length === 0) {
      console.log(`[ASSETS PATCH] No fields to update, returning current asset`);
      return res.json(asset);
    }

    console.log(`[ASSETS PATCH] Calling Prisma update with:`, updateData);

    const updated = await prisma.mtAsset.update({
      where: { id: assetId },
      data: updateData,
    });

    console.log(`[ASSETS PATCH] Update successful - datos devueltos:`, JSON.stringify(updated, null, 2));

    // Verificar que los datos fueron guardados en la BD
    const verify = await prisma.mtAsset.findUnique({
      where: { id: assetId },
    });

    console.log(`[ASSETS PATCH] Verificación en BD:`, JSON.stringify(verify, null, 2));

    return res.json(updated);
  } catch (err) {
    console.error(`[ASSETS PATCH] Error occurred:`, err);
    logger.error("[assets PATCH]", err);
    return res.status(500).json({ error: "Error updating asset", details: err.message });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    if (!canDeleteAsset(req.user)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    const plantId = req.currentPlantId;
    const assetId = parseInt(req.params.id);

    const asset = await prisma.mtAsset.findFirst({
      where: {
        id: assetId,
        plantId,
        deletedAt: null,
      },
    });

    if (!asset) {
      return res.status(404).json({ error: "Asset not found" });
    }

    const woCount = await prisma.mtWorkOrder.count({
      where: {
        assetId,
        plantId,
        status: {
          notIn: ["VALIDATED", "REJECTED", "CANCELLED"],
        },
      },
    });

    if (woCount > 0) {
      return res.status(409).json({ error: "Cannot delete asset with open work orders" });
    }

    const deleted = await prisma.mtAsset.update({
      where: { id: assetId },
      data: {
        deletedAt: new Date(),
      },
    });

    return res.json({ message: "Asset soft-deleted", asset: deleted });
  } catch (err) {
    logger.error("[assets DELETE]", err);
    return res.status(500).json({ error: "Error deleting asset" });
  }
});

// Mount history subrouter
router.use(historyRouter);

export default router;
