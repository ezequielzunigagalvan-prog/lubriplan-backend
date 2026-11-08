import express from "express";
import { z } from "zod";
import prisma from "../../../prisma.js";
import { logger } from "../../../config/logger.js";
import { canDeleteAsset } from "../permissions.js";

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

    const where = { plantId, deletedAt: null };
    if (search) where.OR = [
      { code: { contains: search, mode: "insensitive" } },
      { name: { contains: search, mode: "insensitive" } },
    ];
    if (parentId) where.parentId = parseInt(parentId);
    if (status) where.status = status;

    const [assets, total] = await Promise.all([
      prisma.mtAsset.findMany({
        where,
        select: {
          id: true,
          code: true,
          name: true,
          level: true,
          status: true,
          criticality: true,
          parentId: true,
          createdAt: true,
        },
        skip,
        take: limitNum,
        orderBy: { createdAt: "desc" },
      }),
      prisma.mtAsset.count({ where }),
    ]);

    return res.json({
      data: assets,
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
      where: { id: assetId, plantId, deletedAt: null },
    });

    if (!asset) {
      return res.status(404).json({ error: "Asset not found" });
    }

    const recentWOs = await prisma.mtWorkOrder.findMany({
      where: { assetId, plantId },
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

    return res.json({ asset, recentWorkOrders: recentWOs });
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

    const asset = await prisma.mtAsset.create({
      data: {
        plantId,
        ...parsed,
        installedAt: parsed.installedAt ? new Date(parsed.installedAt) : null,
      },
    });

    return res.status(201).json(asset);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors[0]?.message });
    }
    if (err.code === "P2002") {
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

    const asset = await prisma.mtAsset.findFirst({
      where: { id: assetId, plantId, deletedAt: null },
    });

    if (!asset) {
      return res.status(404).json({ error: "Asset not found" });
    }

    const updateData = {};
    const allowedFields = ["name", "location", "manufacturer", "model", "serialNumber", "criticality", "status", "notes"];

    for (const field of allowedFields) {
      if (field in req.body) {
        updateData[field] = req.body[field];
      }
    }

    if ("installedAt" in req.body) {
      updateData.installedAt = req.body.installedAt ? new Date(req.body.installedAt) : null;
    }

    const updated = await prisma.mtAsset.update({
      where: { id: assetId },
      data: updateData,
    });

    return res.json(updated);
  } catch (err) {
    logger.error("[assets PATCH]", err);
    return res.status(500).json({ error: "Error updating asset" });
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
      where: { id: assetId, plantId, deletedAt: null },
    });

    if (!asset) {
      return res.status(404).json({ error: "Asset not found" });
    }

    const openWOs = await prisma.mtWorkOrder.count({
      where: {
        assetId,
        plantId,
        status: { notIn: ["VALIDATED", "REJECTED", "CANCELLED"] },
      },
    });

    if (openWOs > 0) {
      return res.status(409).json({ error: "Cannot delete asset with open work orders" });
    }

    const deleted = await prisma.mtAsset.update({
      where: { id: assetId },
      data: { deletedAt: new Date() },
    });

    return res.json({ message: "Asset soft-deleted", asset: deleted });
  } catch (err) {
    logger.error("[assets DELETE]", err);
    return res.status(500).json({ error: "Error deleting asset" });
  }
});

export default router;
