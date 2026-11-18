import express from "express";
import { z } from "zod";
import prisma from "../../../prisma.js";
import { logger } from "../../../config/logger.js";
import { canDeleteAsset } from "../permissions.js";
import historyRouter from "./historyRouter.js";
import { getAssetExpedient, getAssetHierarchy } from "./expedientService.js";

const router = express.Router();

const LEVELS = ["AREA", "LINE", "EQUIPMENT", "SUBASSEMBLY", "COMPONENT"];
const CRITICALITIES = ["A", "B", "C"];
const STATUSES = ["OPERATING", "STOPPED", "OUT_OF_SERVICE"];
const OPEN_WO_EXCLUDED = ["FINISHED", "VALIDATED", "REJECTED", "CANCELLED"];

// Texto opcional: "" o null se guardan como null
const optionalText = z
  .string()
  .trim()
  .max(500)
  .nullable()
  .optional()
  .transform((v) => (v ? v : v === undefined ? undefined : null));

// Fecha opcional: acepta "YYYY-MM-DD" o ISO completo; "" o null la borran
const optionalDate = z
  .union([z.string(), z.null()])
  .optional()
  .refine((v) => v == null || v === "" || !Number.isNaN(Date.parse(v)), { message: "Fecha de instalación inválida" })
  .transform((v) => (v === undefined ? undefined : v ? new Date(v) : null));

const assetFields = {
  parentId: z.coerce.number().int().positive().nullable().optional(),
  level: z.enum(LEVELS),
  code: z.string().trim().min(1, "El código es requerido").max(50),
  name: z.string().trim().min(1, "El nombre es requerido").max(200),
  location: optionalText,
  manufacturer: optionalText,
  model: optionalText,
  serialNumber: optionalText,
  installedAt: optionalDate,
  criticality: z.enum(CRITICALITIES).nullable().optional(),
  status: z.enum(STATUSES),
  notes: z.string().trim().max(2000).nullable().optional().transform((v) => (v === undefined ? undefined : v || null)),
};

const createAssetSchema = z.object({ ...assetFields, status: assetFields.status.default("OPERATING") });
const updateAssetSchema = z.object(assetFields).partial();

const assetSelect = {
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
  installedAt: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  parent: { select: { id: true, code: true, name: true } },
};

function zodMessage(err) {
  const issue = err.issues?.[0];
  if (!issue) return "Datos inválidos";
  const field = issue.path?.join(".");
  return field ? `${field}: ${issue.message}` : issue.message;
}

function parseId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Valida que el padre exista en la misma planta y que no se forme un ciclo
 * (un activo no puede colgar de sí mismo ni de uno de sus descendientes).
 * Devuelve un mensaje de error o null si es válido.
 */
async function validateParent(plantId, parentId, assetId = null) {
  if (parentId == null) return null;
  if (assetId && parentId === assetId) return "Un activo no puede ser su propio padre";

  let currentId = parentId;
  const seen = new Set();
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const node = await prisma.mtAsset.findFirst({
      where: { id: currentId, plantId, deletedAt: null },
      select: { id: true, parentId: true },
    });
    if (!node) return currentId === parentId ? "El activo padre no existe en esta planta" : null;
    if (assetId && node.parentId === assetId) return "No se puede mover un activo debajo de uno de sus descendientes";
    currentId = node.parentId;
  }
  return null;
}

