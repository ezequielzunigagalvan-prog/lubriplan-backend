// src/routes/webhooks.routes.js
import express from "express";
import crypto from "crypto";
import { retryDelivery } from "../services/webhooks.service.js";

const VALID_EVENTS = [
  "EXECUTION_COMPLETED",
  "CONDITION_REPORT_CREATED",
  "LUBRICANT_LOW_STOCK",
  "OIL_SAMPLE_ALERT",
  "PURCHASE_ORDER_APPROVED",
  "PURCHASE_ORDER_RECEIVED",
];

export default function webhooksRoutes({ prisma, auth, requireRole }) {
  const router = express.Router();

  // GET /api/webhooks
  router.get("/webhooks", auth, requireRole(["ADMIN"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const endpoints = await prisma.webhookEndpoint.findMany({
        where: { plantId },
        orderBy: { createdAt: "desc" },
        include: {
          _count: { select: { deliveries: true } },
        },
      });

      // Ocultar secret en listado
      const items = endpoints.map(({ secret: _s, ...ep }) => ({
        ...ep,
        secretHint: `****${_s.slice(-4)}`,
      }));

      return res.json({ ok: true, items });
    } catch (e) {
      console.error("GET /webhooks error:", e);
      return res.status(500).json({ error: "Error cargando webhooks" });
    }
  });

  // POST /api/webhooks
  router.post("/webhooks", auth, requireRole(["ADMIN"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const { url, events, description } = req.body;
      if (!url || !url.startsWith("https://")) {
        return res.status(400).json({ error: "URL requerida y debe ser HTTPS" });
      }
      if (!Array.isArray(events) || events.length === 0) {
        return res.status(400).json({ error: "Se requiere al menos un evento" });
      }

      const invalidEvents = events.filter((e) => !VALID_EVENTS.includes(e));
      if (invalidEvents.length > 0) {
        return res.status(400).json({ error: `Eventos inválidos: ${invalidEvents.join(", ")}` });
      }

      const secret = crypto.randomBytes(32).toString("hex");

      const endpoint = await prisma.webhookEndpoint.create({
        data: { plantId, url, events, secret, description: description || null },
      });

      return res.status(201).json({
        ok: true,
        endpoint: { ...endpoint, secret }, // secret visible solo en creación
      });
    } catch (e) {
      console.error("POST /webhooks error:", e);
      return res.status(500).json({ error: "Error creando webhook" });
    }
  });

  // PATCH /api/webhooks/:id
  router.patch("/webhooks/:id", auth, requireRole(["ADMIN"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

      const existing = await prisma.webhookEndpoint.findFirst({ where: { id, plantId } });
      if (!existing) return res.status(404).json({ error: "Endpoint no encontrado" });

      const data = {};
      if (req.body.url != null) {
        if (!String(req.body.url).startsWith("https://")) return res.status(400).json({ error: "URL debe ser HTTPS" });
        data.url = String(req.body.url);
      }
      if (req.body.active != null) data.active = Boolean(req.body.active);
      if (req.body.description != null) data.description = String(req.body.description);
      if (Array.isArray(req.body.events)) {
        const invalid = req.body.events.filter((e) => !VALID_EVENTS.includes(e));
        if (invalid.length > 0) return res.status(400).json({ error: `Eventos inválidos: ${invalid.join(", ")}` });
        data.events = req.body.events;
      }

      if (Object.keys(data).length === 0) return res.status(400).json({ error: "Sin campos a actualizar" });

      const endpoint = await prisma.webhookEndpoint.update({ where: { id }, data });
      const { secret: _s, ...safe } = endpoint;
      return res.json({ ok: true, endpoint: { ...safe, secretHint: `****${_s.slice(-4)}` } });
    } catch (e) {
      console.error("PATCH /webhooks/:id error:", e);
      return res.status(500).json({ error: "Error actualizando webhook" });
    }
  });

  // POST /api/webhooks/:id/rotate-secret
  router.post("/webhooks/:id/rotate-secret", auth, requireRole(["ADMIN"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

      const existing = await prisma.webhookEndpoint.findFirst({ where: { id, plantId } });
      if (!existing) return res.status(404).json({ error: "Endpoint no encontrado" });

      const secret = crypto.randomBytes(32).toString("hex");
      await prisma.webhookEndpoint.update({ where: { id }, data: { secret } });

      return res.json({ ok: true, secret }); // nuevo secret visible solo aquí
    } catch (e) {
      console.error("POST /webhooks/:id/rotate-secret error:", e);
      return res.status(500).json({ error: "Error rotando secret" });
    }
  });

  // DELETE /api/webhooks/:id
  router.delete("/webhooks/:id", auth, requireRole(["ADMIN"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

      const existing = await prisma.webhookEndpoint.findFirst({ where: { id, plantId } });
      if (!existing) return res.status(404).json({ error: "Endpoint no encontrado" });

      await prisma.webhookEndpoint.delete({ where: { id } });
      return res.json({ ok: true });
    } catch (e) {
      console.error("DELETE /webhooks/:id error:", e);
      return res.status(500).json({ error: "Error eliminando webhook" });
    }
  });

  // GET /api/webhooks/:id/deliveries
  router.get("/webhooks/:id/deliveries", auth, requireRole(["ADMIN"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const endpointId = Number(req.params.id);
      if (!Number.isFinite(endpointId)) return res.status(400).json({ error: "ID inválido" });

      const endpoint = await prisma.webhookEndpoint.findFirst({ where: { id: endpointId, plantId } });
      if (!endpoint) return res.status(404).json({ error: "Endpoint no encontrado" });

      const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
      const offset = Math.max(0, Number(req.query.offset || 0));
      const status = req.query.status ? String(req.query.status).toUpperCase() : null;

      const where = { endpointId, ...(status ? { status } : {}) };

      const [deliveries, total] = await Promise.all([
        prisma.webhookDelivery.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: limit,
          skip: offset,
          select: {
            id: true, event: true, status: true, attempts: true,
            lastAttemptAt: true, responseStatus: true, responseBody: true, createdAt: true,
          },
        }),
        prisma.webhookDelivery.count({ where }),
      ]);

      return res.json({ ok: true, deliveries, total });
    } catch (e) {
      console.error("GET /webhooks/:id/deliveries error:", e);
      return res.status(500).json({ error: "Error cargando entregas" });
    }
  });

  // POST /api/webhooks/deliveries/:deliveryId/retry
  router.post("/webhooks/deliveries/:deliveryId/retry", auth, requireRole(["ADMIN"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const deliveryId = Number(req.params.deliveryId);
      if (!Number.isFinite(deliveryId)) return res.status(400).json({ error: "ID inválido" });

      // Verify ownership
      const delivery = await prisma.webhookDelivery.findFirst({
        where: { id: deliveryId, endpoint: { plantId } },
      });
      if (!delivery) return res.status(404).json({ error: "Entrega no encontrada" });

      const updated = await retryDelivery(prisma, deliveryId);
      return res.json({ ok: true, delivery: updated });
    } catch (e) {
      console.error("POST /webhooks/deliveries/:id/retry error:", e);
      return res.status(400).json({ error: e?.message || "Error en reintento" });
    }
  });

  return router;
}
