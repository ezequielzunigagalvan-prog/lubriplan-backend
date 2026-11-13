import prisma from "../../../prisma.js";
import { logger } from "../../../config/logger.js";
import { generateNextPlan } from "./planScheduler.js";
import { getNextWorkOrderNumber, formatWorkOrderNumber } from "../utils/numeracion.js";

/**
 * Ejecuta un plan y genera:
 * 1. Work Order asociada
 * 2. Historial de ejecución
 * 3. Próximo plan automáticamente
 */
export async function executePlan(planId, plantId, userId, executionData = {}) {
  const session = await prisma.$transaction(async (tx) => {
    try {
      // 1. Obtener plan
      const plan = await tx.mtPlan.findUnique({
        where: { id: planId },
        include: {
          tasks: { orderBy: { position: "asc" } },
          technicians: { include: { technician: true } },
          spareParts: { include: { sparePart: true } },
          asset: true,
        },
      });

      if (!plan) {
        throw new Error("Plan no encontrado");
      }

      if (!plan.active) {
        throw new Error("El plan no está activo");
      }

      // 2. Crear Work Order
      const workOrderNumber = await getNextWorkOrderNumber(plantId);
      const workOrder = await tx.mtWorkOrder.create({
        data: {
          plantId,
          number: workOrderNumber,
          type: plan.type,
          status: "REQUESTED",
          priority: plan.priority,
          assetId: plan.assetId,
          title: plan.title,
          description: plan.description,
          requestedBy: userId,
          scheduledAt: new Date(),
          planId: planId,
          cycleKey: `${plan.code}-${new Date().getTime()}`,
        },
      });

      // 3. Crear tareas de la work order (desde el plan)
      if (plan.tasks && plan.tasks.length > 0) {
        await tx.mtWorkOrderTask.createMany({
          data: plan.tasks.map((task) => ({
            workOrderId: workOrder.id,
            plantId,
            position: task.position,
            kind: task.kind,
            description: task.description,
            unit: task.unit,
            minValue: task.minValue,
            maxValue: task.maxValue,
            required: task.required,
            createsCorrectiveOnFail: task.createsCorrectiveOnFail,
          })),
        });
      }

      // 4. Guardar historial de ejecución
      const execution = await tx.mtPlanExecutionHistory.create({
        data: {
          planId,
          workOrderId: workOrder.id,
          executionDate: new Date(),
          executedBy: userId,
          status: "PENDING",
          techniciansAssigned: executionData.technicians
            ? plan.technicians
                .filter((t) => executionData.technicians.includes(t.technicianId))
                .map((t) => ({
                  id: t.technicianId,
                  name: t.technician.name,
                  role: t.role,
                }))
            : null,
          sparesUsed: plan.spareParts
            ? plan.spareParts.map((sp) => ({
                id: sp.sparePartId,
                name: sp.sparePart.name,
                quantityRequired: sp.quantityRequired,
              }))
            : null,
          tasksTotal: plan.tasks.length,
          checklist: plan.tasks.map((task) => ({
            id: task.id,
            description: task.description,
            completed: false,
            result: null,
          })),
          notes: executionData.notes || null,
        },
      });

      // 5. Generar próximo plan automáticamente
      const nextSchedule = await generateNextPlan(planId, plantId, new Date());

      logger.info(`[planExecution] Plan ${planId} ejecutado exitosamente`, {
        workOrderId: workOrder.id,
        executionId: execution.id,
        nextDue: nextSchedule?.nextDueDate,
      });

      return {
        success: true,
        workOrder: {
          id: workOrder.id,
          number: formatWorkOrderNumber(workOrder.number),
        },
        execution: {
          id: execution.id,
          status: execution.status,
          technicians: execution.techniciansAssigned,
          spares: execution.sparesUsed,
        },
        nextSchedule,
      };
    } catch (error) {
      logger.error("[planExecution] Error ejecutando plan:", error);
      throw error;
    }
  });

  return session;
}

/**
 * Completa un plan (marcar como completado)
 */
