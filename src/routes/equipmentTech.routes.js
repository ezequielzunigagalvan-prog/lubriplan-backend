// src/routes/equipmentTech.routes.js
// Información técnica de un equipo:
//  - Datos técnicos (tabla libre: dato · valor · unidad) en Equipment.techSpecs.
//  - Manuales y documentos (PDF, imágenes, Office) en Cloudinary.
//  - Diagramas de lubricación automática (sistemas progresivos, aceite con dosificadores, etc.).
// Lectura: cualquier usuario de la planta. Escritura: ADMIN y SUPERVISOR.
import express from "express";
import multer from "multer";
import { logger } from "../config/logger.js";
import { uploadBufferToCloudinary, destroyCloudinaryImage } from "../lib/cloudinary.js";
import { logAudit } from "../services/audit.service.js";

export const DOC_CATEGORIES = ["MANUAL", "PLANO", "FICHA", "CERTIFICADO", "FOTO", "OTRO"];
export const SYSTEM_TYPES = ["PROGRESSIVE", "OIL_METERING", "SINGLE_LINE", "DUAL_LINE", "OTHER"];
const MAX_SPECS = 80;
const MAX_NODES = 400;
const MAX_EDGES = 800;
const MAX_DIAGRAM_BYTES = 600 * 1024;

