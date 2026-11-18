import prisma from "../../../prisma.js";
import { logger } from "../../../config/logger.js";
import { getNextWorkOrderNumber, formatWorkOrderNumber } from "../utils/numeracion.js";

/**
 * Genera manualmente ("Generar OT ahora") una orden de trabajo a partir de un plan.
 * No altera la programación del plan: la próxima fecha se mantiene y, al terminar la OT,
 * se registra la realización igual que con las OTs generadas por el scheduler.
 */
export async function executePlan(planId, plantId, userId, executionData = {}) {
  return prisma.$transaction(async (tx) => {
    const plan = await tx.mtPlan.findFirst({
      where: { id: planId, plantId, deletedAt: null },
      include: {
        tasks: { orderBy: { position: "asc" } },
        technicians: { include: { technician: true } },
        spareParts: { include: { sparePart: true } },
      },
    });

    if (!plan) throw Object.assign(new Error("Plan no encontrado"), { status: 404 });
    if (!plan.active) throw Object.assign(new Error("El plan está pausado"), { status: 409 });

    const now = new Date();
    const number = await getNextWorkOrderNumber(plantId, tx);
    const status = plan.defaultAssigneeId ? "ASSIGNED" : "APPROVED";

    const workOrder = await tx.mtWorkOrder.create({
      data: {
        plantId,
        number,
        type: plan.type,
        status,
        priority: plan.priority,
        assetId: plan.assetId,
        title: `[${plan.code}] ${plan.title}`,
        description: plan.description,
        requestedBy: userId,
        assignedTo: plan.defaultAssigneeId || null,
        scheduledAt: now,
        dueAt: now,
        planId,
        cycleKey: `MANUAL:${now.toISOString()}`,
      },
    });

    await tx.mtWorkOrderEvent.create({
      data: {
        workOrderId: workOrder.id,
        plantId,
        toStatus: status,
        userId,
        comment: `Generada manualmente desde el plan ${plan.code}`,
        metadata: { source: "MANUAL", planCode: plan.code },
      },
    });

    if (plan.tasks.length > 0) {
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

    const execution = await tx.mtPlanExecutionHistory.create({
      data: {
        planId,
        workOrderId: workOrder.id,
        executionDate: now,
        executedBy: userId,
        status: "PENDING",
        techniciansAssigned: plan.technicians.map((t) => ({ id: t.technicianId, name: t.technician?.name, role: t.role })),
        sparesUsed: plan.spareParts.map((sp) => ({
          id: sp.sparePartId,
          name: sp.sparePart?.name,
          quantityRequired: Number(sp.quantityRequired),
        })),
        tasksTotal: plan.tasks.length,
        checklist: plan.tasks.map((task) => ({ id: task.id, description: task.description, completed: false, result: null })),
        notes: executionData.notes || null,
      },
    });

    await tx.mtPlan.update({ where: { id: planId }, data: { lastGeneratedAt: now } });

    logger.info(`[planExecution] OT manual generada para plan ${plan.code}`, { workOrderId: workOrder.id });

    return {
      success: true,
      workOrder: { id: workOrder.id, number: workOrder.number, formatted: formatWorkOrderNumber(workOrder.number) },
      execution: { id: execution.id, status: execution.status },
    };
  });
}

/**
 * Completa un registro de ejecución (solo si pertenece a un plan de la planta).
 */
export async function completePlanExecution(executionId, plantId, completionData = {}) {
  const existing = await prisma.mtPlanExecutionHistory.findFirst({
    where: { id: executionId, plan: { plantId } },
    select: { id: true },
  });
  if (!existing) return null;

  const execution = await prisma.mtPlanExecutionHistory.update({
    where: { id: executionId },
    data: {
      status: "COMPLETED",
      tasksCompleted: completionData.tasksCompleted || 0,
      duration: completionData.duration || null,
      checklist: completionData.checklist || undefined,
      notes: completionData.notes || null,
    },
    include: { plan: { select: { id: true, code: true, title: true } } },
  });

  logger.info(`[planExecution] Ejecución completada: ${executionId}`);
  return execution;
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
