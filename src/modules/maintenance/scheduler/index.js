import prisma from "../../../prisma.js";
import { logger } from "../../../config/logger.js";
import { generateForPlan } from "./generator.js";

let schedulerInterval = null;
let isRunning = false;

export async function startMaintenanceScheduler() {
  const enabled = process.env.MAINTENANCE_SCHEDULER_ENABLED === "true";

  if (!enabled) {
    logger.info("[Maintenance Scheduler] Disabled (MAINTENANCE_SCHEDULER_ENABLED !== true)");
    return;
  }

  const delayMs = 30 * 1000;
  const intervalMs = (parseInt(process.env.MAINTENANCE_SCHEDULER_INTERVAL_MIN || "15") || 15) * 60 * 1000;

  logger.info("[Maintenance Scheduler] Starting scheduler", {
    initialDelay: delayMs,
    interval: intervalMs,
  });

  setTimeout(() => {
    runMaintenanceScheduler();
    schedulerInterval = setInterval(runMaintenanceScheduler, intervalMs);
  }, delayMs);
}

export async function runMaintenanceScheduler() {
  if (isRunning) {
    logger.debug("[Maintenance Scheduler] Already running, skipping this cycle");
    return;
  }

  isRunning = true;

  try {
    const lockKey = 9999;
    let hasLock = false;

    try {
      const result = await prisma.$queryRaw`
        SELECT pg_try_advisory_lock(${lockKey}) as locked
      `;
      hasLock = result[0]?.locked || false;
    } catch {
      logger.warn("[Maintenance Scheduler] Could not acquire advisory lock, proceeding anyway");
      hasLock = true;
    }

    if (!hasLock) {
      logger.debug("[Maintenance Scheduler] Lock held by another instance, skipping");
      return;
    }

    const now = new Date();

    const plants = await prisma.plant.findMany({
      where: { active: true },
      select: { id: true, name: true },
    });

    const results = [];

    for (const plant of plants) {
      const access = await prisma.mtPlantAccess.findUnique({
        where: { plantId: plant.id },
        select: { enabled: true },
      });

      if (!access?.enabled) {
        continue;
      }

      const plans = await prisma.mtPlan.findMany({
        where: {
          plantId: plant.id,
          active: true,
          deletedAt: null,
          triggerType: "TIME",
        },
        include: { tasks: true },
      });

      for (const plan of plans) {
        try {
          const result = await generateForPlan(plan, {
            now,
            dryRun: false,
            trigger: "SCHEDULER",
          });
          results.push(result);

          if (result.decision === "GENERATED") {
            logger.info(`[Maintenance Scheduler] Generated WO for plan ${plan.code}`, {
              workOrderId: result.workOrderId,
              cycleKey: result.cycleKey,
            });
          }
        } catch (err) {
          logger.error(`[Maintenance Scheduler] Error processing plan ${plan.id}`, err);
        }
      }
    }

    const summary = {
      timestamp: now.toISOString(),
      totalResults: results.length,
      generated: results.filter((r) => r.decision === "GENERATED").length,
      skipped: results.filter((r) => r.decision.startsWith("SKIPPED")).length,
      errors: results.filter((r) => r.decision === "ERROR").length,
    };

    logger.info("[Maintenance Scheduler] Cycle completed", summary);

    try {
      await prisma.$queryRaw`
        SELECT pg_advisory_unlock(${lockKey})
      `;
    } catch {}
  } catch (err) {
    logger.error("[Maintenance Scheduler] Unexpected error", err);
  } finally {
    isRunning = false;
  }
}

export function stopMaintenanceScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    logger.info("[Maintenance Scheduler] Stopped");
  }
}
