/**
 * Regla única de "fecha compromiso" y atraso de las órdenes de trabajo.
 *
 * - Si la OT tiene dueAt, esa es su fecha compromiso (preventivas generadas por plan, o fijada a mano).
 * - Si no, scheduledAt (fecha programada al asignar).
 * - Correctivas sin ninguna de las dos: plazo de atención (SLA) según prioridad, contado desde su creación.
 * Una OT abierta está atrasada si su fecha compromiso ya pasó.
 */

import { startOfLocalDay } from "../scheduler/dates.js";

export const CORRECTIVE_SLA_DAYS = { CRITICAL: 1, HIGH: 3, MEDIUM: 7, LOW: 14 };
export const CLOSED_STATUSES = ["FINISHED", "VALIDATED", "REJECTED", "CANCELLED"];
const DAY = 24 * 60 * 60 * 1000;

/** Fecha compromiso de una OT para un plazo SLA (correctivas nuevas la guardan en dueAt al crearse). */
export function slaDueAt(priority, from = new Date()) {
  const days = CORRECTIVE_SLA_DAYS[priority] ?? CORRECTIVE_SLA_DAYS.MEDIUM;
  return new Date(new Date(from).getTime() + days * DAY);
}

/** Fecha compromiso efectiva (o null si la OT no tiene ninguna). Requiere dueAt, scheduledAt, createdAt, type y priority. */
export function effectiveDueAt(wo) {
  if (wo.dueAt) return new Date(wo.dueAt);
  if (wo.scheduledAt) return new Date(wo.scheduledAt);
  if (wo.type === "CORRECTIVE" && wo.createdAt) return slaDueAt(wo.priority, wo.createdAt);
  return null;
}

/**
 * ¿Está atrasada? Las fechas a medianoche (preventivas por día) se consideran vencidas al terminar ese día;
 * los plazos SLA (con hora) vencen a la hora exacta.
 */
export function isOverdue(wo, now = new Date()) {
  if (CLOSED_STATUSES.includes(wo.status)) return false;
  const due = effectiveDueAt(wo);
  if (!due) return false;
  const limit = wo.dueAt || wo.scheduledAt ? endOfDay(due) : due;
  return limit < now;
}

/** Días de atraso por día calendario de la planta: vencía el 19 → el 20 lleva 1 día (mínimo 1 si ya está atrasada). */
export function daysOverdue(wo, now = new Date()) {
  const due = effectiveDueAt(wo);
  if (!due) return 0;
  const days = Math.round((startOfLocalDay(now).getTime() - startOfLocalDay(due).getTime()) / DAY);
  return Math.max(1, days);
}

/** Último instante del día de `date` en la zona horaria de la planta. */
function endOfDay(date) {
  return new Date(startOfLocalDay(date).getTime() + DAY - 1);
}

/** Campos mínimos que hay que seleccionar para poder usar estas funciones. */
export const DUE_SELECT = { status: true, type: true, priority: true, dueAt: true, scheduledAt: true, createdAt: true };
