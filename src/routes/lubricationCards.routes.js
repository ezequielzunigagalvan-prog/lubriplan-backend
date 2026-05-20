// src/routes/lubricationCards.routes.js
import express from "express";
import multer from "multer";
import { uploadBufferToCloudinary, destroyCloudinaryImage } from "../lib/cloudinary.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
    if (!allowed.includes(String(file.mimetype || "").toLowerCase())) {
      return cb(new Error("Formato no permitido. Usa JPG, PNG o WebP."));
    }
    return cb(null, true);
  },
});

const VALID_FREQUENCIES = ["DAILY", "WEEKLY", "MONTHLY", "QUARTERLY", "ANNUAL"];
const VALID_METHODS = ["MANUAL", "AUTO", "GREASE_GUN", "OIL_CAN"];
const VALID_UNITS = ["ml", "g", "oz", "L"];

function toFloat(v, fallback = null) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

async function getOrCreateCard(prisma, equipmentId, plantId) {
  const equipment = await prisma.equipment.findFirst({
    where: { id: equipmentId, plantId },
    select: { id: true },
  });
  if (!equipment) return null;

  const existing = await prisma.lubricationCard.findUnique({
    where: { equipmentId },
    include: { points: { orderBy: { createdAt: "asc" } } },
  });
  if (existing) return existing;

  return prisma.lubricationCard.create({
    data: { equipmentId },
    include: { points: { orderBy: { createdAt: "asc" } } },
  });
}

