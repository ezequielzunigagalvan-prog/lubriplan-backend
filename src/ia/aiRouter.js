// src/ia/aiRouter.js
import express from "express";
import { getAISummary } from "./aiService.js";
import { cacheInvalidatePrefix } from "./aiCache.js";
import {
  AI_MODE,
  AI_LANG_DEFAULT,
  AI_RATE_LIMIT_PLANT_PER_HOUR,
  AI_RATE_LIMIT_USER_PER_HOUR,
  AI_SCHEMA_VERSION,
} from "./aiConfig.js";
import { dualRateLimit } from "./aiRateLimit.js";

export default function aiRouter({
  prisma,
  requireAuth,
  requireRole,
  buildDashboardSummary,
  toStartOfDaySafe, // ✅ inyéctalo desde index.js
}) {
  const router = express.Router();

  // ✅ GET /api/ai/summary?plantId=&month=YYYY-MM&lang=
  router.get(
  "/summary",
  requireAuth,
  requireRole(["ADMIN", "SUPERVISOR", "TECHNICIAN"]),
  async (req, res) => {
    try {
      const role = String(req.user?.role || "").toUpperCase();
      const userId = req.user?.id ?? null;

      const currentPlantId = Number(req.currentPlantId);
      if (!Number.isFinite(currentPlantId) || currentPlantId <= 0) {
        return res.status(400).json({ error: "PLANT_REQUIRED" });
      }

      // Soporta month o period
      const month = String(req.query.month || req.query.period || "").trim();
      const monthOk = /^\d{4}-\d{2}$/.test(month);

      const lang = String(req.query.lang || AI_LANG_DEFAULT).trim() || AI_LANG_DEFAULT;

      const finalMonth = monthOk
        ? month
        : `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;

      // El query plantId se ignora como fuente de verdad.
      // Si quieres, puedes validarlo para detectar inconsistencias.
      const requestedPlantId =
        req.query.plantId == null || String(req.query.plantId).trim() === ""
          ? null
          : Number(req.query.plantId);

      if (
        requestedPlantId != null &&
        Number.isFinite(requestedPlantId) &&
        requestedPlantId !== currentPlantId
      ) {
        return res.status(403).json({ error: "PLANT_MISMATCH" });
      }

      if (AI_MODE === "provider") {
        const rl = dualRateLimit({
          userId,
          plantId: String(currentPlantId),
          userLimitPerHour: AI_RATE_LIMIT_USER_PER_HOUR,
          plantLimitPerHour: AI_RATE_LIMIT_PLANT_PER_HOUR,
        });

        if (!rl.ok) {
          return res.status(429).json({
            error: "Rate limit excedido",
            details: rl,
          });
        }
      }

      const dashboard = await buildDashboardSummary({
        prisma,
        user: req.user,
        month: finalMonth,
        days: 30,
        plantId: currentPlantId,
        toStartOfDaySafe,
      });

      const ai = await getAISummary({
        month: finalMonth,
        plantId: String(currentPlantId),
        role,
        userId,
        lang,
        schemaVersion: AI_SCHEMA_VERSION,
        dashboard,
      });

      return res.json({
        ok: true,
        cached: ai.cached,
        model: ai.model,
        generatedAt: ai.generatedAt,
        summary: ai.summary,
      });
    } catch (e) {
      console.error("AI summary error:", e);
      return res.status(500).json({ error: "Error AI summary" });
    }
  }
);

  // ✅ POST /api/ai/summary/refresh (ADMIN) -> invalida cache
  router.post(
    "/summary/refresh",
    requireAuth,
    requireRole(["ADMIN"]),
    async (req, res) => {
      try {
        // (por ahora invalidamos todo el namespace)
        cacheInvalidatePrefix("ai:summary:");
        return res.json({ ok: true, message: "Cache IA invalidada" });
      } catch (e) {
        console.error("AI refresh error:", e);
        return res.status(500).json({ error: "Error AI refresh" });
      }
    }
  );

  return router;
}
