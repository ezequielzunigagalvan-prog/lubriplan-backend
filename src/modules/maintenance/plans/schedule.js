import prisma from "../../../prisma.js";
import { addInterval, startOfLocalDay } from "../scheduler/dates.js";

/** ¿El plan tiene lo necesario para programarse por tiempo? */
export function isTimeSchedulable(plan) {
  return plan.triggerType === "TIME" && Boolean(plan.anchorDate && plan.frequencyUnit && plan.frequencyEvery);
}

/** Ciclo n de un plan FIXED, siempre contado desde la fecha de inicio (evita el desfase de fin de mes). */
function fixedCycle(plan, n) {
  return n === 0 ? new Date(plan.anchorDate) : addInterval(new Date(plan.anchorDate), plan.frequencyUnit, plan.frequencyEvery * n);
}

// Duración máxima de cada unidad en días: sirve para estimar desde qué ciclo empezar a buscar
// sin pasarse (el ciclo estimado siempre queda en o antes de la fecha buscada).
const MAX_UNIT_DAYS = { DAY: 1, WEEK: 7, MONTH: 31, YEAR: 366 };

function firstCandidate(plan, target) {
  const diffDays = (new Date(target) - new Date(plan.anchorDate)) / 86400000;
  const period = (MAX_UNIT_DAYS[plan.frequencyUnit] || 1) * plan.frequencyEvery;
  return Math.max(0, Math.floor(diffDays / period) - 1);
}

/**
 * Fecha del ciclo siguiente a `dueAt`.
 * FIXED: el primer ciclo del calendario del plan posterior a `dueAt` (un plan del día 31 vuelve
 * al 31 después de febrero). FLOATING: `dueAt` + frecuencia.
 */
export function nextCycleAfter(plan, dueAt) {
  const after = new Date(dueAt);
  if (plan.scheduleMode === "FLOATING" || !plan.anchorDate) {
    return addInterval(after, plan.frequencyUnit, plan.frequencyEvery);
  }
  const start = Math.max(1, firstCandidate(plan, after));
  for (let n = start; n < start + 400; n++) {
    const cycle = fixedCycle(plan, n);
    if (cycle > after) return cycle;
  }
  return addInterval(after, plan.frequencyUnit, plan.frequencyEvery);
}

/**
 * Próxima fecha de vencimiento de un plan, calculada desde cero.
 * - FIXED: primer ciclo (anchorDate + n·frecuencia) que cae hoy o después.
 * - FLOATING: última realización + frecuencia; si nunca se ha realizado, la fecha de inicio.
 * Devuelve null si el plan no se programa por tiempo.
 */
export function computeNextDueAt(plan, now = new Date()) {
  if (!isTimeSchedulable(plan)) return null;

  if (plan.scheduleMode === "FLOATING") {
    return plan.lastCompletedAt ? nextCycleAfter(plan, startOfLocalDay(plan.lastCompletedAt)) : new Date(plan.anchorDate);
  }

  const today = startOfLocalDay(now);
  const start = firstCandidate(plan, today);
  for (let n = start; n < start + 400; n++) {
    const due = fixedCycle(plan, n);
    if (due >= today) return due;
  }
  return null;
}

/**
 * Se llama cuando una OT generada por un plan se termina:
 * registra la realización y, en planes FLOATING, reprograma desde la fecha real de término.
 */
export async function onPlanWorkOrderFinished(planId, finishedAt = new Date(), client = prisma) {
  const plan = await client.mtPlan.findUnique({ where: { id: planId } });
  if (!plan) return null;

  const data = { lastCompletedAt: finishedAt };
  if (plan.scheduleMode === "FLOATING" && isTimeSchedulable(plan)) {
    data.nextDueAt = nextCycleAfter(plan, startOfLocalDay(finishedAt));
  }
  return client.mtPlan.update({ where: { id: planId }, data });
}
