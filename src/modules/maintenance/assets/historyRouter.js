import { Router } from "express";
import { logger } from "../../../config/logger.js";
import { getAssetHistory } from "./historyService.js";

const router = Router();

// GET /api/maintenance/assets/:id/history
router.get("/:id/history", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const assetId = parseInt(req.params.id);
    const { days = 90 } = req.query;

    const history = await getAssetHistory(assetId, plantId, parseInt(days));

    if (!history) {
      return res.status(404).json({ error: "Asset not found" });
    }

    res.json(history);
  } catch (error) {
    logger.error("[GET /assets/:id/history]", error);
    res.status(500).json({ error: "Error fetching asset history" });
  }
});

export default router;
