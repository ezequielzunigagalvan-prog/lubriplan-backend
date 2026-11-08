import { Router } from "express";
import { logger } from "../../../config/logger.js";
import {
  generateAssetHistoryReport,
  generatePlantSummaryReport,
  generateWeeklyDigest,
} from "./reportService.js";

const router = Router();

// GET /api/maintenance/reports/asset/:assetId
router.get("/asset/:assetId", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const assetId = parseInt(req.params.assetId);
    const format = req.query.format || "json";

    const report = await generateAssetHistoryReport(assetId, plantId, format);

    if (!report) {
      return res.status(404).json({ error: "Asset not found" });
    }

    if (format === "json") {
      res.json(report);
    } else if (format === "pdf") {
      // TODO: Generate PDF using pdfkit or puppeteer
      res.json({ ...report, format: "pdf-pending" });
    } else if (format === "excel") {
      // TODO: Generate Excel using exceljs
      res.json({ ...report, format: "excel-pending" });
    } else {
      res.json(report);
    }
  } catch (error) {
    logger.error("[GET /reports/asset/:assetId]", error);
    res.status(500).json({ error: "Error generating report" });
  }
});

// GET /api/maintenance/reports/plant-summary
router.get("/plant-summary", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const report = await generatePlantSummaryReport(plantId);
    res.json(report);
  } catch (error) {
    logger.error("[GET /reports/plant-summary]", error);
    res.status(500).json({ error: "Error generating plant summary" });
  }
});

// GET /api/maintenance/reports/weekly-digest
router.get("/weekly-digest", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const digest = await generateWeeklyDigest(plantId);
    res.json(digest);
  } catch (error) {
    logger.error("[GET /reports/weekly-digest]", error);
    res.status(500).json({ error: "Error generating weekly digest" });
  }
});

export default router;
