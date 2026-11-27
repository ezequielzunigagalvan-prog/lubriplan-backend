// src/ia/aiRouter.js
// Resumen inteligente del tablero — /api/ai/summary
//
// Correcciones:
//  - El límite por hora solo cuenta las llamadas reales a la IA (antes también las respuestas en caché).
//  - El mes por defecto es el de la planta (antes, el del reloj del servidor en UTC).
//  - "Regenerar" borra solo el caché de la planta actual (antes, el de todos los clientes).
//  - La respuesta indica si el texto lo escribió la IA o es el resumen de respaldo.
import express from "express";
import { getPlantSettings } from "../services/plantSettings.js";
import { logger } from "../config/logger.js";
import { getAISummary, AiRateLimitError } from "./aiService.js";
import { cacheInvalidatePrefix } from "./aiCache.js";
import {
  AI_MODE,
  AI_LANG_DEFAULT,
  AI_RATE_LIMIT_PLANT_PER_HOUR,
  AI_RATE_LIMIT_USER_PER_HOUR,
  AI_SCHEMA_VERSION,
} from "./aiConfig.js";
import { dualRateLimit } from "./aiRateLimit.js";
import { withVerifiedMonth } from "../routes/analysis.routes.js";
import { zonedYmd, safeTimeZone } from "../utils/tzRange.js";

export default function aiRouter({ prisma, requireAuth, requireRole, buildDashboardSummary, toStartOfDaySafe }) {
  const router = express.Router();

  // GET /api/ai/summary?month=YYYY-MM&lang=
  router.get("/summary", requireAuth, requireRole(["ADMIN", "SUPERVISOR", "TECHNICIAN"]), async (req, res) => {
    const plantId = Number(req.currentPlantId);
    try {
      const role = String(req.user?.role || "").toUpperCase();
      const userId = req.user?.id ?? null;
      if (!Number.isFinite(plantId) || plantId <= 0) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const settings = await getPlantSettings(prisma, plantId);
      if (settings?.aiSummaryEnabled === false) return res.json({ ok: true, disabled: true, summary: null });

      // El plantId del query solo se usa para detectar inconsistencias; la fuente es la planta del usuario.
      const requested = Number(req.query.plantId);
      if (Number.isFinite(requested) && requested > 0 && requested !== plantId) {
        return res.status(403).json({ error: "PLANT_MISMATCH" });
      }

      let month = String(req.query.month || req.query.period || "").trim();
      if (!/^\d{4}-\d{2}$/.test(month)) {
        const plant = await prisma.plant.findUnique({ where: { id: plantId }, select: { timezone: true } });
        month = zonedYmd(new Date(), safeTimeZone(plant?.timezone || "America/Mexico_City")).slice(0, 7);
      }
      // El resumen siempre se redacta en español; "es" y "es-MX" comparten caché.
      const lang = /^en/i.test(String(req.query.lang || "")) ? "en" : AI_LANG_DEFAULT;

      const rawDashboard = await buildDashboardSummary({ prisma, user: req.user, month, days: 30, plantId, toStartOfDaySafe });
      // Totales del mes verificados (los mismos del Reporte mensual) para que la IA no contradiga el reporte.
      const { dashboard } = await withVerifiedMonth(prisma, plantId, month, rawDashboard);

      const ai = await getAISummary({
        month,
        plantId: String(plantId),
        role,
        userId,
        lang,
        schemaVersion: AI_SCHEMA_VERSION,
        dashboard,
        beforeProviderCall:
          AI_MODE === "provider"
            ? () => {
                const rl = dualRateLimit({
                  userId,
                  plantId,
                  userLimitPerHour: AI_RATE_LIMIT_USER_PER_HOUR,
                  plantLimitPerHour: AI_RATE_LIMIT_PLANT_PER_HOUR,
                  namespace: "summary",
                });
                if (!rl.ok) throw new AiRateLimitError(rl);
              }
            : null,
      });

      return res.json({
        ok: true,
        cached: ai.cached,
        source: ai.source, // ai | fallback | rules
        model: ai.model,
        generatedAt: ai.generatedAt,
        summary: ai.summary,
      });
    } catch (e) {
      if (e?.code === "AI_RATE_LIMIT") {
        res.set("Retry-After", String(e.details?.retryAfterSec || 60));
        return res.status(429).json({
          error: "Se alcanzó el límite de resúmenes por hora. El último resumen sigue disponible.",
          retryAfter: e.details?.retryAfterSec || 60,
        });
      }
      logger.error("[AI resumen] error", { plantId, error: e?.message });
      return res.status(500).json({ error: "No se pudo generar el resumen inteligente" });
    }
  });

  // POST /api/ai/summary/refresh — ADMIN: borra el caché del resumen de la planta actual
  router.post("/summary/refresh", requireAuth, requireRole(["ADMIN"]), async (req, res) => {
    const plantId = Number(req.currentPlantId);
    if (!Number.isFinite(plantId) || plantId <= 0) return res.status(400).json({ error: "PLANT_REQUIRED" });
    const removed = cacheInvalidatePrefix(`ai:summary:${plantId}:`);
    logger.info("[AI resumen] caché invalidado", { plantId, removed, by: req.user?.id });
    return res.json({ ok: true, removed });
  });

  return router;
}
