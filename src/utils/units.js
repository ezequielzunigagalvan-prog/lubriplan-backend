// src/utils/units.js
// Conversión de unidades de lubricante. Misma lógica que usa la ejecución normal en index.js.

export function round2(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

export function normalizeUnit(u) {
  const s = String(u || "").trim();
  if (!s) return "";
  if (s.toUpperCase() === "BOMBAZOS") return "BOMBAZOS";
  if (s === "L") return "L";
  return s.toLowerCase();
}

/** Convierte entre ml/L o g/kg. Devuelve null si no se puede (p. ej. peso <-> volumen). */
export function convertUnits(value, from, to) {
  if (value == null) return null;
  const v = Number(value);
  if (!Number.isFinite(v) || v < 0) return null;

  const f = String(from || "").toLowerCase().trim();
  const t = String(to || "").toLowerCase().trim();

  if (f === t) return v;

  const vol = { ml: 1, l: 1000 };
  if (vol[f] && vol[t]) return (v * vol[f]) / vol[t];

  const mass = { g: 1, kg: 1000 };
  if (mass[f] && mass[t]) return (v * mass[f]) / mass[t];

  return null;
}

/**
 * Consumo programado de una ruta (cantidad por punto × puntos, con conversión de bombazos),
 * expresado en la unidad del lubricante de inventario.
 * Devuelve { ok: true, ... } o { ok: false, reason }.
 */
export function computeRouteConsumption(route, lubricantUnit) {
  const qtyPerPoint = Number(route?.quantity);
  if (!(qtyPerPoint > 0)) return { ok: false, reason: "La ruta no tiene cantidad configurada" };

  const routeUnit = normalizeUnit(route?.unit || "");
  if (!routeUnit) return { ok: false, reason: "La ruta no tiene unidad configurada" };

  const points = Math.max(1, Number(route?.points || 1));
  const isAdvancedPoints = String(route?.instructions || "").includes("PUNTOS (AVANZADO)");
  const multiplier = isAdvancedPoints ? 1 : points;

  let convertedQuantity;
  let convertedUnit;

  if (routeUnit === "BOMBAZOS") {
    const pumpStrokeValue = Number(route?.pumpStrokeValue || 0);
    const pumpStrokeUnit = normalizeUnit(route?.pumpStrokeUnit || "");
    if (!(pumpStrokeValue > 0) || !pumpStrokeUnit || pumpStrokeUnit === "BOMBAZOS") {
      return { ok: false, reason: "La ruta por bombazos no tiene conversión de embolada configurada" };
    }
    convertedQuantity = round2(qtyPerPoint * multiplier * pumpStrokeValue);
    convertedUnit = pumpStrokeUnit;
  } else {
    convertedQuantity = round2(qtyPerPoint * multiplier);
    convertedUnit = routeUnit;
  }

  const inventoryUnit = normalizeUnit(lubricantUnit || "");
  const inventoryQuantity = convertUnits(convertedQuantity, convertedUnit, inventoryUnit);
  if (inventoryQuantity == null) {
    return {
      ok: false,
      reason: `No se puede convertir ${convertedUnit} a la unidad del inventario (${inventoryUnit || "sin unidad"})`,
    };
  }

  return {
    ok: true,
    inputQuantity: round2(qtyPerPoint),
    inputUnit: routeUnit,
    convertedQuantity,
    convertedUnit,
    inventoryQuantity: round2(inventoryQuantity),
    inventoryUnit,
  };
}
