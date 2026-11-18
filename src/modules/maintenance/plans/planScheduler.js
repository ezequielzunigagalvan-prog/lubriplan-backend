import prisma from "../../../prisma.js";
import { logger } from "../../../config/logger.js";

/**
 * Obtiene todos los planes vencidos que deben ejecutarse
 */
export async function getOverduePlans(plantId) {
  try {
    const now = new Date();

    const plans = await prisma.mtPlan.findMany({
      where: {
        plantId,
        active: true,
        deletedAt: null,
        nextDueAt: {
          lte: now,
        },
      },
      include: {
        asset: { select: { code: true, name: true } },
        tasks: true,
        technicians: { include: { technician: true } },
        spareParts: { include: { sparePart: true } },
      },
      orderBy: { nextDueAt: "asc" },
    });

    return plans;
  } catch (error) {
    logger.error("[planScheduler] Error obteniendo planes vencidos:", error);
    throw error;
  }
}

/**
 * Obtiene planes próximos a vencerse (en los próximos días)
 */
export async function getUpcomingPlans(plantId, daysAhead = 7) {
  try {
    const now = new Date();
    const future = new Date(now);
    future.setDate(future.getDate() + daysAhead);

    const plans = await prisma.mtPlan.findMany({
      where: {
        plantId,
        active: true,
        deletedAt: null,
        nextDueAt: {
          gte: now,
          lte: future,
        },
      },
      include: {
        asset: { select: { code: true, name: true } },
        technicians: { include: { technician: { select: { id: true, name: true, code: true } } } },
      },
      orderBy: { nextDueAt: "asc" },
    });

    return plans;
  } catch (error) {
    logger.error("[planScheduler] Error obteniendo planes próximos:", error);
    throw error;
  }
}

/**
 * Valida si un plan puede ejecutarse
 */
export function validatePlanExecution(plan) {
  const errors = [];

  if (!plan.active) {
    errors.push("El plan no está activo");
  }

  if (!plan.frequencyUnit || !plan.frequencyEvery) {
    errors.push("La frecuencia no está configurada");
  }

  if (!plan.anchorDate) {
    errors.push("No hay fecha de anclaje configurada");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export default {
  getOverduePlans,
  getUpcomingPlans,
  validatePlanExecution,
};
