// src/routes/lubricationCards.routes.js
import express from "express";
import multer from "multer";
import { logger } from "../config/logger.js";
import { uploadBufferToCloudinary, destroyCloudinaryImage } from "../lib/cloudinary.js";
import { ruleOf, describeRule } from "../utils/routeSchedule.js";
import { ensureEquipmentQr } from "./equipmentQr.routes.js";

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
const VALID_UNITS       = ["ml", "L", "g", "kg", "oz", "bombazos"];

function normUnit(u) {
  const s = String(u || "").trim();
  const hit = VALID_UNITS.find((v) => v.toLowerCase() === s.toLowerCase());
  return hit || "ml";
}

/**
 * Frecuencia de una ruta para la carta: frequencyLabel es el texto exacto ("Bimestral (día 24)",
 * "Lun · Jue", "Cada 15 días"); frequency es el grupo de color de la carta.
 * Antes toda ruta que no fuera diaria/semanal/mensual quedaba como "Mensual" (p. ej. una de 7 días).
 */
function pointFrequency(route) {
  const rule = ruleOf(route || {});
  if (!rule) return { frequency: "MONTHLY", frequencyLabel: null };
  let frequency;
  if ((rule.kind === "DAYS" && rule.days <= 1) || (rule.kind === "WEEKLY" && rule.weekdays.length === 7)) frequency = "DAILY";
  else if (rule.kind === "WEEKLY" || (rule.kind === "DAYS" && rule.days <= 10)) frequency = "WEEKLY";
  else if ((rule.kind === "MONTHS" && rule.months <= 1) || (rule.kind === "DAYS" && rule.days <= 45)) frequency = "MONTHLY";
  else if ((rule.kind === "MONTHS" && rule.months <= 4) || (rule.kind === "DAYS" && rule.days <= 130)) frequency = "QUARTERLY";
  else frequency = "ANNUAL";
  return { frequency, frequencyLabel: describeRule(rule) };
}