export default function lubricationCardsRoutes({ prisma, auth, requireRole }) {
  const router = express.Router();

  // GET /api/lubrication-cards/:equipmentId
  router.get("/lubrication-cards/:equipmentId", auth, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const equipmentId = Number(req.params.equipmentId);
      if (!Number.isFinite(equipmentId)) return res.status(400).json({ error: "ID inválido" });

      const card = await getOrCreateCard(prisma, equipmentId, plantId);
      if (!card) return res.status(404).json({ error: "Equipo no encontrado" });

      return res.json({ ok: true, card });
    } catch (e) {
      return res.status(500).json({ error: "Error cargando carta de lubricación" });
    }
  });

  // POST /api/lubrication-cards/:equipmentId/points
  router.post("/lubrication-cards/:equipmentId/points", auth, requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const equipmentId = Number(req.params.equipmentId);
      if (!Number.isFinite(equipmentId)) return res.status(400).json({ error: "ID inválido" });

      const { label, x, y, lubricant, quantity, unit, frequency, method, notes } = req.body;

      if (!label || !String(label).trim()) return res.status(400).json({ error: "label requerido" });

      const xVal = toFloat(x);
      const yVal = toFloat(y);
      if (xVal === null || yVal === null || xVal < 0 || xVal > 100 || yVal < 0 || yVal > 100) {
        return res.status(400).json({ error: "Coordenadas x,y deben ser 0-100" });
      }

      const freq = String(frequency || "MONTHLY").toUpperCase();
      if (!VALID_FREQUENCIES.includes(freq)) return res.status(400).json({ error: "Frecuencia inválida" });

      const meth = String(method || "MANUAL").toUpperCase();
      if (!VALID_METHODS.includes(meth)) return res.status(400).json({ error: "Método inválido" });

      const card = await getOrCreateCard(prisma, equipmentId, plantId);
      if (!card) return res.status(404).json({ error: "Equipo no encontrado" });

      const point = await prisma.lubricationPoint.create({
        data: {
          cardId: card.id,
          label: String(label).trim(),
          x: xVal,
          y: yVal,
          lubricant: lubricant ? String(lubricant).trim() : null,
          quantity: toFloat(quantity),
          unit: VALID_UNITS.includes(String(unit || "ml")) ? String(unit || "ml") : "ml",
          frequency: freq,
          method: meth,
          notes: notes ? String(notes).trim() : null,
        },
      });

      return res.status(201).json({ ok: true, point });
    } catch (e) {
      return res.status(500).json({ error: "Error agregando punto" });
    }
  });

  // PATCH /api/lubrication-cards/points/:pointId
  router.patch("/lubrication-cards/points/:pointId", auth, requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const pointId = Number(req.params.pointId);
      if (!Number.isFinite(pointId)) return res.status(400).json({ error: "ID inválido" });

      const existing = await prisma.lubricationPoint.findFirst({
        where: { id: pointId, card: { equipment: { plantId } } },
      });
      if (!existing) return res.status(404).json({ error: "Punto no encontrado" });

      const data = {};
      if (req.body.label != null) data.label = String(req.body.label).trim();
      if (req.body.x != null) {
        const v = toFloat(req.body.x);
        if (v === null || v < 0 || v > 100) return res.status(400).json({ error: "x inválido" });
        data.x = v;
      }
      if (req.body.y != null) {
        const v = toFloat(req.body.y);
        if (v === null || v < 0 || v > 100) return res.status(400).json({ error: "y inválido" });
        data.y = v;
      }
      if (req.body.lubricant != null) data.lubricant = String(req.body.lubricant).trim() || null;
      if (req.body.quantity != null) data.quantity = toFloat(req.body.quantity);
      if (req.body.unit != null && VALID_UNITS.includes(String(req.body.unit))) data.unit = String(req.body.unit);
      if (req.body.frequency != null) {
        const f = String(req.body.frequency).toUpperCase();
        if (!VALID_FREQUENCIES.includes(f)) return res.status(400).json({ error: "Frecuencia inválida" });
        data.frequency = f;
      }
      if (req.body.method != null) {
        const m = String(req.body.method).toUpperCase();
        if (!VALID_METHODS.includes(m)) return res.status(400).json({ error: "Método inválido" });
        data.method = m;
      }
      if (req.body.notes != null) data.notes = String(req.body.notes).trim() || null;

      if (!Object.keys(data).length) return res.status(400).json({ error: "Sin campos a actualizar" });

      const updated = await prisma.lubricationPoint.update({ where: { id: pointId }, data });
      return res.json({ ok: true, point: updated });
    } catch (e) {
      return res.status(500).json({ error: "Error actualizando punto" });
    }
  });

  // DELETE /api/lubrication-cards/points/:pointId
  router.delete("/lubrication-cards/points/:pointId", auth, requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const pointId = Number(req.params.pointId);
      if (!Number.isFinite(pointId)) return res.status(400).json({ error: "ID inválido" });

      const existing = await prisma.lubricationPoint.findFirst({
        where: { id: pointId, card: { equipment: { plantId } } },
      });
      if (!existing) return res.status(404).json({ error: "Punto no encontrado" });

      await prisma.lubricationPoint.delete({ where: { id: pointId } });
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: "Error eliminando punto" });
    }
  });

  // POST /api/lubrication-cards/:equipmentId/image
  router.post(
    "/lubrication-cards/:equipmentId/image",
    auth,
    requireRole(["ADMIN", "SUPERVISOR"]),
    upload.single("image"),
    async (req, res) => {
      try {
        const plantId = req.currentPlantId;
        if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

        const equipmentId = Number(req.params.equipmentId);
        if (!Number.isFinite(equipmentId)) return res.status(400).json({ error: "ID inválido" });

        if (!req.file?.buffer) return res.status(400).json({ error: "Imagen requerida" });

        const card = await getOrCreateCard(prisma, equipmentId, plantId);
        if (!card) return res.status(404).json({ error: "Equipo no encontrado" });

        if (card.imagePublicId) {
          await destroyCloudinaryImage(card.imagePublicId).catch(() => null);
        }

        const uploaded = await uploadBufferToCloudinary(req.file.buffer, {
          folder: "lubriplan/lubrication-cards",
          publicId: `lcard_${equipmentId}_${Date.now()}`,
        });

        const updated = await prisma.lubricationCard.update({
          where: { id: card.id },
          data: { imageUrl: uploaded.secure_url, imagePublicId: uploaded.public_id },
          include: { points: { orderBy: { createdAt: "asc" } } },
        });

        return res.json({ ok: true, card: updated });
      } catch (e) {
        return res.status(500).json({ error: "Error subiendo imagen" });
      }
    }
  );

  return router;
}
