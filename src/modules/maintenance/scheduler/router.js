import { Router } from "express";
import { requireRole } from "../../../middleware/requireRole.js";
import { autoLaunchPreventives } from "./autoLaunchScheduler.js";
import { logger } from "../../../config/logger.js";

const router = Router();

// POST /api/maintenance/scheduler/launch-preventives - Manual trigger
router.post("/launch-preventives", requireRole(["ADMIN"]), async (req, res) => {
  try {
    logger.info("[Scheduler] Auto-launch manual trigger by admin");
    const result = await autoLaunchPreventives();
    res.json(result);
  } catch (error) {
    logger.error("[Scheduler] Error:", error);
    res.status(500).json({ error: "Error launching preventives" });
  }
});

export default router;