/** Método de la ruta (texto libre) → método de la carta. */
function routeMethod(m) {
  const s = String(m || "").toLowerCase();
  if (/inyector|grasera|pistola|engrase/.test(s)) return "GREASE_GUN";
  if (/aceitera|goteo/.test(s)) return "OIL_CAN";
  if (/autom|sistema|centraliz/.test(s)) return "AUTO";
  return "MANUAL";
}

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

  const include = {
    points: { orderBy: { createdAt: "asc" } },
    images: { orderBy: { order: "asc" } },
  };
  try {
    return await prisma.lubricationCard.create({ data: { equipmentId }, include });
  } catch (e) {
    // Dos solicitudes simultáneas al abrir la carta por primera vez: la otra ya la creó.
    if (e?.code !== "P2002") throw e;
    return prisma.lubricationCard.findUnique({ where: { equipmentId }, include });
  }
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

      const [equipment, qr] = await Promise.all([
        prisma.equipment.findFirst({
          where: { id: equipmentId, plantId },
          select: { id: true, name: true, code: true, location: true, criticality: true, brand: true, model: true, plant: { select: { name: true } } },
        }),
        ensureEquipmentQr(prisma, equipmentId),
      ]);
      return res.json({ ok: true, card, equipment, qr });
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
          unit: normUnit(unit),
          frequency: freq,
          frequencyLabel: req.body.frequencyLabel ? String(req.body.frequencyLabel).trim().slice(0, 80) : null,
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
      if (req.body.unit != null) data.unit = normUnit(req.body.unit);
      if (req.body.frequency != null) {
        const f = String(req.body.frequency).toUpperCase();
        if (!VALID_FREQUENCIES.includes(f)) return res.status(400).json({ error: "Frecuencia inválida" });
        data.frequency = f;
        // Cambiar la frecuencia a mano reemplaza el texto que venía de la ruta.
        if (f !== existing.frequency && req.body.frequencyLabel === undefined) data.frequencyLabel = null;
      }
      if (req.body.frequencyLabel !== undefined) {
        data.frequencyLabel = req.body.frequencyLabel ? String(req.body.frequencyLabel).trim().slice(0, 80) : null;
      }
      if (req.body.method != null) {
        const m = String(req.body.method).toUpperCase();
        if (!VALID_METHODS.includes(m)) return res.status(400).json({ error: "Método inválido" });
        data.method = m;
      }
      if (req.body.notes != null) data.notes = String(req.body.notes).trim() || null;
      if (req.body.imageId !== undefined) {
        if (req.body.imageId === null) data.imageId = null;
        else {
          const img = await prisma.lubricationCardImage.findFirst({ where: { id: Number(req.body.imageId), cardId: existing.cardId }, select: { id: true } });
          if (!img) return res.status(400).json({ error: "La sección no pertenece a esta carta" });
          data.imageId = img.id;
        }
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
  // Rutas → puntos de la carta
  //  - Incluye rutas donde el equipo es el principal o uno de varios equipos.
  //  - Frecuencia exacta de la ruta (frequencyLabel) y grupo de color (frequency).
  //  - Método de la ruta traducido (inyector → pistola de grasa, aceitera, automático).
  //  - Opción de un marcador por cada punto de engrase de la ruta.
  //  - Las rutas ya cargadas pueden actualizar sus datos (sin mover los marcadores).
  // ─────────────────────────────────────────────────────────────────────────
  const ROUTE_SYNC_SELECT = {
    id: true, name: true, routeKind: true, lubricantName: true, lubricantType: true, quantity: true, unit: true,
    points: true, pumpStrokeValue: true, pumpStrokeUnit: true,
    frequencyType: true, frequencyDays: true, weeklyDays: true, monthlyAnchorDay: true,
    method: true, instructions: true, equipmentId: true,
    lubricant: { select: { name: true, unit: true } },
    _count: { select: { equipments: true } },
  };

  const routesOfEquipment = (equipmentId, plantId, extra = {}) =>
    prisma.route.findMany({
      where: {
        plantId,
        isEmergency: false,
        OR: [{ equipmentId }, { equipments: { some: { equipmentId } } }],
        ...extra,
      },
      select: ROUTE_SYNC_SELECT,
      orderBy: { name: "asc" },
    });

  function routePointData(r) {
    const { frequency, frequencyLabel } = pointFrequency(r);
    const strokes = String(r.unit || "").toUpperCase() === "BOMBAZOS";
    const unit = strokes ? "bombazos" : normUnit(r.unit || r.lubricant?.unit);
    const extraNotes = [];
    if (strokes && r.pumpStrokeValue) extraNotes.push(`1 bombazo = ${r.pumpStrokeValue} ${r.pumpStrokeUnit || ""}`.trim());
    if (r.instructions) extraNotes.push(r.instructions);
    return {
      lubricant: r.lubricant?.name || r.lubricantName || r.lubricantType || null,
      quantity: r.quantity,
      unit,
      frequency,
      frequencyLabel,
      method: routeMethod(r.method),
      notes: extraNotes.join(" · ") || null,
    };
  }

  router.get("/lubrication-cards/:equipmentId/sync-preview", auth, requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });
      const equipmentId = Number(req.params.equipmentId);
      if (!Number.isFinite(equipmentId)) return res.status(400).json({ error: "ID inválido" });
      const eq = await prisma.equipment.findFirst({ where: { id: equipmentId, plantId }, select: { id: true } });
      if (!eq) return res.status(404).json({ error: "Equipo no encontrado" });

      const [routes, card] = await Promise.all([
        routesOfEquipment(equipmentId, plantId),
        prisma.lubricationCard.findUnique({ where: { equipmentId }, select: { points: { select: { routeId: true } } } }),
      ]);
      const synced = new Map();
      (card?.points ?? []).forEach((p) => p.routeId && synced.set(p.routeId, (synced.get(p.routeId) || 0) + 1));

      const preview = routes.map((r) => ({
        routeId: r.id,
        routeName: r.name,
        routeKind: r.routeKind,
        ...routePointData(r),
        pointsCount: Number(r.points) > 0 ? Number(r.points) : 1,
        sharedWith: r._count?.equipments > 1 ? r._count.equipments - 1 : 0,
        alreadySynced: synced.has(r.id),
        markers: synced.get(r.id) || 0,
      }));
      return res.json({ ok: true, preview });
    } catch (e) {
      logger.error("GET sync-preview error:", e);
      return res.status(500).json({ error: "Error generando vista previa" });
    }
  });

  router.post("/lubrication-cards/:equipmentId/sync-from-routes", auth, requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });
      const equipmentId = Number(req.params.equipmentId);
      if (!Number.isFinite(equipmentId)) return res.status(400).json({ error: "ID inválido" });

      const selectedRouteIds = Array.isArray(req.body?.routeIds) ? req.body.routeIds.map(Number).filter(Number.isFinite) : null;
      const expandPoints = req.body?.expandPoints === true;
      const refreshExisting = req.body?.refreshExisting !== false;

      const card = await getOrCreateCard(prisma, equipmentId, plantId);
      if (!card) return res.status(404).json({ error: "Equipo no encontrado" });

      const routes = await routesOfEquipment(equipmentId, plantId, selectedRouteIds ? { id: { in: selectedRouteIds } } : {});
      const byRoute = new Map();
      card.points.forEach((p) => {
        if (!p.routeId) return;
        if (!byRoute.has(p.routeId)) byRoute.set(p.routeId, []);
        byRoute.get(p.routeId).push(p);
      });

      // Posiciones libres en cuadrícula, después de los marcadores existentes de la imagen principal
      const used = card.points.filter((p) => p.imageId == null).length;
      const cols = 6;
      const slot = (i) => ({
        x: parseFloat((10 + ((used + i) % cols) * 15).toFixed(1)),
        y: parseFloat((12 + (Math.floor((used + i) / cols) % 6) * 15).toFixed(1)),
      });

      const toCreate = [];
      let updated = 0;
      for (const r of routes) {
        const data = routePointData(r);
        const existing = byRoute.get(r.id);
        if (existing?.length) {
          if (refreshExisting) {
            await prisma.lubricationPoint.updateMany({ where: { id: { in: existing.map((p) => p.id) } }, data });
            updated += existing.length;
          }
          continue;
        }
        const n = expandPoints ? Math.min(Math.max(Number(r.points) || 1, 1), 30) : 1;
        for (let k = 1; k <= n; k++) {
          toCreate.push({
            cardId: card.id,
            routeId: r.id,
            label: n > 1 ? `${r.name} · P${k}` : r.name,
            ...slot(toCreate.length),
            ...data,
            quantity: n > 1 ? r.quantity : r.quantity,
          });
        }
      }
      if (toCreate.length) await prisma.lubricationPoint.createMany({ data: toCreate });

      const updatedCard = await prisma.lubricationCard.findUnique({
        where: { equipmentId },
        include: { points: { orderBy: { createdAt: "asc" } }, images: { orderBy: { order: "asc" } } },
      });
      const parts = [];
      if (toCreate.length) parts.push(`${toCreate.length} punto${toCreate.length === 1 ? "" : "s"} nuevo${toCreate.length === 1 ? "" : "s"}`);
      if (updated) parts.push(`${updated} actualizado${updated === 1 ? "" : "s"}`);
      return res.json({
        ok: true,
        created: toCreate.length,
        updated,
        card: updatedCard,
        message: parts.length
          ? `${parts.join(" y ")} desde rutas.${toCreate.length ? " Arrastra cada punto a su lugar en la foto." : ""}`
          : "Las rutas ya estaban en la carta.",
      });
    } catch (e) {
      logger.error("POST sync-from-routes error:", e);
      return res.status(500).json({ error: "Error cargando rutas en la carta" });
    }
  });

  return router;
}
