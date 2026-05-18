// src/routes/oilSamples.routes.js
import express from "express";
import { createAuditLog } from "../services/auditLog.service.js";
import { fireWebhookEvent } from "../services/webhooks.service.js";

const OIL_SAMPLE_FIELDS = [
  "sampledAt", "labReference", "labReportUrl",
  "viscosity40", "viscosity100", "tan", "tbn", "waterPct", "flashPoint",
  "ironPpm", "copperPpm", "aluminumPpm", "leadPpm", "chromiumPpm", "siliconPpm",
  "particleCount", "particleIso", "status", "notes",
  "lubricantId",
];

function deriveStatus(body) {
  // Auto-status si no viene explícito
  if (body.status && body.status !== "PENDING") return body.status;

  const flags = [];
  if (body.waterPct != null && Number(body.waterPct) > 0.1) flags.push("CAUTION");
  if (body.waterPct != null && Number(body.waterPct) > 0.5) flags.push("CRITICAL");
  if (body.ironPpm != null && Number(body.ironPpm) > 100) flags.push("CAUTION");
  if (body.ironPpm != null && Number(body.ironPpm) > 250) flags.push("CRITICAL");
  if (body.copperPpm != null && Number(body.copperPpm) > 50) flags.push("CAUTION");

  if (flags.includes("CRITICAL")) return "CRITICAL";
  if (flags.includes("CAUTION")) return "CAUTION";
  if (body.viscosity40 != null || body.ironPpm != null) return "NORMAL";
  return "PENDING";
}

