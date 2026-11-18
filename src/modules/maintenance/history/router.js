import { Router } from "express";
import { logger } from "../../../config/logger.js";
import { getHistory, HISTORY_CATEGORIES } from "./service.js";

const router = Router();

// GET /api/maintenance/history?days=30&category=&search=&assetId=&page=&limit=
router.get("/", async (req, res) => {
  try {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const category = HISTORY_CATEGORIES.includes(req.query.category) ? req.query.category : undefined;
    const assetId = parseInt(req.query.assetId, 10) || undefined;

    const result = await getHistory(req.currentPlantId, { days, category, search: req.query.search, assetId, page, limit });
    return res.json(result);
  } catch (err) {
    logger.error("[history GET]", err);
    return res.status(500).json({ error: "Error fetching history" });
  }
});

export default router;
