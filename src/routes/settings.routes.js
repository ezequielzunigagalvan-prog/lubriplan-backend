// src/routes/settings.routes.js
// Ajustes de la planta actual. Antes había una sola fila global: cambiar un ajuste en una planta
// lo cambiaba en todas. Ahora cada planta guarda los suyos (ver services/plantSettings.js).
import express from "express";
import { logger } from "../config/logger.js";
import { logAudit } from "../services/audit.service.js";
import { getPlantSettings, savePlantSettings, SETTING_KEYS } from "../services/plantSettings.js";

const TYPES = {
  overloadWindowDays: { type: "int", min: 1, max: 60 },
  overloadOverdueLookbackDays: { type: "int", min: 1, max: 365 },
  overloadCapacityPerDay: { type: "int", min: 1, max: 50 },
  overloadWarnRatio: { type: "float", min: 1, max: 5 },
  overloadCriticalRatio: { type: "float", min: 1, max: 5 },
};

const LABELS = {
  executionEvidenceRequired: "evidencia obligatoria",
  preventNegativeStock: "evitar stock negativo",
  lowStockWarningEnabled: "alertas de bajo stock",
  technicianOverloadEnabled: "sobrecarga de técnicos",
  predictiveAlertsEnabled: "alertas predictivas",
  aiSummaryEnabled: "resumen IA",
  criticalActivityEmailEnabled: "correo de actividad crítica",
  conditionReportEmailEnabled: "correo de reporte de condición",
  overdueSummaryEmailEnabled: "correo de vencidas",
  monthlyReportEmailEnabled: "reporte mensual",
  monthlyTechSummaryEnabled: "resumen mensual a técnicos",
  requiresPhotoOLP: "foto en órdenes preventivas",
};

/** Valida el cuerpo y devuelve { data } o { error }. */
export function parseSettingsPatch(body = {}) {
  const data = {};
  for (const k of SETTING_KEYS) {
    if (body[k] === undefined) continue;
    const v = body[k];
    const spec = TYPES[k];
    if (!spec) {
      if (typeof v !== "boolean") return { error: `${LABELS[k] || k}: debe ser verdadero o falso` };
      data[k] = v;
      continue;
    }
    const n = Number(v);
    if (!Number.isFinite(n)) return { error: `${k} debe ser un número` };
    const val = spec.type === "int" ? Math.trunc(n) : Math.round(n * 100) / 100;
    if (val < spec.min || val > spec.max) return { error: `${k} debe estar entre ${spec.min} y ${spec.max}` };
    data[k] = val;
  }
  return { data };
}

export default function settingsRoutes({ prisma, auth, requireRole }) {
  const router = express.Router();

  // GET /api/settings — ajustes efectivos de la planta actual
  router.get("/settings", auth, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });
      const settings = await getPlantSettings(prisma, plantId);
      return res.json({ ok: true, settings, scope: settings.scope });
    } catch (e) {
      logger.error("GET /settings error:", e);
      return res.status(500).json({ error: "Error cargando ajustes" });
    }
  });

  // PATCH /api/settings — solo ADMIN, solo afecta a la planta actual
  router.patch("/settings", auth, requireRole(["ADMIN"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const parsed = parseSettingsPatch(req.body || {});
      if (parsed.error) return res.status(400).json({ error: parsed.error });

      const before = await getPlantSettings(prisma, plantId);
      const warn = parsed.data.overloadWarnRatio ?? before.overloadWarnRatio;
      const crit = parsed.data.overloadCriticalRatio ?? before.overloadCriticalRatio;
      if (Number(warn) >= Number(crit)) {
        return res.status(400).json({ error: "El umbral de aviso debe ser menor que el crítico" });
      }

      const changed = {};
      for (const [k, v] of Object.entries(parsed.data)) if (before[k] !== v) changed[k] = { before: before[k], after: v };
      if (!Object.keys(changed).length) return res.json({ ok: true, settings: before, scope: before.scope, unchanged: true });

      await savePlantSettings(prisma, plantId, parsed.data);
      const settings = await getPlantSettings(prisma, plantId);

      logAudit({
        plantId,
        userId: req.user?.id,
        action: "UPDATE",
        model: "AppSettings",
        recordId: plantId,
        changes: {
          before: Object.fromEntries(Object.entries(changed).map(([k, x]) => [k, x.before])),
          after: Object.fromEntries(Object.entries(changed).map(([k, x]) => [k, x.after])),
        },
        ip: req.ip,
      });

      return res.json({ ok: true, settings, scope: settings.scope });
    } catch (e) {
      logger.error("PATCH /settings error:", e);
      return res.status(500).json({ error: "Error guardando ajustes" });
    }
  });

  return router;
}