export default function oilSamplesRoutes({ prisma, auth, requireRole }) {
  const router = express.Router();

  // GET /api/oil-samples
  router.get("/oil-samples", auth, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const equipmentId = req.query.equipmentId ? Number(req.query.equipmentId) : null;
      const status = req.query.status ? String(req.query.status).toUpperCase() : null;
      const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
      const offset = Math.max(0, Number(req.query.offset || 0));

      const where = {
        plantId,
        ...(equipmentId ? { equipmentId } : {}),
        ...(status ? { status } : {}),
      };

      const [items, total] = await Promise.all([
        prisma.oilSample.findMany({
          where,
          orderBy: { sampledAt: "desc" },
          take: limit,
          skip: offset,
          include: {
            equipment: { select: { id: true, name: true, code: true } },
            lubricant: { select: { id: true, name: true, unit: true } },
          },
        }),
        prisma.oilSample.count({ where }),
      ]);

      return res.json({ ok: true, items, total });
    } catch (e) {
      console.error("GET /oil-samples error:", e);
      return res.status(500).json({ error: "Error cargando muestras" });
    }
  });

  // GET /api/oil-samples/:id
  router.get("/oil-samples/:id", auth, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

      const sample = await prisma.oilSample.findFirst({
        where: { id, plantId },
        include: {
          equipment: { select: { id: true, name: true, code: true, location: true } },
          lubricant: { select: { id: true, name: true, unit: true, viscosity: true, isoVg: true } },
        },
      });

      if (!sample) return res.status(404).json({ error: "Muestra no encontrada" });
      return res.json({ ok: true, sample });
    } catch (e) {
      console.error("GET /oil-samples/:id error:", e);
      return res.status(500).json({ error: "Error cargando muestra" });
    }
  });

  // GET /api/oil-samples/equipment/:equipmentId/trend
  router.get("/oil-samples/equipment/:equipmentId/trend", auth, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const equipmentId = Number(req.params.equipmentId);
      if (!Number.isFinite(equipmentId)) return res.status(400).json({ error: "ID inválido" });

      const samples = await prisma.oilSample.findMany({
        where: { plantId, equipmentId },
        orderBy: { sampledAt: "asc" },
        select: {
          id: true, sampledAt: true, status: true,
          viscosity40: true, viscosity100: true, tan: true, tbn: true,
          waterPct: true, ironPpm: true, copperPpm: true, particleCount: true,
          lubricant: { select: { id: true, name: true } },
        },
      });

      const labels = samples.map((s) => s.sampledAt.toISOString().slice(0, 10));
      const build = (field) => samples.map((s) => s[field] ?? null);

      return res.json({
        ok: true,
        equipmentId,
        sampleCount: samples.length,
        labels,
        series: {
          viscosity40: build("viscosity40"),
          viscosity100: build("viscosity100"),
          tan: build("tan"),
          tbn: build("tbn"),
          waterPct: build("waterPct"),
          ironPpm: build("ironPpm"),
          copperPpm: build("copperPpm"),
          particleCount: build("particleCount"),
        },
        statuses: samples.map((s) => s.status),
        samples,
      });
    } catch (e) {
      console.error("GET /oil-samples/equipment/:id/trend error:", e);
      return res.status(500).json({ error: "Error calculando tendencia" });
    }
  });

  // POST /api/oil-samples
  router.post("/oil-samples", auth, requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const { equipmentId, sampledAt } = req.body;
      if (!equipmentId) return res.status(400).json({ error: "equipmentId requerido" });
      if (!sampledAt) return res.status(400).json({ error: "sampledAt requerido" });

      const autoStatus = deriveStatus(req.body);

      const data = {
        plantId,
        equipmentId: Number(equipmentId),
        sampledAt: new Date(sampledAt),
        status: autoStatus,
      };

      for (const f of OIL_SAMPLE_FIELDS) {
        if (f === "sampledAt" || f === "status") continue;
        if (req.body[f] != null) {
          data[f] = typeof req.body[f] === "number" || !Number.isNaN(Number(req.body[f]))
            ? (["labReference", "labReportUrl", "particleIso", "notes"].includes(f) ? String(req.body[f]) : Number(req.body[f]))
            : String(req.body[f]);
        }
      }

      const sample = await prisma.oilSample.create({ data });

      await createAuditLog(prisma, {
        plantId, userId: req.user.id, userEmail: req.user.email,
        action: "CREATE", model: "OilSample", recordId: sample.id,
        changes: { after: { equipmentId: sample.equipmentId, status: sample.status } },
      });

      if (["CAUTION", "CRITICAL"].includes(sample.status)) {
        fireWebhookEvent(prisma, plantId, "OIL_SAMPLE_ALERT", {
          oilSampleId: sample.id,
          equipmentId: sample.equipmentId,
          status: sample.status,
        });
      }

      return res.status(201).json({ ok: true, sample });
    } catch (e) {
      console.error("POST /oil-samples error:", e);
      return res.status(500).json({ error: "Error registrando muestra" });
    }
  });

  // PATCH /api/oil-samples/:id
  router.patch("/oil-samples/:id", auth, requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

      const existing = await prisma.oilSample.findFirst({ where: { id, plantId } });
      if (!existing) return res.status(404).json({ error: "Muestra no encontrada" });

      const data = {};
      for (const f of OIL_SAMPLE_FIELDS) {
        if (req.body[f] == null) continue;
        if (f === "sampledAt") { data.sampledAt = new Date(req.body.sampledAt); continue; }
        if (["labReference", "labReportUrl", "particleIso", "notes", "status"].includes(f)) {
          data[f] = String(req.body[f]);
        } else {
          data[f] = Number(req.body[f]);
        }
      }

      if (Object.keys(data).length === 0) {
        return res.status(400).json({ error: "Sin campos a actualizar" });
      }

      // Re-derive status if not explicit
      if (!data.status) {
        data.status = deriveStatus({ ...existing, ...req.body });
      }

      const sample = await prisma.oilSample.update({ where: { id }, data });

      await createAuditLog(prisma, {
        plantId, userId: req.user.id, userEmail: req.user.email,
        action: "UPDATE", model: "OilSample", recordId: id,
        changes: { after: data },
      });

      return res.json({ ok: true, sample });
    } catch (e) {
      console.error("PATCH /oil-samples/:id error:", e);
      return res.status(500).json({ error: "Error actualizando muestra" });
    }
  });

  // DELETE /api/oil-samples/:id
  router.delete("/oil-samples/:id", auth, requireRole(["ADMIN"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

      const existing = await prisma.oilSample.findFirst({ where: { id, plantId } });
      if (!existing) return res.status(404).json({ error: "Muestra no encontrada" });

      await prisma.oilSample.delete({ where: { id } });
      return res.json({ ok: true });
    } catch (e) {
      console.error("DELETE /oil-samples/:id error:", e);
      return res.status(500).json({ error: "Error eliminando muestra" });
    }
  });

  return router;
}
