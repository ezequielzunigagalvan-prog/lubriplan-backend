// src/routes/lubricationCards.routes.js
import express from "express";
import multer from "multer";
import { logger } from "../config/logger.js";
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
const VALID_METHODS     = ["MANUAL", "AUTO", "GREASE_GUN", "OIL_CAN"];
const VALID_UNITS       = ["ml", "g", "oz", "L"];

// Mapa de frecuencia de ruta → LubricationFrequency
const ROUTE_FREQ_MAP = {
  DAILY:   "DAILY",
  WEEKLY:  "WEEKLY",
  MONTHLY: "MONTHLY",
  CUSTOM:  "MONTHLY", // fallback
};

function toFloat(v, fallback = null) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

// Devuelve o crea una LubricationCard para el equipo, incluyendo imágenes y puntos
async function getOrCreateCard(prisma, equipmentId, plantId) {
  const equipment = await prisma.equipment.findFirst({
    where: { id: equipmentId, plantId },
    select: { id: true },
  });
  if (!equipment) return null;

  const existing = await prisma.lubricationCard.findUnique({
    where: { equipmentId },
    include: {
      points: { orderBy: { createdAt: "asc" } },
      images: { orderBy: { order: "asc" } },
    },
  });
  if (existing) return existing;

  return prisma.lubricationCard.create({
    data: { equipmentId },
    include: {
      points: { orderBy: { createdAt: "asc" } },
      images: { orderBy: { order: "asc" } },
    },
  });
}

