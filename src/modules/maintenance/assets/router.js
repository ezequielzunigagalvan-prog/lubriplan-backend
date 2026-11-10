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

    let whereClause = `WHERE "plantid" = ${plantId} AND "deletedat" IS NULL`;
    if (parentId) whereClause += ` AND "parentid" = ${parseInt(parentId)}`;
    if (status) whereClause += ` AND "status" = '${status}'`;
    if (search) {
      const searchTerm = search.replace(/'/g, "''");
      whereClause += ` AND ("code" ILIKE '%${searchTerm}%' OR "name" ILIKE '%${searchTerm}%')`;
    }

    const assets = await prisma.$queryRawUnsafe(`
      SELECT "id", "code", "name", "level", "status", "criticality", "parentid", "createdat"
      FROM "MtAsset"
      ${whereClause}
      ORDER BY "createdat" DESC
      LIMIT ${limitNum} OFFSET ${skip}
    `);

    const countResult = await prisma.$queryRawUnsafe(`
      SELECT COUNT(*) as total FROM "MtAsset" ${whereClause}
    `);

    const total = parseInt(countResult[0]?.total || 0);

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

    const assets = await prisma.$queryRaw`
      SELECT * FROM "MtAsset"
      WHERE id = ${assetId} AND "plantid" = ${plantId} AND "deletedat" IS NULL
    `;

    const asset = assets?.[0];
    if (!asset) {
      return res.status(404).json({ error: "Asset not found" });
    }

    const recentWOs = await prisma.$queryRaw`
      SELECT id, number, status, type, title, "createdat"
      FROM "MtWorkOrder"
      WHERE "assetid" = ${assetId} AND "plantid" = ${plantId}
      ORDER BY "createdat" DESC
      LIMIT 10
    `;

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

    const result = await prisma.$queryRaw`
      INSERT INTO "MtAsset" (
        "plantid", "parentid", "level", "code", "name", "location",
        "manufacturer", "model", "serialnumber", "installedat",
        "criticality", "status", "notes", "createdat", "updatedat"
      ) VALUES (
        ${plantId}, ${parsed.parentId || null}, ${parsed.level}, ${parsed.code},
        ${parsed.name}, ${parsed.location || null}, ${parsed.manufacturer || null},
        ${parsed.model || null}, ${parsed.serialNumber || null},
        ${parsed.installedAt ? new Date(parsed.installedAt) : null},
        ${parsed.criticality || null}, ${parsed.status}, ${parsed.notes || null},
        NOW(), NOW()
      )
      RETURNING *
    `;

    return res.status(201).json(result[0] || {});
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

    const assets = await prisma.$queryRaw`
      SELECT * FROM "MtAsset"
      WHERE id = ${assetId} AND "plantid" = ${plantId} AND "deletedat" IS NULL
    `;

    if (!assets?.[0]) {
      return res.status(404).json({ error: "Asset not found" });
    }

    const updates = [];
    const allowedFields = {
      name: "name",
      location: "location",
      manufacturer: "manufacturer",
      model: "model",
      serialNumber: "serialnumber",
      criticality: "criticality",
      status: "status",
      notes: "notes"
    };

    for (const [key, dbCol] of Object.entries(allowedFields)) {
      if (key in req.body) {
        updates.push(`"${dbCol}" = ${req.body[key] === null ? "NULL" : `'${String(req.body[key]).replace(/'/g, "''")}'`}`);
      }
    }

    if ("installedAt" in req.body) {
      const date = req.body.installedAt ? `'${new Date(req.body.installedAt).toISOString()}'` : "NULL";
      updates.push(`"installedat" = ${date}`);
    }

    if (updates.length === 0) {
      return res.json(assets[0]);
    }

    const updated = await prisma.$queryRawUnsafe(`
      UPDATE "MtAsset"
      SET ${updates.join(", ")}, "updatedat" = NOW()
      WHERE id = ${assetId}
      RETURNING *
    `);

    return res.json(updated[0] || {});
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

    const assets = await prisma.$queryRaw`
      SELECT * FROM "MtAsset"
      WHERE id = ${assetId} AND "plantid" = ${plantId} AND "deletedat" IS NULL
    `;

    if (!assets?.[0]) {
      return res.status(404).json({ error: "Asset not found" });
    }

    const woCount = await prisma.$queryRaw`
      SELECT COUNT(*) as total FROM "MtWorkOrder"
      WHERE "assetid" = ${assetId} AND "plantid" = ${plantId}
      AND status NOT IN ('VALIDATED', 'REJECTED', 'CANCELLED')
    `;

    if (parseInt(woCount[0]?.total || 0) > 0) {
      return res.status(409).json({ error: "Cannot delete asset with open work orders" });
    }

    const deleted = await prisma.$queryRaw`
      UPDATE "MtAsset"
      SET "deletedat" = NOW(), "updatedat" = NOW()
      WHERE id = ${assetId}
      RETURNING *
    `;

    return res.json({ message: "Asset soft-deleted", asset: deleted[0] || {} });
  } catch (err) {
    logger.error("[assets DELETE]", err);
    return res.status(500).json({ error: "Error deleting asset" });
  }
});

// Mount history subrouter
router.use(historyRouter);

export default router;
