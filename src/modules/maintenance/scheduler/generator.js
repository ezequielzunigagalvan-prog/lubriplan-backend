import prisma from "../../../prisma.js";
import { logger } from "../../../config/logger.js";
import { getNextWorkOrderNumber, formatWorkOrderNumber } from "../utils/numeracion.js";
import { buildCycleKey } from "./dates.js";
import { computeNextDueAt, nextCycleAfter, isTimeSchedulable } from "../plans/schedule.js";

const OPEN_EXCLUDED = ["FINISHED", "VALIDATED", "REJECTED", "CANCELLED"];
const DAY_MS = 24 * 60 * 60 * 1000;

/** Momento en que un ciclo "se lanza": su vencimiento menos los días de anticipación. */
const launchAt = (dueAt, leadDays) => new Date(dueAt.getTime() - (leadDays || 0) * DAY_MS);

/**
 * Genera (si corresponde) la OT del ciclo vencido de un plan por tiempo.
 *
 * Reglas:
 * - El ciclo a generar es plan.nextDueAt (si falta, se calcula). Se lanza leadDays antes.
 * - FIXED: si se acumularon varios ciclos vencidos, se genera solo el más reciente y los
 *   anteriores se cuentan como perdidos (missedCycles).
 * - Idempotente: si ya existe una OT del plan con el mismo cycleKey, no se duplica.
 * - skipIfOpen: si el plan tiene una OT abierta, no se genera otra. En FIXED el ciclo se da
 *   por perdido y se avanza; en FLOATING se espera a que se termine la abierta.
 */