export async function completePlanExecution(executionId, plantId, completionData = {}) {
  try {
    const execution = await prisma.mtPlanExecutionHistory.update({
      where: { id: executionId },
      data: {
        status: "COMPLETED",
        tasksCompleted: completionData.tasksCompleted || 0,
        duration: completionData.duration || null,
        checklist: completionData.checklist || null,
        notes: completionData.notes || null,
        updatedAt: new Date(),
      },
      include: {
        plan: true,
        workOrder: true,
      },
    });

    logger.info(`[planExecution] Ejecución completada: ${executionId}`);

    return execution;
  } catch (error) {
    logger.error("[planExecution] Error completando ejecución:", error);
    throw error;
  }
}

/**
 * Obtiene el historial completo de un plan
 */
export async function getPlanHistory(planId, plantId, limit = 50) {
  try {
    const executions = await prisma.mtPlanExecutionHistory.findMany({
      where: {
        planId,
      },
      include: {
        workOrder: {
          select: {
            id: true,
            number: true,
            status: true,
            finishedAt: true,
          },
        },
      },
      orderBy: { executionDate: "desc" },
      take: limit,
    });

    // Calcular estadísticas
    const total = executions.length;
    const completed = executions.filter((e) => e.status === "COMPLETED").length;
    const pending = executions.filter((e) => e.status === "PENDING").length;
    const cancelled = executions.filter((e) => e.status === "CANCELLED").length;

    const avgDuration =
      executions
        .filter((e) => e.duration)
        .reduce((sum, e) => sum + e.duration, 0) / executions.filter((e) => e.duration).length || null;

    return {
      executions,
      stats: {
        total,
        completed,
        pending,
        cancelled,
        compliance: total > 0 ? ((completed / total) * 100).toFixed(1) : 0,
        avgDuration,
      },
    };
  } catch (error) {
    logger.error("[planExecution] Error obteniendo historial:", error);
    throw error;
  }
}

/**
 * Obtiene detalles de un plan en formato de "hoja de ruta" (roadmap)
 */
export async function getPlanRoadmap(planId, plantId) {
  try {
    const plan = await prisma.mtPlan.findUnique({
      where: { id: planId },
      include: {
        asset: {
          select: {
            id: true,
            code: true,
            name: true,
            location: true,
            manufacturer: true,
            model: true,
          },
        },
        tasks: { orderBy: { position: "asc" } },
        technicians: {
          include: {
            technician: {
              select: {
                id: true,
                name: true,
                code: true,
                email: true,
              },
            },
          },
        },
        spareParts: {
          include: {
            sparePart: {
              select: {
                id: true,
                code: true,
                name: true,
              },
            },
          },
        },
        executions: {
          orderBy: { executionDate: "desc" },
          take: 5,
        },
      },
    });

    if (!plan) {
      throw new Error("Plan no encontrado");
    }

    return {
      plan: {
        id: plan.id,
        code: plan.code,
        title: plan.title,
        description: plan.description,
        type: plan.type,
        priority: plan.priority,
        frequency: `Cada ${plan.frequencyEvery} ${plan.frequencyUnit}`,
        nextDue: plan.nextDueAt,
        lastCompleted: plan.lastCompletedAt,
        estimatedMinutes: plan.estimatedMinutes,
      },
      asset: plan.asset,
      checklist: plan.tasks.map((task, idx) => ({
        order: idx + 1,
        description: task.description,
        type: task.kind,
        required: task.required,
      })),
      assignedTechnicians: plan.technicians.map((t) => ({
        id: t.technician.id,
        name: t.technician.name,
        code: t.technician.code,
        role: t.role,
      })),
      requiredSpares: plan.spareParts.map((sp) => ({
        id: sp.sparePart.id,
        code: sp.sparePart.code,
        name: sp.sparePart.name,
        quantity: sp.quantityRequired,
      })),
      recentExecutions: plan.executions.map((exec) => ({
        date: exec.executionDate,
        status: exec.status,
        duration: exec.duration,
      })),
    };
  } catch (error) {
    logger.error("[planExecution] Error obteniendo roadmap:", error);
    throw error;
  }
}

export default {
  executePlan,
  completePlanExecution,
  getPlanHistory,
  getPlanRoadmap,
};
