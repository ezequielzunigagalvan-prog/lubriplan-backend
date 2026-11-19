import { Router } from "express";
import { logger } from "../../../config/logger.js";
import { predictEquipmentDegradation, getRiskAssessment } from "./predictiveService.js";
import { getEquipmentAnalytics } from "./equipmentService.js";
import { getFailureAnalysis } from "./failureAnalysisService.js";

const router = Router();

// GET /api/maintenance/analytics/failures?days=180 — Pareto de modos, mecanismos y causas raíz
router.get("/failures", async (req, res) => {
  try {
    const days = Math.min(1825, Math.max(7, parseInt(req.query.days, 10) || 180));
    res.json({ data: await getFailureAnalysis(req.currentPlantId, { days }) });
  } catch (error) {
    logger.error("[GET /analytics/failures]", error);
    res.status(500).json({ error: "Error generating failure analysis" });
  }
});

// GET /api/maintenance/analytics/equipment?days=90 — KPIs de planta y métricas por equipo
router.get("/equipment", async (req, res) => {
  try {
    const days = Math.min(365, Math.max(7, parseInt(req.query.days, 10) || 90));
    const data = await getEquipmentAnalytics(req.currentPlantId, { days });
    res.json({ data });
  } catch (error) {
    logger.error("[GET /analytics/equipment]", error);
    res.status(500).json({ error: "Error generating equipment analytics" });
  }
});

// GET /api/maintenance/analytics/risk-assessment
router.get("/risk-assessment", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const assessments = await getRiskAssessment(plantId);
    res.json(assessments);
  } catch (error) {
    logger.error("[GET /analytics/risk-assessment]", error);
    res.status(500).json({ error: "Error generating risk assessment" });
  }
});

// GET /api/maintenance/analytics/predict/:assetId
router.get("/predict/:assetId", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const assetId = parseInt(req.params.assetId);

    const prediction = await predictEquipmentDegradation(assetId, plantId);
    res.json(prediction);
  } catch (error) {
    logger.error("[GET /analytics/predict/:assetId]", error);
    res.status(500).json({ error: "Error generating prediction" });
  }
});

export default router;