const DOC_MIMES = new Set([
  "application/pdf",
  "image/jpeg", "image/jpg", "image/png", "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export class TechError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Normaliza la tabla de datos técnicos. */
export function parseSpecs(input) {
  if (!Array.isArray(input)) throw new TechError("Datos técnicos no válidos");
  const rows = input
    .map((r) => ({
      label: String(r?.label ?? "").trim().slice(0, 60),
      value: String(r?.value ?? "").trim().slice(0, 160),
      unit: String(r?.unit ?? "").trim().slice(0, 20),
    }))
    .filter((r) => r.label || r.value);
  if (rows.length > MAX_SPECS) throw new TechError(`Máximo ${MAX_SPECS} datos técnicos`);
  const missing = rows.find((r) => !r.label || !r.value);
  if (missing) throw new TechError("Cada dato técnico necesita nombre y valor");
  return rows;
}

/** Valida la estructura del diagrama { nodes, edges }. */
export function parseDiagramData(data) {
  if (!data || typeof data !== "object") throw new TechError("Diagrama vacío");
  const nodes = Array.isArray(data.nodes) ? data.nodes : [];
  const edges = Array.isArray(data.edges) ? data.edges : [];
  if (nodes.length > MAX_NODES) throw new TechError(`Máximo ${MAX_NODES} elementos por diagrama`);
  if (edges.length > MAX_EDGES) throw new TechError(`Máximo ${MAX_EDGES} líneas por diagrama`);
  const ids = new Set();
  for (const n of nodes) {
    if (!n || typeof n.id !== "string" || typeof n.type !== "string") throw new TechError("Elemento del diagrama no válido");
    if (!Number.isFinite(Number(n.x)) || !Number.isFinite(Number(n.y))) throw new TechError("Posición no válida en el diagrama");
    ids.add(n.id);
  }
  for (const e of edges) {
    if (!e || !ids.has(e.from) || !ids.has(e.to)) throw new TechError("Hay una línea conectada a un elemento que no existe");
  }
  const clean = { version: 1, nodes, edges, view: data.view && typeof data.view === "object" ? data.view : undefined };
  if (Buffer.byteLength(JSON.stringify(clean)) > MAX_DIAGRAM_BYTES) throw new TechError("El diagrama es demasiado grande");
  return clean;
}

export default function equipmentTechRoutes({ prisma, auth, requireRole }) {
  const router = express.Router();
  const managers = [auth, requireRole(["ADMIN", "SUPERVISOR"])];
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter: (_req, file, cb) =>
      DOC_MIMES.has(String(file.mimetype).toLowerCase())
        ? cb(null, true)
        : cb(new TechError("Formato no permitido: PDF, imagen, Word o Excel")),
  });

  const fail = (res, e, label) => {
    if (e instanceof TechError || e?.status) return res.status(e.status || 400).json({ error: e.message });
    if (e?.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: "El archivo supera 20 MB" });
    logger.error(label, e);
    return res.status(500).json({ error: "No se pudo completar la operación" });
  };

  async function equipmentOf(req) {
    const id = Number(req.params.id);
    const plantId = req.currentPlantId;
    if (!plantId) throw new TechError("PLANT_REQUIRED");
    const eq = await prisma.equipment.findFirst({ where: { id, plantId }, select: { id: true, name: true, techSpecs: true } });
    if (!eq) throw new TechError("Equipo no encontrado", 404);
    return eq;
  }

  // ── Resumen técnico del equipo ───────────────────────────────────────────
  router.get("/equipment/:id/tech", auth, async (req, res) => {
    try {
      const eq = await equipmentOf(req);
      const [documents, diagrams] = await Promise.all([
        prisma.equipmentDocument.findMany({ where: { equipmentId: eq.id }, orderBy: [{ category: "asc" }, { createdAt: "desc" }] }),
        prisma.lubricationDiagram.findMany({
          where: { equipmentId: eq.id },
          select: { id: true, name: true, systemType: true, notes: true, createdAt: true, updatedAt: true, data: true },
          orderBy: { updatedAt: "desc" },
        }),
      ]);
      return res.json({
        ok: true,
        specs: Array.isArray(eq.techSpecs) ? eq.techSpecs : [],
        documents,
        diagrams: diagrams.map(({ data, ...d }) => ({
          ...d,
          nodes: Array.isArray(data?.nodes) ? data.nodes.length : 0,
          points: Array.isArray(data?.nodes) ? data.nodes.filter((n) => n.type === "POINT").length : 0,
        })),
      });
    } catch (e) {
      return fail(res, e, "GET /equipment/:id/tech");
    }
  });

  // ── Datos técnicos ───────────────────────────────────────────────────────
  router.put("/equipment/:id/specs", ...managers, async (req, res) => {
    try {
      const eq = await equipmentOf(req);
      const specs = parseSpecs(req.body?.specs);
      await prisma.equipment.update({ where: { id: eq.id }, data: { techSpecs: specs } });
      logAudit({ plantId: req.currentPlantId, userId: req.user.id, action: "UPDATE", model: "Equipment", recordId: eq.id, changes: { after: { techSpecs: specs.length } }, ip: req.ip });
      return res.json({ ok: true, specs });
    } catch (e) {
      return fail(res, e, "PUT /equipment/:id/specs");
    }
  });

  // ── Documentos ───────────────────────────────────────────────────────────
  router.post("/equipment/:id/documents", ...managers, (req, res, next) => {
    upload.single("file")(req, res, (err) => (err ? fail(res, err, "upload doc") : next()));
  }, async (req, res) => {
    try {
      const eq = await equipmentOf(req);
      if (!req.file) throw new TechError("Elige un archivo");
      const category = String(req.body?.category || "OTRO").toUpperCase();
      if (!DOC_CATEGORIES.includes(category)) throw new TechError("Tipo de documento no válido");
      const original = String(req.file.originalname || "documento").slice(0, 160);
      const name = String(req.body?.name || "").trim().slice(0, 160) || original.replace(/\.[^.]+$/, "");
      const mime = String(req.file.mimetype).toLowerCase();
      const isImage = mime.startsWith("image/");
      const ext = (original.match(/\.([a-z0-9]{2,5})$/i)?.[1] || (mime === "application/pdf" ? "pdf" : "bin")).toLowerCase();
      const up = await uploadBufferToCloudinary(req.file.buffer, {
        folder: `lubriplan/equipment-docs/${req.currentPlantId}/${eq.id}`,
        resourceType: isImage ? "image" : "raw",
        publicId: isImage ? undefined : `doc_${eq.id}_${Date.now()}.${ext}`,
      });
      const doc = await prisma.equipmentDocument.create({
        data: {
          plantId: req.currentPlantId,
          equipmentId: eq.id,
          category,
          name,
          url: up.secure_url,
          publicId: up.public_id || null,
          mime,
          size: req.file.size,
          uploadedById: req.user.id,
        },
      });
      return res.status(201).json({ ok: true, document: doc });
    } catch (e) {
      return fail(res, e, "POST /equipment/:id/documents");
    }
  });

  router.delete("/equipment/:id/documents/:docId", ...managers, async (req, res) => {
    try {
      const eq = await equipmentOf(req);
      const doc = await prisma.equipmentDocument.findFirst({ where: { id: Number(req.params.docId), equipmentId: eq.id } });
      if (!doc) throw new TechError("Documento no encontrado", 404);
      await prisma.equipmentDocument.delete({ where: { id: doc.id } });
      if (doc.publicId && String(doc.mime || "").startsWith("image/")) Promise.resolve(destroyCloudinaryImage(doc.publicId)).catch(() => {});
      logAudit({ plantId: req.currentPlantId, userId: req.user.id, action: "DELETE", model: "EquipmentDocument", recordId: doc.id, changes: { before: { name: doc.name } }, ip: req.ip });
      return res.json({ ok: true });
    } catch (e) {
      return fail(res, e, "DELETE document");
    }
  });

  // ── Diagramas ────────────────────────────────────────────────────────────
  router.get("/equipment/:id/diagrams/:diagramId", auth, async (req, res) => {
    try {
      const eq = await equipmentOf(req);
      const d = await prisma.lubricationDiagram.findFirst({ where: { id: Number(req.params.diagramId), equipmentId: eq.id } });
      if (!d) throw new TechError("Diagrama no encontrado", 404);
      return res.json({ ok: true, diagram: d, equipment: { id: eq.id, name: eq.name } });
    } catch (e) {
      return fail(res, e, "GET diagram");
    }
  });

  const diagramInput = (body, { partial = false } = {}) => {
    const out = {};
    if (!partial || body.name !== undefined) {
      const name = String(body.name || "").trim();
      if (name.length < 2) throw new TechError("Escribe el nombre del diagrama");
      out.name = name.slice(0, 120);
    }
    if (!partial || body.systemType !== undefined) {
      const st = String(body.systemType || "").toUpperCase();
      if (!SYSTEM_TYPES.includes(st)) throw new TechError("Tipo de sistema no válido");
      out.systemType = st;
    }
    if (body.notes !== undefined) out.notes = String(body.notes || "").trim().slice(0, 2000) || null;
    if (!partial || body.data !== undefined) out.data = parseDiagramData(body.data);
    return out;
  };

  router.post("/equipment/:id/diagrams", ...managers, async (req, res) => {
    try {
      const eq = await equipmentOf(req);
      const data = diagramInput(req.body || {});
      const d = await prisma.lubricationDiagram.create({
        data: { ...data, plantId: req.currentPlantId, equipmentId: eq.id, createdById: req.user.id, updatedById: req.user.id },
      });
      return res.status(201).json({ ok: true, diagram: d });
    } catch (e) {
      return fail(res, e, "POST diagram");
    }
  });

  router.put("/equipment/:id/diagrams/:diagramId", ...managers, async (req, res) => {
    try {
      const eq = await equipmentOf(req);
      const existing = await prisma.lubricationDiagram.findFirst({ where: { id: Number(req.params.diagramId), equipmentId: eq.id }, select: { id: true } });
      if (!existing) throw new TechError("Diagrama no encontrado", 404);
      const data = diagramInput(req.body || {}, { partial: true });
      const d = await prisma.lubricationDiagram.update({ where: { id: existing.id }, data: { ...data, updatedById: req.user.id } });
      return res.json({ ok: true, diagram: d });
    } catch (e) {
      return fail(res, e, "PUT diagram");
    }
  });

  router.delete("/equipment/:id/diagrams/:diagramId", ...managers, async (req, res) => {
    try {
      const eq = await equipmentOf(req);
      const d = await prisma.lubricationDiagram.findFirst({ where: { id: Number(req.params.diagramId), equipmentId: eq.id }, select: { id: true, name: true } });
      if (!d) throw new TechError("Diagrama no encontrado", 404);
      await prisma.lubricationDiagram.delete({ where: { id: d.id } });
      logAudit({ plantId: req.currentPlantId, userId: req.user.id, action: "DELETE", model: "LubricationDiagram", recordId: d.id, changes: { before: { name: d.name } }, ip: req.ip });
      return res.json({ ok: true });
    } catch (e) {
      return fail(res, e, "DELETE diagram");
    }
  });

  return router;
}
