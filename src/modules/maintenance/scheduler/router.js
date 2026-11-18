import { Router } from "express";
import { requireRole } from "../../../middleware/requireRole.js";
import { generateForPlant } from "./generator.js";
import { logger } from "../../../config/logger.js";

const router = Router();

// POST /api/maintenance/scheduler/launch-preventives[?dryRun=1]
// Genera ahora las OTs preventivas vencidas de la planta actual (misma lógica que el scheduler automático).
router.post("/launch-preventives", requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
  try {
    const dryRun = req.query.dryRun === "1" || req.query.dryRun === "true";
    logger.info("[Scheduler] Manual launch", { plantId: req.currentPlantId, userId: req.user?.id, dryRun });
    const summary = await generateForPlant(req.currentPlantId, { dryRun, trigger: "MANUAL" });
    return res.json(summary);
  } catch (error) {
    logger.error("[Scheduler] Error:", error);
    return res.status(500).json({ error: "Error launching preventives" });
  }
});

export default router;