export async function generateForPlan(plan, { now = new Date(), dryRun = false, trigger = "SCHEDULER" } = {}) {
  const result = {
    planId: plan.id,
    plantId: plan.plantId,
    planCode: plan.code,
    trigger,
    dryRun,
    decision: null,
    cycleKey: null,
    dueAt: null,
    workOrderId: null,
    workOrderNumber: null,
    missedCycles: 0,
    detail: {},
  };

  try {
    return await prisma.$transaction(
      async (tx) => {
        // Evita que dos procesos generen el mismo plan a la vez
        if (!dryRun) await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock($1)`, plan.id);

        const current = await tx.mtPlan.findUnique({ where: { id: plan.id }, include: { tasks: true } });

        if (!current || current.deletedAt) {
          result.decision = "ERROR";
          result.detail = { error: "Plan not found" };
          return result;
        }
        if (!current.active) {
          result.decision = "SKIPPED_INACTIVE";
          return result;
        }
        if (!isTimeSchedulable(current)) {
          result.decision = "SKIPPED_NOT_SCHEDULABLE";
          return result;
        }

        let dueAt = current.nextDueAt ? new Date(current.nextDueAt) : computeNextDueAt(current, now);
        if (!dueAt) {
          result.decision = "SKIPPED_NOT_SCHEDULABLE";
          return result;
        }

        // Ciclos vencidos acumulados (solo FIXED): se queda el más reciente
        let missed = 0;
        if (current.scheduleMode !== "FLOATING") {
          for (let next = nextCycleAfter(current, dueAt); launchAt(next, current.leadDays) <= now && missed < 5000; next = nextCycleAfter(current, next)) {
            dueAt = next;
            missed++;
          }
        }
        result.dueAt = dueAt;
        result.missedCycles = missed;

        if (launchAt(dueAt, current.leadDays) > now) {
          result.decision = "SKIPPED_NOT_DUE";
          if (!dryRun && !current.nextDueAt) {
            await tx.mtPlan.update({ where: { id: current.id }, data: { nextDueAt: dueAt } });
          }
          return result;
        }

        const cycleKey = buildCycleKey(current, dueAt, "TIME");
        result.cycleKey = cycleKey;
        const advance = current.scheduleMode === "FLOATING" ? null : nextCycleAfter(current, dueAt);

        const recordRun = async (decision, extra = {}) => {
          if (dryRun) return;
          await tx.mtPlanRun.create({
            data: {
              plantId: current.plantId,
              planId: current.id,
              runAt: now,
              trigger,
              dryRun: false,
              decision,
              cycleKey,
              dueAt,
              missedCycles: missed,
              ...extra,
            },
          });
        };

        // Idempotencia: ¿ya existe la OT de este ciclo?
        const existing = await tx.mtWorkOrder.findFirst({
          where: { plantId: current.plantId, planId: current.id, cycleKey },
          select: { id: true, number: true },
        });
        if (existing) {
          result.decision = "SKIPPED_DUPLICATE";
          result.workOrderId = existing.id;
          if (!dryRun && advance) {
            await tx.mtPlan.update({ where: { id: current.id }, data: { nextDueAt: advance } });
          }
          return result;
        }

        if (current.skipIfOpen) {
          const openWO = await tx.mtWorkOrder.findFirst({
            where: { plantId: current.plantId, planId: current.id, status: { notIn: OPEN_EXCLUDED } },
            select: { id: true, number: true, cycleKey: true },
          });
          if (openWO) {
            result.decision = "SKIPPED_OPEN";
            result.detail = { openWorkOrderId: openWO.id, openWorkOrderNumber: openWO.number, openCycleKey: openWO.cycleKey };
            // FIXED: el ciclo se pierde y se avanza (se registra una sola vez por ciclo).
            // FLOATING: se espera a que termine la OT abierta; no se registra en cada corrida.
            if (!dryRun && advance) {
              await tx.mtPlan.update({ where: { id: current.id }, data: { nextDueAt: advance, lastGeneratedAt: now } });
              await recordRun("SKIPPED_OPEN", { detail: result.detail });
            }
            return result;
          }
        }

        if (dryRun) {
          result.decision = "WOULD_GENERATE";
          return result;
        }

        const number = await getNextWorkOrderNumber(current.plantId, tx);
        const status = current.defaultAssigneeId ? "ASSIGNED" : "APPROVED";

        const workOrder = await tx.mtWorkOrder.create({
          data: {
            plantId: current.plantId,
            number,
            type: current.type,
            status,
            priority: current.priority,
            assetId: current.assetId,
            title: `[${current.code}] ${current.title}`,
            description: current.description,
            requestedBy: current.createdBy,
            assignedTo: current.defaultAssigneeId || null,
            scheduledAt: dueAt,
            dueAt,
            planId: current.id,
            cycleKey,
          },
        });

        await tx.mtWorkOrderEvent.create({
          data: {
            workOrderId: workOrder.id,
            plantId: current.plantId,
            toStatus: status,
            userId: current.createdBy,
            comment: `Generada automáticamente (${trigger}) desde el plan ${current.code}`,
            metadata: { source: trigger, planCode: current.code, cycleKey, missedCycles: missed },
          },
        });

        if (current.tasks.length > 0) {
          await tx.mtWorkOrderTask.createMany({
            data: current.tasks.map((task) => ({
              workOrderId: workOrder.id,
              plantId: current.plantId,
              position: task.position,
              description: task.description,
              kind: task.kind,
              unit: task.unit,
              minValue: task.minValue,
              maxValue: task.maxValue,
              required: task.required,
              createsCorrectiveOnFail: task.createsCorrectiveOnFail,
            })),
          });
        }

        // FLOATING: la siguiente fecha se fija al terminar la OT; mientras tanto se deja tentativa
        await tx.mtPlan.update({
          where: { id: current.id },
          data: { nextDueAt: advance || nextCycleAfter(current, dueAt), lastGeneratedAt: now },
        });

        await recordRun("GENERATED", {
          workOrderId: workOrder.id,
          detail: { workOrderNumber: formatWorkOrderNumber(number), assignedTo: current.defaultAssigneeId },
        });

        result.decision = "GENERATED";
        result.workOrderId = workOrder.id;
        result.workOrderNumber = number;
        return result;
      },
      { timeout: 20000 }
    );
  } catch (err) {
    logger.error(`[generateForPlan] Error for plan ${plan.id}`, err);
    result.decision = "ERROR";
    result.detail = { error: err.message };

    if (!dryRun) {
      try {
        await prisma.mtPlanRun.create({
          data: { plantId: plan.plantId, planId: plan.id, runAt: now, trigger, dryRun, decision: "ERROR", detail: result.detail },
        });
      } catch {
        // si ni siquiera se puede registrar el error, ya quedó en el log
      }
    }
    return result;
  }
}

/** Corre la generación para todos los planes por tiempo activos de una planta. */
export async function generateForPlant(plantId, { now = new Date(), dryRun = false, trigger = "SCHEDULER" } = {}) {
  const plans = await prisma.mtPlan.findMany({
    where: { plantId, active: true, deletedAt: null, triggerType: "TIME" },
    select: { id: true, plantId: true, code: true },
    orderBy: { id: "asc" },
  });

  const results = [];
  for (const plan of plans) {
    results.push(await generateForPlan(plan, { now, dryRun, trigger }));
  }

  return {
    plantId,
    timestamp: now.toISOString(),
    total: results.length,
    generated: results.filter((r) => r.decision === "GENERATED").length,
    skipped: results.filter((r) => r.decision?.startsWith("SKIPPED")).length,
    errors: results.filter((r) => r.decision === "ERROR").length,
    results,
  };
}

export async function generateForAssetMeterReading(asset, { now } = {}) {
  // Planes por contador (METER): pendientes de implementar con su propia lógica de umbrales.
  // Se deja como no-op explícito para no generar OTs con la lógica de calendario.
  logger.debug?.("[generateForAssetMeterReading] METER plans not implemented", { assetId: asset?.id, now });
  return [];
}
