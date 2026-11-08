import { Router } from "express";
import { logger } from "../../../config/logger.js";
import { predictEquipmentDegradation, getRiskAssessment } from "./predictiveService.js";

const router = Router();

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
