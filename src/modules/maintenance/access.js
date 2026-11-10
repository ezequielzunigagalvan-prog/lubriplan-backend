import prisma from "../../prisma.js";
import { logger } from "../../config/logger.js";

export async function requireMaintenanceAccess(req, res, next) {
  try {
    if (!req.currentPlantId) {
      return res.status(400).json({ error: "PLANT_REQUIRED" });
    }

    // Use raw SQL to bypass Prisma schema issues
    const access = await prisma.$queryRaw`
      SELECT enabled, plan FROM "mtPlantAccess" WHERE plantid = ${req.currentPlantId}
    `;

    const result = access?.[0];
    if (!result?.enabled) {
      return res.status(403).json({ error: "MAINTENANCE_NOT_ENABLED" });
    }

    req.mtPlan = result.plan;
    return next();
  } catch (err) {
    logger.error("[requireMaintenanceAccess]", err);
    return res.status(500).json({ error: "Error validating maintenance access" });
  }
}
