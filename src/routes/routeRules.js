// src/routes/routeRules.js
// Validación y normalización de los datos de una ruta (alta y edición). Funciones puras.

import { ruleOf, toYmd, nextOccurrence, matchesRule, MONTH_TYPES, approxDays } from "../utils/routeSchedule.js";

const UNITS = { ML: "ml", L: "l", G: "g", KG: "kg", BOMBAZOS: "BOMBAZOS" };
const STROKE_UNITS = ["g", "kg", "ml", "l"];
const TYPES = new Set(["DAILY", "WEEKLY", ...Object.keys(MONTH_TYPES)]);
export const MAX_ROUTE_EQUIPMENTS = 60;

const num = (v) => (v === "" || v == null ? null : Number(v));
const str = (v) => (v == null ? "" : String(v).trim());

export class RouteInputError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

/**
 * body: campos del formulario de ruta. existing: ruta actual (edición) para valores por defecto.
 * Devuelve { fields, equipmentIds, schedule: { rule, lastYmd, nextYmd } }.
 */
export function parseRouteInput(body = {}, { today, existing = null, isInspection = false } = {}) {
  const errors = [];
  const name = str(body.name);
  if (!name) errors.push("Escribe el nombre de la ruta");

  // Equipos: equipmentIds (varios) o equipmentId (uno). Sin repetidos.
  const rawIds = Array.isArray(body.equipmentIds) && body.equipmentIds.length ? body.equipmentIds : [body.equipmentId];
  const equipmentIds = [...new Set(rawIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!equipmentIds.length) errors.push("Elige al menos un equipo");
  if (equipmentIds.length > MAX_ROUTE_EQUIPMENTS) errors.push(`Máximo ${MAX_ROUTE_EQUIPMENTS} equipos por ruta`);

  // Consumo
  const quantity = num(body.quantity);
  const unitRaw = str(body.unit || "ml").toUpperCase();
  const unit = UNITS[unitRaw];
  if (!isInspection) {
    if (quantity == null || !Number.isFinite(quantity) || quantity <= 0) errors.push("La cantidad por punto debe ser mayor a cero");
    if (!str(body.lubricantType)) errors.push("Indica el tipo de lubricante");
  } else if (quantity != null && (!Number.isFinite(quantity) || quantity < 0)) {
    errors.push("La cantidad no es válida");
  }
  if (!unit) errors.push("Unidad no válida (ml, L, g, kg o bombazos)");
  const strokeValue = num(body.pumpStrokeValue);
  const strokeUnit = str(body.pumpStrokeUnit).toLowerCase() || null;
  if (unit === "BOMBAZOS" && quantity != null) {
    if (!(strokeValue > 0)) errors.push("Indica cuánto equivale un bombazo");
    if (!STROKE_UNITS.includes(strokeUnit)) errors.push("Indica la unidad del bombazo (g, kg, ml o L)");
  }
  const points = num(body.points);
  if (points != null && (!Number.isInteger(points) || points < 1)) errors.push("Los puntos deben ser un número entero de 1 o más");

  const lubricantId = num(body.lubricantId);
  if (lubricantId != null && !(Number.isInteger(lubricantId) && lubricantId > 0)) errors.push("Lubricante no válido");
  const technicianId = num(body.technicianId);
  if (technicianId != null && !(Number.isInteger(technicianId) && technicianId > 0)) errors.push("Técnico no válido");

  // Frecuencia
  const type = str(body.frequencyType).toUpperCase() || null;
  if (type && !TYPES.has(type)) errors.push("Frecuencia no válida");
  const weeklyDays = Array.isArray(body.weeklyDays) ? [...new Set(body.weeklyDays.map(Number))].filter((n) => n >= 1 && n <= 7).sort((a, b) => a - b) : [];
  if (type === "WEEKLY" && !weeklyDays.length) errors.push("Elige los días de la semana");
  const freqDays = num(body.frequencyDays);
  if (!type && !(Number.isInteger(freqDays) && freqDays >= 1)) errors.push("La frecuencia en días debe ser un número entero de 1 o más");
  let anchor = num(body.monthlyAnchorDay);
  if (anchor != null && !(Number.isInteger(anchor) && anchor >= 1 && anchor <= 31)) errors.push("El día del mes debe estar entre 1 y 31");

  // Fechas
  const lastYmd = body.lastDate ? toYmd(body.lastDate) : null;
  if (body.lastDate && !lastYmd) errors.push("La última fecha no es válida");
  if (lastYmd && today && lastYmd > today) errors.push("La última fecha no puede ser futura");
  let nextYmd = body.nextDate ? toYmd(body.nextDate) : null;
  if (body.nextDate && !nextYmd) errors.push("La próxima fecha no es válida");

  if (errors.length) throw new RouteInputError(errors.join(". "));

  // Mensuales: el día ancla sale de la próxima fecha (o de la última) si no se indicó.
  if (MONTH_TYPES[type] && !anchor) anchor = Number((nextYmd || lastYmd || today || "").slice(8, 10)) || null;

  const rule = ruleOf({ frequencyType: type, frequencyDays: freqDays, weeklyDays, monthlyAnchorDay: anchor });
  if (!nextYmd && lastYmd) nextYmd = nextOccurrence(rule, lastYmd);
  if (!nextYmd && existing?.nextDate) nextYmd = toYmd(existing.nextDate);
  if (!nextYmd) throw new RouteInputError("Indica la última fecha de lubricación o la próxima fecha");
  if (rule.kind === "WEEKLY" && !matchesRule(rule, nextYmd)) {
    throw new RouteInputError("La próxima fecha debe caer en uno de los días de la semana elegidos");
  }
  if (lastYmd && nextYmd <= lastYmd) throw new RouteInputError("La próxima fecha debe ser posterior a la última");

  const isStrokes = unit === "BOMBAZOS" && quantity != null;
  return {
    equipmentIds,
    schedule: { rule, lastYmd, nextYmd },
    fields: {
      name,
      lubricantType: str(body.lubricantType) || null,
      lubricantId,
      lubricantName: lubricantId ? null : str(body.lubricantName) || null,
      quantity,
      unit: quantity == null && isInspection ? null : unit,
      pumpStrokeValue: isStrokes ? strokeValue : null,
      pumpStrokeUnit: isStrokes ? strokeUnit : null,
      points,
      method: str(body.method) || null,
      instructions: str(body.instructions) || null,
      technicianId,
      frequencyType: type,
      frequencyDays: type ? approxDays(rule) : freqDays,
      weeklyDays,
      monthlyAnchorDay: rule.kind === "MONTHS" ? rule.anchor : anchor,
      evidenceRequired: body.evidenceRequired === undefined ? Boolean(existing?.evidenceRequired) : body.evidenceRequired === true || body.evidenceRequired === "true",
    },
  };
}