// GET /api/maintenance/assets?search=&status=&criticality=&level=&parentId=&page=&limit=
router.get("/", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const { search, parentId, status, criticality, level, page = 1, limit = 50 } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(500, Math.max(1, parseInt(limit, 10) || 50));

    const where = { plantId, deletedAt: null };
    if (parentId === "null") where.parentId = null;
    else if (parentId) where.parentId = parseId(parentId) ?? -1;
    if (STATUSES.includes(status)) where.status = status;
    if (CRITICALITIES.includes(criticality)) where.criticality = criticality;
    if (LEVELS.includes(level)) where.level = level;
    if (search?.trim()) {
      const term = search.trim();
      where.OR = [
        { code: { contains: term, mode: "insensitive" } },
        { name: { contains: term, mode: "insensitive" } },
        { location: { contains: term, mode: "insensitive" } },
      ];
    }

    const [assets, total] = await Promise.all([
      prisma.mtAsset.findMany({
        where,
        select: assetSelect,
        orderBy: { createdAt: "desc" },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
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

// GET /api/maintenance/assets/stats — conteos por estado y criticidad (sin límite de paginación)
router.get("/stats", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const where = { plantId, deletedAt: null };
    const [byStatus, byCriticality, total] = await Promise.all([
      prisma.mtAsset.groupBy({ by: ["status"], where, _count: { _all: true } }),
      prisma.mtAsset.groupBy({ by: ["criticality"], where, _count: { _all: true } }),
      prisma.mtAsset.count({ where }),
    ]);
    const countOf = (rows, key, value) => rows.find((r) => r[key] === value)?._count._all || 0;

    return res.json({
      data: {
        total,
        operating: countOf(byStatus, "status", "OPERATING"),
        stopped: countOf(byStatus, "status", "STOPPED"),
        outOfService: countOf(byStatus, "status", "OUT_OF_SERVICE"),
        criticalA: countOf(byCriticality, "criticality", "A"),
        criticalB: countOf(byCriticality, "criticality", "B"),
        criticalC: countOf(byCriticality, "criticality", "C"),
        noCriticality: countOf(byCriticality, "criticality", null),
      },
    });
  } catch (err) {
    logger.error("[assets/stats GET]", err);
    return res.status(500).json({ error: "Error fetching asset stats" });
  }
});

// GET /api/maintenance/assets/hierarchy — árbol completo de la planta
router.get("/hierarchy", async (req, res) => {
  try {
    const data = await getAssetHierarchy(req.currentPlantId);
    return res.json({ data });
  } catch (err) {
    logger.error("[assets/hierarchy GET]", err);
    return res.status(500).json({ error: "Error fetching asset hierarchy" });
  }
});

router.get("/:id/expedient", async (req, res) => {
  try {
    const assetId = parseId(req.params.id);
    if (!assetId) return res.status(400).json({ error: "Invalid asset id" });

    const data = await getAssetExpedient(assetId, req.currentPlantId);
    if (!data) return res.status(404).json({ error: "Asset not found" });
    return res.json({ data });
  } catch (err) {
    logger.error("[assets/:id/expedient GET]", err);
    return res.status(500).json({ error: "Error fetching asset expedient" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const assetId = parseId(req.params.id);
    if (!assetId) return res.status(400).json({ error: "Invalid asset id" });

    const asset = await prisma.mtAsset.findFirst({
      where: { id: assetId, plantId, deletedAt: null },
      select: assetSelect,
    });

    if (!asset) {
      return res.status(404).json({ error: "Asset not found" });
    }

    const recentWorkOrders = await prisma.mtWorkOrder.findMany({
      where: { assetId, plantId },
      select: { id: true, number: true, status: true, type: true, title: true, createdAt: true },
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

    const parentError = await validateParent(plantId, parsed.parentId ?? null);
    if (parentError) return res.status(400).json({ error: parentError });

    const result = await prisma.mtAsset.create({
      data: {
        plantId,
        parentId: parsed.parentId ?? null,
        level: parsed.level,
        code: parsed.code,
        name: parsed.name,
        location: parsed.location ?? null,
        manufacturer: parsed.manufacturer ?? null,
        model: parsed.model ?? null,
        serialNumber: parsed.serialNumber ?? null,
        installedAt: parsed.installedAt ?? null,
        criticality: parsed.criticality ?? null,
        status: parsed.status,
        notes: parsed.notes ?? null,
      },
      select: assetSelect,
    });

    return res.status(201).json(result);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: zodMessage(err) });
    }
    if (err.code === "P2002") {
      return res.status(409).json({ error: "El código del activo ya existe en esta planta" });
    }
    logger.error("[assets POST]", err);
    return res.status(500).json({ error: "Error creating asset" });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const assetId = parseId(req.params.id);
    if (!assetId) return res.status(400).json({ error: "Invalid asset id" });

    const asset = await prisma.mtAsset.findFirst({
      where: { id: assetId, plantId, deletedAt: null },
    });

    if (!asset) {
      return res.status(404).json({ error: "Asset not found" });
    }

    const parsed = updateAssetSchema.parse(req.body);
    const updateData = Object.fromEntries(Object.entries(parsed).filter(([, v]) => v !== undefined));

    if ("parentId" in updateData && updateData.parentId !== asset.parentId) {
      const parentError = await validateParent(plantId, updateData.parentId, assetId);
      if (parentError) return res.status(400).json({ error: parentError });
    }

    if (updateData.code && updateData.code !== asset.code) {
      const existingCode = await prisma.mtAsset.findFirst({
        where: { plantId, code: updateData.code, id: { not: assetId } },
        select: { id: true },
      });
      if (existingCode) {
        return res.status(409).json({ error: `El código '${updateData.code}' ya existe en esta planta` });
      }
    }

    if (Object.keys(updateData).length === 0) {
      const current = await prisma.mtAsset.findUnique({ where: { id: assetId }, select: assetSelect });
      return res.json(current);
    }

    const updated = await prisma.mtAsset.update({
      where: { id: assetId },
      data: updateData,
      select: assetSelect,
    });

    return res.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: zodMessage(err) });
    }
    if (err.code === "P2002") {
      return res.status(409).json({ error: "El código del activo ya existe en esta planta" });
    }
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
    const assetId = parseId(req.params.id);
    if (!assetId) return res.status(400).json({ error: "Invalid asset id" });

    const asset = await prisma.mtAsset.findFirst({
      where: { id: assetId, plantId, deletedAt: null },
    });

    if (!asset) {
      return res.status(404).json({ error: "Asset not found" });
    }

    const [woCount, childCount] = await Promise.all([
      prisma.mtWorkOrder.count({
        where: { assetId, plantId, status: { notIn: OPEN_WO_EXCLUDED } },
      }),
      prisma.mtAsset.count({ where: { parentId: assetId, plantId, deletedAt: null } }),
    ]);

    if (woCount > 0) {
      return res.status(409).json({ error: `No se puede eliminar: tiene ${woCount} orden(es) de trabajo abierta(s)` });
    }
    if (childCount > 0) {
      return res.status(409).json({ error: `No se puede eliminar: tiene ${childCount} activo(s) hijo(s). Muévelos o elimínalos primero` });
    }

    const deleted = await prisma.mtAsset.update({
      where: { id: assetId },
      data: { deletedAt: new Date() },
      select: { id: true, code: true, name: true, deletedAt: true },
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
