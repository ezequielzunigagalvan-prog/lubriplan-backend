import express from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { runMonthlyExecutiveReportJob } from "../jobs/monthlyExecutiveReport.job.js";
import { logger } from "../config/logger.js";

export default function monthlyReportRoutes({
  prisma,
  requireRole,
  buildDashboardSummary,
  toStartOfDaySafe,
}) {
  const router = express.Router();

  router.post(
    "/monthly-report/send-now",
    requireAuth,
    requireRole(["ADMIN"]),
    async (req, res) => {
      try {
        const plantId = req.body?.plantId ? Number(req.body.plantId) : null;
        const month = String(req.body?.month || "").trim() || null;

        const result = await runMonthlyExecutiveReportJob({
          prisma,
          buildDashboardSummary,
          toStartOfDaySafe,
          forcePlantId: plantId,
          forceMonth: month,
        });

        return res.json({ ok: true, result });
      } catch (e) {
        logger.error("POST /monthly-report/send-now error:", e);
        return res.status(500).json({ error: "Error enviando reporte mensual" });
      }
    }
  );

  router.get(
    "/monthly-report/runs",
    requireAuth,
    requireRole(["ADMIN", "SUPERVISOR"]),
    async (req, res) => {
      try {
        // Solo la planta actual (validada en requireAuth); antes listaba envíos de todas las plantas.
        const plantId = req.currentPlantId;
        if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

        const items = await prisma.scheduledJobRun.findMany({
          where: { plantId },
          orderBy: [{ createdAt: "desc" }],
          take: 100,
          include: {
            plant: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        });

        return res.json({ ok: true, items });
      } catch (e) {
        logger.error("GET /monthly-report/runs error:", e);
        return res.status(500).json({ error: "Error obteniendo historial de envíos" });
      }
    }
  );

  return router;
}