export default function lubricationCardsRoutes({ prisma, auth, requireRole }) {
  const router = express.Router();

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/lubrication-cards/:equipmentId
  // ─────────────────────────────────────────────────────────────────────────
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
      logger.error("GET lubrication-card error:", e);
      return res.status(500).json({ error: "Error cargando carta de lubricación" });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/lubrication-cards/:equipmentId/points
  // ─────────────────────────────────────────────────────────────────────────
  router.post("/lubrication-cards/:equipmentId/points", auth, requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const equipmentId = Number(req.params.equipmentId);
      if (!Number.isFinite(equipmentId)) return res.status(400).json({ error: "ID inválido" });

      const { label, x, y, lubricant, quantity, unit, frequency, method, notes, imageId } = req.body;

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

      // Validar imageId si viene (debe pertenecer a esta carta)
      let validImageId = null;
      if (imageId != null && Number.isFinite(Number(imageId))) {
        const img = await prisma.lubricationCardImage.findFirst({ where: { id: Number(imageId), cardId: card.id } });
        if (img) validImageId = img.id;
      }

      const point = await prisma.lubricationPoint.create({
        data: {
          cardId: card.id,
          imageId: validImageId,
          label: String(label).trim(),
          x: xVal, y: yVal,
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
      logger.error("POST lubrication-card point error:", e);
      return res.status(500).json({ error: "Error agregando punto" });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PATCH /api/lubrication-cards/points/:pointId
  // ─────────────────────────────────────────────────────────────────────────
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
      if (req.body.imageId !== undefined) {
        data.imageId = req.body.imageId === null ? null : Number(req.body.imageId) || null;
      }

      if (!Object.keys(data).length) return res.status(400).json({ error: "Sin campos a actualizar" });

      const updated = await prisma.lubricationPoint.update({ where: { id: pointId }, data });
      return res.json({ ok: true, point: updated });
    } catch (e) {
      logger.error("PATCH lubrication-card point error:", e);
      return res.status(500).json({ error: "Error actualizando punto" });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DELETE /api/lubrication-cards/points/:pointId
  // ─────────────────────────────────────────────────────────────────────────
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
      logger.error("DELETE lubrication-card point error:", e);
      return res.status(500).json({ error: "Error eliminando punto" });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/lubrication-cards/:equipmentId/image  (imagen PRINCIPAL)
  // ─────────────────────────────────────────────────────────────────────────
  router.post(
    "/lubrication-cards/:equipmentId/image",
    auth, requireRole(["ADMIN", "SUPERVISOR"]),
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

        if (card.imagePublicId) await destroyCloudinaryImage(card.imagePublicId).catch(() => null);

        const uploaded = await uploadBufferToCloudinary(req.file.buffer, {
          folder: "lubriplan/lubrication-cards",
          publicId: `lcard_${equipmentId}_main_${Date.now()}`,
        });

        const updated = await prisma.lubricationCard.update({
          where: { id: card.id },
          data: { imageUrl: uploaded.secure_url, imagePublicId: uploaded.public_id },
          include: { points: { orderBy: { createdAt: "asc" } }, images: { orderBy: { order: "asc" } } },
        });

        return res.json({ ok: true, card: updated });
      } catch (e) {
        logger.error("POST lubrication-card image error:", e);
        return res.status(500).json({ error: "Error subiendo imagen" });
      }
    }
  );

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/lubrication-cards/:equipmentId/images  (imagen ADICIONAL)
  // ─────────────────────────────────────────────────────────────────────────
  router.post(
    "/lubrication-cards/:equipmentId/images",
    auth, requireRole(["ADMIN", "SUPERVISOR"]),
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

        const label = String(req.body.label || "Sección").trim().slice(0, 60) || "Sección";
        const maxOrder = card.images.length > 0 ? Math.max(...card.images.map((i) => i.order)) + 1 : 0;

        const uploaded = await uploadBufferToCloudinary(req.file.buffer, {
          folder: "lubriplan/lubrication-cards",
          publicId: `lcard_${equipmentId}_sec_${Date.now()}`,
        });

        const image = await prisma.lubricationCardImage.create({
          data: {
            cardId: card.id,
            imageUrl: uploaded.secure_url,
            imagePublicId: uploaded.public_id,
            label,
            order: maxOrder,
          },
        });

        return res.status(201).json({ ok: true, image });
      } catch (e) {
        logger.error("POST lubrication-card additional image error:", e);
        return res.status(500).json({ error: "Error subiendo imagen adicional" });
      }
    }
  );

  // ─────────────────────────────────────────────────────────────────────────
  // PATCH /api/lubrication-cards/images/:imageId  (renombrar sección)
  // ─────────────────────────────────────────────────────────────────────────
  router.patch("/lubrication-cards/images/:imageId", auth, requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const imageId = Number(req.params.imageId);
      if (!Number.isFinite(imageId)) return res.status(400).json({ error: "ID inválido" });

      const existing = await prisma.lubricationCardImage.findFirst({
        where: { id: imageId, card: { equipment: { plantId } } },
      });
      if (!existing) return res.status(404).json({ error: "Imagen no encontrada" });

      const data = {};
      if (req.body.label != null) data.label = String(req.body.label).trim().slice(0, 60) || "Sección";
      if (req.body.order != null && Number.isFinite(Number(req.body.order))) data.order = Number(req.body.order);

      const updated = await prisma.lubricationCardImage.update({ where: { id: imageId }, data });
      return res.json({ ok: true, image: updated });
    } catch (e) {
      logger.error("PATCH lubrication-card image error:", e);
      return res.status(500).json({ error: "Error actualizando imagen" });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DELETE /api/lubrication-cards/images/:imageId
  // ─────────────────────────────────────────────────────────────────────────
  router.delete("/lubrication-cards/images/:imageId", auth, requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const imageId = Number(req.params.imageId);
      if (!Number.isFinite(imageId)) return res.status(400).json({ error: "ID inválido" });

      const existing = await prisma.lubricationCardImage.findFirst({
        where: { id: imageId, card: { equipment: { plantId } } },
      });
      if (!existing) return res.status(404).json({ error: "Imagen no encontrada" });

      if (existing.imagePublicId) await destroyCloudinaryImage(existing.imagePublicId).catch(() => null);

      // Los puntos de esta imagen pasan a imageId=null (imagen principal)
      await prisma.lubricationCardImage.delete({ where: { id: imageId } });
      return res.json({ ok: true });
    } catch (e) {
      logger.error("DELETE lubrication-card image error:", e);
      return res.status(500).json({ error: "Error eliminando imagen" });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/lubrication-cards/:equipmentId/sync-preview
  // Vista previa de qué rutas se convertirían en puntos (sin guardar)
  // ─────────────────────────────────────────────────────────────────────────
  router.get("/lubrication-cards/:equipmentId/sync-preview", auth, requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const equipmentId = Number(req.params.equipmentId);
      if (!Number.isFinite(equipmentId)) return res.status(400).json({ error: "ID inválido" });

      const [routes, card] = await Promise.all([
        prisma.route.findMany({
          where: { equipmentId, plantId, isEmergency: false },
          select: {
            id: true, name: true, lubricantName: true, quantity: true, unit: true,
            frequencyType: true, frequencyDays: true, method: true, instructions: true,
            lubricant: { select: { name: true, unit: true } },
          },
          orderBy: { name: "asc" },
        }),
        prisma.lubricationCard.findUnique({
          where: { equipmentId },
          select: { points: { select: { routeId: true, label: true } } },
        }),
      ]);

      const existingRouteIds = new Set((card?.points ?? []).map((p) => p.routeId).filter(Boolean));

      const preview = routes.map((r) => ({
        routeId:     r.id,
        routeName:   r.name,
        lubricant:   r.lubricant?.name || r.lubricantName || null,
        quantity:    r.quantity,
        unit:        r.unit || r.lubricant?.unit || "ml",
        frequency:   ROUTE_FREQ_MAP[r.frequencyType] || "MONTHLY",
        frequencyDays: r.frequencyDays,
        method:      VALID_METHODS.includes(String(r.method || "").toUpperCase()) ? String(r.method).toUpperCase() : "MANUAL",
        notes:       r.instructions || null,
        alreadySynced: existingRouteIds.has(r.id),
      }));

      return res.json({ ok: true, preview });
    } catch (e) {
      logger.error("GET sync-preview error:", e);
      return res.status(500).json({ error: "Error generando preview" });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/lubrication-cards/:equipmentId/sync-from-routes
  // Crea puntos desde rutas (semi-automático) — posiciones en cuadrícula,
  // el usuario las ajusta arrastrando sobre el diagrama
  // ─────────────────────────────────────────────────────────────────────────
  router.post("/lubrication-cards/:equipmentId/sync-from-routes", auth, requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const equipmentId = Number(req.params.equipmentId);
      if (!Number.isFinite(equipmentId)) return res.status(400).json({ error: "ID inválido" });

      // routeIds opcionales — si no vienen, sincroniza todas las rutas no sincronizadas
      const selectedRouteIds = Array.isArray(req.body.routeIds)
        ? req.body.routeIds.map(Number).filter(Number.isFinite)
        : null;

      const card = await getOrCreateCard(prisma, equipmentId, plantId);
      if (!card) return res.status(404).json({ error: "Equipo no encontrado" });

      const existingRouteIds = new Set(card.points.map((p) => p.routeId).filter(Boolean));

      const where = {
        equipmentId, plantId, isEmergency: false,
        ...(selectedRouteIds ? { id: { in: selectedRouteIds } } : {}),
      };

      const routes = await prisma.route.findMany({
        where,
        select: {
          id: true, name: true, lubricantName: true, quantity: true, unit: true,
          frequencyType: true, method: true, instructions: true,
          lubricant: { select: { name: true, unit: true } },
        },
        orderBy: { name: "asc" },
      });

      // Filtra las que ya están sincronizadas (a menos que se fuerce)
      const toCreate = routes.filter((r) => !existingRouteIds.has(r.id));
      if (!toCreate.length) {
        return res.json({ ok: true, created: 0, message: "Todas las rutas seleccionadas ya están sincronizadas" });
      }

      // Distribuye puntos en cuadrícula 5x5 centrada, sin solaparse
      const cols = 5;
      const startX = 15, startY = 15;
      const stepX  = 14, stepY  = 16;

      const pointsData = toCreate.map((r, idx) => ({
        cardId:    card.id,
        routeId:   r.id,
        label:     r.name,
        x: parseFloat((startX + (idx % cols) * stepX).toFixed(1)),
        y: parseFloat((startY + Math.floor(idx / cols) * stepY).toFixed(1)),
        lubricant: r.lubricant?.name || r.lubricantName || null,
        quantity:  r.quantity,
        unit:      r.unit || r.lubricant?.unit || "ml",
        frequency: ROUTE_FREQ_MAP[r.frequencyType] || "MONTHLY",
        method:    VALID_METHODS.includes(String(r.method || "").toUpperCase())
                     ? String(r.method).toUpperCase()
                     : "MANUAL",
        notes:     r.instructions || null,
      }));

      await prisma.lubricationPoint.createMany({ data: pointsData });

      const updatedCard = await prisma.lubricationCard.findUnique({
        where: { equipmentId },
        include: {
          points: { orderBy: { createdAt: "asc" } },
          images: { orderBy: { order: "asc" } },
        },
      });

      return res.json({
        ok: true,
        created: pointsData.length,
        card: updatedCard,
        message: `${pointsData.length} punto${pointsData.length !== 1 ? "s" : ""} creado${pointsData.length !== 1 ? "s" : ""} desde rutas. Arrastra cada punto a su posición en el diagrama.`,
      });
    } catch (e) {
      logger.error("POST sync-from-routes error:", e);
      return res.status(500).json({ error: "Error sincronizando desde rutas" });
    }
  });

  return router;
}
