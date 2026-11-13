import prisma from "../../../prisma.js";
import { logger } from "../../../config/logger.js";

/**
 * Calcula la próxima fecha de ejecución basada en la frecuencia
 * Ejemplo: Si se ejecutó el 12 de octubre 2026 con frecuencia mensual,
 * retorna el 12 de noviembre de 2026
 */
export function calculateNextDueDate(lastDate, frequencyUnit, frequencyEvery) {
  if (!lastDate || !frequencyUnit || !frequencyEvery) {
    return null;
  }

  const next = new Date(lastDate);

  switch (frequencyUnit) {
    case "DAY":
      next.setDate(next.getDate() + frequencyEvery);
      break;
    case "WEEK":
      next.setDate(next.getDate() + frequencyEvery * 7);
      break;
    case "BIWEEK":
      next.setDate(next.getDate() + 14);
      break;
    case "MONTH":
      // Mantener el mismo día del mes
      const originalDay = new Date(lastDate).getDate();
      next.setMonth(next.getMonth() + frequencyEvery);
      // Si el mes anterior tiene menos días, ajustar
      if (next.getDate() !== originalDay) {
        next.setDate(0); // Último día del mes anterior
      }
      break;
    case "BIMONTH":
      const originalDay2 = new Date(lastDate).getDate();
      next.setMonth(next.getMonth() + 2);
      if (next.getDate() !== originalDay2) {
        next.setDate(0);
      }
      break;
    case "QUARTER":
      const originalDay3 = new Date(lastDate).getDate();
      next.setMonth(next.getMonth() + 3);
      if (next.getDate() !== originalDay3) {
        next.setDate(0);
      }
      break;
    case "SEMESTER":
      const originalDay4 = new Date(lastDate).getDate();
      next.setMonth(next.getMonth() + 6);
      if (next.getDate() !== originalDay4) {
        next.setDate(0);
      }
      break;
    case "YEAR":
      next.setFullYear(next.getFullYear() + frequencyEvery);
      break;
    default:
      return null;
  }

  return next;
}

/**
 * Genera automáticamente el siguiente plan cuando se completa el actual
 */
export async function generateNextPlan(planId, plantId, executionDate) {
  try {
    const plan = await prisma.mtPlan.findUnique({
      where: { id: planId },
      include: {
        tasks: { orderBy: { position: "asc" } },
        technicians: true,
        spareParts: true,
      },
    });

    if (!plan || !plan.active) {
      logger.info(`[planScheduler] Plan ${planId} no está activo o no existe`);
      return null;
    }

    // Calcular próxima fecha
    const nextDueDate = calculateNextDueDate(
      executionDate,
      plan.frequencyUnit,
      plan.frequencyEvery
    );

    if (!nextDueDate) {
      logger.warn(`[planScheduler] No se pudo calcular próxima fecha para plan ${planId}`);
      return null;
    }

    // Aplicar lead days (si es necesario)
    const leadDate = new Date(nextDueDate);
    if (plan.leadDays > 0) {
      leadDate.setDate(leadDate.getDate() - plan.leadDays);
    }

    // Actualizar nextDueAt del plan actual
    await prisma.mtPlan.update({
      where: { id: planId },
      data: {
        lastCompletedAt: new Date(executionDate),
        nextDueAt: leadDate,
      },
    });

    logger.info(`[planScheduler] Plan ${planId} próxima ejecución: ${nextDueDate.toISOString()}`);

    return {
      nextDueDate,
      leadDate,
    };
  } catch (error) {
    logger.error("[planScheduler] Error generando próximo plan:", error);
    throw error;
  }
}

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
  calculateNextDueDate,
  generateNextPlan,
  getOverduePlans,
  getUpcomingPlans,
  validatePlanExecution,
};
