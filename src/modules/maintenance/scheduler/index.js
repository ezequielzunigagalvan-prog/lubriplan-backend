import prisma from "../../../prisma.js";
import { logger } from "../../../config/logger.js";
import { generateForPlant } from "./generator.js";

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
    // No se usa un lock global de sesión (con el pool de Prisma el unlock puede caer en otra
    // conexión y dejar el lock tomado). Cada plan se procesa con pg_advisory_xact_lock dentro
    // de su transacción y la generación es idempotente por cycleKey, así que dos instancias
    // corriendo a la vez no duplican OTs.
    const now = new Date();
    const access = await prisma.mtPlantAccess.findMany({ where: { enabled: true }, select: { plantId: true } });
    const activePlants = await prisma.plant.findMany({
      where: { id: { in: access.map((a) => a.plantId) }, active: true },
      select: { id: true },
    });
    const enabledPlants = activePlants.map((p) => ({ plantId: p.id }));

    const totals = { plants: enabledPlants.length, plans: 0, generated: 0, skipped: 0, errors: 0 };

    for (const { plantId } of enabledPlants) {
      const summary = await generateForPlant(plantId, { now, trigger: "SCHEDULER" });
      totals.plans += summary.total;
      totals.generated += summary.generated;
      totals.skipped += summary.skipped;
      totals.errors += summary.errors;

      for (const r of summary.results) {
        if (r.decision === "GENERATED") {
          logger.info(`[Maintenance Scheduler] Generated WO for plan ${r.planCode}`, {
            workOrderId: r.workOrderId,
            cycleKey: r.cycleKey,
          });
        }
      }
    }

    logger.info("[Maintenance Scheduler] Cycle completed", { timestamp: now.toISOString(), ...totals });
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
