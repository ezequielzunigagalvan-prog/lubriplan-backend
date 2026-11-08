import prisma from "../../../prisma.js";
import { logger } from "../../../config/logger.js";

export async function autoLaunchPreventives() {
  try {
    logger.info("[AutoLaunch] Iniciando creación automática de órdenes preventivas");

    // Find all active plans with nextDueAt <= today
    const duePlans = await prisma.mtPlan.findMany({
      where: {
        active: true,
        nextDueAt: { lte: new Date() },
      },
      include: {
        asset: true,
        plant: true,
      },
    });

    if (duePlans.length === 0) {
      logger.info("[AutoLaunch] No hay preventivos vencidos para lanzar");
      return { launched: 0, results: [] };
    }

    const results = [];

    for (const plan of duePlans) {
      try {
        // Check if there's already an open WO for this plan in the last 7 days
        const existingWO = await prisma.mtWorkOrder.findFirst({
          where: {
            plantId: plan.plantId,
            planId: plan.id,
            status: { notIn: ["FINISHED", "VALIDATED", "REJECTED", "CANCELLED"] },
            createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
          },
        });

        if (existingWO) {
          logger.info(`[AutoLaunch] Plan ${plan.code} ya tiene OT abierta (#${existingWO.number})`);
          results.push({
            planId: plan.id,
            planCode: plan.code,
            status: "SKIPPED",
            reason: "OPEN_WO_EXISTS",
            woNumber: existingWO.number,
          });
          continue;
        }

        // Get next work order number
        const lastWO = await prisma.mtWorkOrder.findFirst({
          where: { plantId: plan.plantId },
          orderBy: { number: "desc" },
        });
        const nextNumber = (lastWO?.number || 0) + 1;

        // Create work order from plan
        const wo = await prisma.mtWorkOrder.create({
          data: {
            plantId: plan.plantId,
            number: nextNumber,
            type: "PREVENTIVE",
            status: "REQUESTED",
            priority: "MEDIUM",
            assetId: plan.assetId,
            title: `${plan.title} - Auto-lanzado`,
            description: `Orden generada automáticamente desde plan ${plan.code}\n\nTareas:\n${plan.tasks.map((t, i) => `${i + 1}. ${t.description}`).join("\n")}`,
            requestedBy: 1, // System user ID
            planId: plan.id,
            dueAt: new Date(plan.nextDueAt.getTime() + 24 * 60 * 60 * 1000), // +1 day buffer
          },
        });

        logger.info(`[AutoLaunch] ✅ Orden creada: #${wo.number} para plan ${plan.code}`);
        results.push({
          planId: plan.id,
          planCode: plan.code,
          status: "CREATED",
          woNumber: wo.number,
        });
      } catch (error) {
        logger.error(`[AutoLaunch] Error creando WO para plan ${plan.code}:`, error);
        results.push({
          planId: plan.id,
          planCode: plan.code,
          status: "ERROR",
          error: error.message,
        });
      }
    }

    const successCount = results.filter((r) => r.status === "CREATED").length;
    logger.info(`[AutoLaunch] Completado: ${successCount} órdenes creadas, ${results.length - successCount} omitidas/errores`);

    return { launched: successCount, results };
  } catch (error) {
    logger.error("[AutoLaunch] Error general:", error);
    return { launched: 0, error: error.message, results: [] };
  }
}

// Schedule to run daily at 2 AM
export function scheduleAutoLaunch() {
  const schedule = require("node-schedule");

  // Every day at 2 AM
  schedule.scheduleJob("0 2 * * *", async () => {
    logger.info("[AutoLaunch] Ejecutando scheduler automático");
    await autoLaunchPreventives();
  });

  logger.info("[AutoLaunch] Scheduler configurado: Diario a las 2:00 AM");
}
