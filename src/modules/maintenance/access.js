import prisma from "../../prisma.js";
import { logger } from "../../config/logger.js";

export async function requireMaintenanceAccess(req, res, next) {
  try {
    if (!req.currentPlantId) {
      return res.status(400).json({ error: "PLANT_REQUIRED" });
    }

    const access = await prisma.mtPlantAccess.findUnique({
      where: { plantId: req.currentPlantId },
      select: { enabled: true, plan: true },
    });

    if (!access?.enabled) {
      return res.status(403).json({ error: "MAINTENANCE_NOT_ENABLED" });
    }

    req.mtPlan = access.plan;
    return next();
  } catch (err) {
    logger.error("[requireMaintenanceAccess]", err);
    return res.status(500).json({ error: "Error validating maintenance access" });
  }
}
