// src/routes/integrations.routes.js
import express from "express";
import multer from "multer";
import { encrypt } from "../services/integration/crypto.js";
import { testConnection, syncAssets, syncWorkOrders } from "../services/integration/integrationService.js";
import { parseAssetFile, buildExecutionsExcel } from "../services/integration/csvConnector.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const VALID_TYPES = ["MAXIMO", "SAP_ODATA", "SAP_RFC", "CSV"];

export default function integrationsRoutes({ prisma, auth, requireRole }) {
  const router = express.Router();

  // GET /api/integrations
  router.get("/integrations", auth, requireRole(["ADMIN"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const configs = await prisma.integrationConfig.findMany({
        where: { plantId },
        orderBy: { createdAt: "desc" },
        include: {
          _count: { select: { assetMappings: true, syncLogs: true } },
        },
      });

      const safe = configs.map(({ apiKey: _a, passwordEnc: _p, ...cfg }) => ({
        ...cfg,
        hasApiKey: Boolean(_a),
        hasPassword: Boolean(_p),
      }));

      return res.json({ ok: true, items: safe });
    } catch (e) {
      return res.status(500).json({ error: "Error cargando integraciones" });
    }
  });

  // POST /api/integrations
  router.post("/integrations", auth, requireRole(["ADMIN"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const { type, name, baseUrl, apiKey, username, password, extra } = req.body;
      if (!type || !VALID_TYPES.includes(type)) {
        return res.status(400).json({ error: `Tipo inválido. Válidos: ${VALID_TYPES.join(", ")}` });
      }
      if (!name || !String(name).trim()) return res.status(400).json({ error: "nombre requerido" });

      const cfg = await prisma.integrationConfig.create({
        data: {
          plantId,
          type,
          name: String(name).trim(),
          baseUrl: baseUrl ? String(baseUrl).trim() : null,
          apiKey: apiKey ? encrypt(String(apiKey)) : null,
          username: username ? String(username).trim() : null,
          passwordEnc: password ? encrypt(String(password)) : null,
          extra: extra || null,
        },
      });

      const { apiKey: _a, passwordEnc: _p, ...safe } = cfg;
      return res.status(201).json({ ok: true, item: { ...safe, hasApiKey: Boolean(_a), hasPassword: Boolean(_p) } });
    } catch (e) {
      return res.status(500).json({ error: "Error creando integración" });
    }
  });

  // PATCH /api/integrations/:id
  router.patch("/integrations/:id", auth, requireRole(["ADMIN"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

      const existing = await prisma.integrationConfig.findFirst({ where: { id, plantId } });
      if (!existing) return res.status(404).json({ error: "Integración no encontrada" });

      const data = {};
      if (req.body.name != null) data.name = String(req.body.name).trim();
      if (req.body.baseUrl != null) data.baseUrl = String(req.body.baseUrl).trim() || null;
      if (req.body.active != null) data.active = Boolean(req.body.active);
      if (req.body.extra != null) data.extra = req.body.extra;
      if (req.body.apiKey) data.apiKey = encrypt(String(req.body.apiKey));
      if (req.body.username != null) data.username = String(req.body.username).trim() || null;
      if (req.body.password) data.passwordEnc = encrypt(String(req.body.password));

      if (Object.keys(data).length === 0) return res.status(400).json({ error: "Sin campos a actualizar" });

      const updated = await prisma.integrationConfig.update({ where: { id }, data });
      const { apiKey: _a, passwordEnc: _p, ...safe } = updated;
      return res.json({ ok: true, item: { ...safe, hasApiKey: Boolean(_a), hasPassword: Boolean(_p) } });
    } catch (e) {
      return res.status(500).json({ error: "Error actualizando integración" });
    }
  });

  // DELETE /api/integrations/:id
  router.delete("/integrations/:id", auth, requireRole(["ADMIN"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

      const existing = await prisma.integrationConfig.findFirst({ where: { id, plantId } });
      if (!existing) return res.status(404).json({ error: "Integración no encontrada" });

      await prisma.integrationConfig.delete({ where: { id } });
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: "Error eliminando integración" });
    }
  });

  // POST /api/integrations/:id/test
  router.post("/integrations/:id/test", auth, requireRole(["ADMIN"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

      const cfg = await prisma.integrationConfig.findFirst({ where: { id, plantId } });
      if (!cfg) return res.status(404).json({ error: "Integración no encontrada" });

      const result = await testConnection(cfg);
      return res.json({ ok: true, ...result });
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message });
    }
  });

  // POST /api/integrations/:id/sync/assets
  router.post("/integrations/:id/sync/assets", auth, requireRole(["ADMIN"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

      const cfg = await prisma.integrationConfig.findFirst({ where: { id, plantId } });
      if (!cfg) return res.status(404).json({ error: "Integración no encontrada" });
      if (!cfg.active) return res.status(400).json({ error: "Integración inactiva" });

      const result = await syncAssets(prisma, cfg);
      return res.json({ ok: true, ...result });
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message });
    }
  });

  // POST /api/integrations/:id/sync/workorders
  router.post("/integrations/:id/sync/workorders", auth, requireRole(["ADMIN"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

      const cfg = await prisma.integrationConfig.findFirst({ where: { id, plantId } });
      if (!cfg) return res.status(404).json({ error: "Integración no encontrada" });
      if (!cfg.active) return res.status(400).json({ error: "Integración inactiva" });

      const result = await syncWorkOrders(prisma, cfg, plantId);
      return res.json({ ok: true, ...result });
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message });
    }
  });

  // GET /api/integrations/:id/mappings
  router.get("/integrations/:id/mappings", auth, requireRole(["ADMIN"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

      const cfg = await prisma.integrationConfig.findFirst({ where: { id, plantId } });
      if (!cfg) return res.status(404).json({ error: "Integración no encontrada" });

      const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
      const page = Math.max(1, Number(req.query.page || 1));
      const search = req.query.search ? String(req.query.search) : null;

      const where = {
        integrationId: id,
        ...(search
          ? {
              OR: [
                { externalId: { contains: search, mode: "insensitive" } },
                { externalName: { contains: search, mode: "insensitive" } },
              ],
            }
          : {}),
      };

      const [mappings, total] = await Promise.all([
        prisma.assetMapping.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: limit,
          skip: (page - 1) * limit,
          include: {
            equipment: { select: { id: true, name: true, code: true, location: true } },
          },
        }),
        prisma.assetMapping.count({ where }),
      ]);

      return res.json({ ok: true, mappings, total, pages: Math.max(1, Math.ceil(total / limit)) });
    } catch (e) {
      return res.status(500).json({ error: "Error cargando mappings" });
    }
  });

  // PATCH /api/integrations/:id/mappings/:mid
  router.patch("/integrations/:id/mappings/:mid", auth, requireRole(["ADMIN"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const id = Number(req.params.id);
      const mid = Number(req.params.mid);
      if (!Number.isFinite(id) || !Number.isFinite(mid)) return res.status(400).json({ error: "ID inválido" });

      const cfg = await prisma.integrationConfig.findFirst({ where: { id, plantId } });
      if (!cfg) return res.status(404).json({ error: "Integración no encontrada" });

      const mapping = await prisma.assetMapping.findFirst({ where: { id: mid, integrationId: id } });
      if (!mapping) return res.status(404).json({ error: "Mapping no encontrado" });

      const data = {};
      if (req.body.equipmentId != null) {
        const eqId = req.body.equipmentId === null ? null : Number(req.body.equipmentId);
        if (eqId !== null) {
          const eq = await prisma.equipment.findFirst({ where: { id: eqId, plantId } });
          if (!eq) return res.status(400).json({ error: "Equipo no encontrado en esta planta" });
        }
        data.equipmentId = eqId;
      }
      if (req.body.confirmed != null) data.confirmed = Boolean(req.body.confirmed);

      if (Object.keys(data).length === 0) return res.status(400).json({ error: "Sin campos a actualizar" });

      const updated = await prisma.assetMapping.update({
        where: { id: mid },
        data,
        include: { equipment: { select: { id: true, name: true, code: true } } },
      });

      return res.json({ ok: true, mapping: updated });
    } catch (e) {
      return res.status(500).json({ error: "Error actualizando mapping" });
    }
  });

  // DELETE /api/integrations/:id/mappings/:mid
  router.delete("/integrations/:id/mappings/:mid", auth, requireRole(["ADMIN"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const id = Number(req.params.id);
      const mid = Number(req.params.mid);
      if (!Number.isFinite(id) || !Number.isFinite(mid)) return res.status(400).json({ error: "ID inválido" });

      const cfg = await prisma.integrationConfig.findFirst({ where: { id, plantId } });
      if (!cfg) return res.status(404).json({ error: "Integración no encontrada" });

      await prisma.assetMapping.deleteMany({ where: { id: mid, integrationId: id } });
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: "Error eliminando mapping" });
    }
  });

  // GET /api/integrations/:id/logs
  router.get("/integrations/:id/logs", auth, requireRole(["ADMIN"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

      const cfg = await prisma.integrationConfig.findFirst({ where: { id, plantId } });
      if (!cfg) return res.status(404).json({ error: "Integración no encontrada" });

      const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
      const page = Math.max(1, Number(req.query.page || 1));

      const [logs, total] = await Promise.all([
        prisma.integrationSyncLog.findMany({
          where: { integrationId: id },
          orderBy: { startedAt: "desc" },
          take: limit,
          skip: (page - 1) * limit,
        }),
        prisma.integrationSyncLog.count({ where: { integrationId: id } }),
      ]);

      return res.json({ ok: true, logs, total, pages: Math.max(1, Math.ceil(total / limit)) });
    } catch (e) {
      return res.status(500).json({ error: "Error cargando logs de sincronización" });
    }
  });

  // POST /api/integrations/csv/import  (multer upload)
  router.post(
    "/integrations/csv/import",
    auth,
    requireRole(["ADMIN"]),
    upload.single("file"),
    async (req, res) => {
      try {
        const plantId = req.currentPlantId;
        if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

        const integrationId = req.body.integrationId ? Number(req.body.integrationId) : null;
        if (!integrationId || !Number.isFinite(integrationId)) {
          return res.status(400).json({ error: "integrationId requerido" });
        }

        const cfg = await prisma.integrationConfig.findFirst({ where: { id: integrationId, plantId, type: "CSV" } });
        if (!cfg) return res.status(404).json({ error: "Integración CSV no encontrada" });

        if (!req.file) return res.status(400).json({ error: "Archivo requerido" });

        const assets = await parseAssetFile(req.file.buffer, req.file.originalname);
        if (!assets.length) return res.status(400).json({ error: "No se encontraron registros en el archivo" });

        let created = 0;
        let updated = 0;
        const errors = [];

        for (const asset of assets) {
          try {
            const existing = await prisma.assetMapping.findUnique({
              where: { integrationId_externalId: { integrationId, externalId: asset.externalId } },
            });
            if (existing) {
              await prisma.assetMapping.update({
                where: { id: existing.id },
                data: { externalName: asset.externalName, externalData: asset.externalData },
              });
              updated++;
            } else {
              await prisma.assetMapping.create({
                data: { integrationId, externalId: asset.externalId, externalName: asset.externalName, externalData: asset.externalData },
              });
              created++;
            }
          } catch (err) {
            errors.push({ externalId: asset.externalId, message: err.message });
          }
        }

        await prisma.integrationConfig.update({ where: { id: integrationId }, data: { lastSyncAt: new Date() } });

        return res.json({ ok: true, total: assets.length, created, updated, errors: errors.length, errorDetails: errors });
      } catch (e) {
        return res.status(400).json({ error: e.message || "Error procesando archivo" });
      }
    }
  );

  // GET /api/integrations/csv/export
  router.get("/integrations/csv/export", auth, requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const days = Math.min(365, Math.max(1, Number(req.query.days || 30)));
      const since = new Date(Date.now() - days * 86400_000);

      const executions = await prisma.execution.findMany({
        where: { plantId, status: "COMPLETED", executedAt: { gte: since } },
        include: {
          route: { select: { name: true, equipment: { select: { name: true } } } },
          equipment: { select: { name: true } },
          technician: { select: { name: true } },
        },
        orderBy: { executedAt: "desc" },
        take: 5000,
      });

      const buffer = await buildExecutionsExcel(executions);

      const filename = `ejecuciones_${new Date().toISOString().slice(0, 10)}.xlsx`;
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      return res.send(Buffer.from(buffer));
    } catch (e) {
      return res.status(500).json({ error: "Error generando exportación" });
    }
  });

  return router;
}
