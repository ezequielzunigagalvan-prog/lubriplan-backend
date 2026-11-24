// src/utils/routeSchedule.js
// Programación de rutas por DÍA CALENDARIO (sin horas ni zonas horarias).
//
// Reglas acordadas:
//  - Las fechas de ruta (última, próxima) y la fecha programada de las actividades se guardan
//    a las 12:00 UTC del día: así el día es el mismo en cualquier zona de América.
//  - Mensual, bimestral, trimestral, cuatrimestral, semestral y anual: por calendario
//    (mismo día del mes; si el mes es más corto, el último día).
//  - Al completar, la siguiente fecha sale de la FECHA PROGRAMADA (no del día en que se hizo):
//    el calendario se mantiene. Si esa fecha ya pasó, se toma la siguiente del calendario
//    posterior al día en que se ejecutó.

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY = 86400000;

export const MONTH_TYPES = { MONTHLY: 1, BIMONTHLY: 2, QUARTERLY: 3, FOURMONTHLY: 4, SEMIANNUAL: 6, ANNUAL: 12 };

export const FREQUENCY_LABEL = {
  DAILY: "Diaria",
  WEEKLY: "Semanal",
  MONTHLY: "Mensual",
  BIMONTHLY: "Bimestral",
  QUARTERLY: "Trimestral",
  FOURMONTHLY: "Cuatrimestral",
  SEMIANNUAL: "Semestral",
  ANNUAL: "Anual",
};

/** Fecha guardada (Date o string) → "YYYY-MM-DD" (día UTC). */
export function toYmd(value) {
  if (!value) return null;
  if (typeof value === "string") {
    const s = value.trim().slice(0, 10);
    if (YMD.test(s)) return validYmd(s) ? s : null;
  }
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function validYmd(s) {
  const m = YMD.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** "YYYY-MM-DD" → Date a las 12:00 UTC (forma de guardar fechas de calendario). */
export function ymdToDate(ymd) {
  if (!ymd || !validYmd(ymd)) return null;
  return new Date(`${ymd}T12:00:00.000Z`);
}

export const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const diffDays = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const isoWeekday = (ymd) => {
  const d = new Date(`${ymd}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
};

function addMonthsAnchored(ymd, months, anchorDay) {
  const [y, m, d] = ymd.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const day = Math.min(Number(anchorDay) || d, last);
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), day)).toISOString().slice(0, 10);
}

/**
 * Regla de frecuencia a partir de los campos de la ruta.
 *  frequencyType: DAILY | WEEKLY | MONTHLY | BIMONTHLY | QUARTERLY | FOURMONTHLY | SEMIANNUAL | ANNUAL | null
 *  null (o desconocido) = cada `frequencyDays` días.
 */
export function ruleOf({ frequencyType, frequencyDays, weeklyDays, monthlyAnchorDay } = {}) {
  const type = String(frequencyType || "").toUpperCase().trim();
  if (type === "DAILY") return { kind: "DAYS", days: 1, type: "DAILY" };
  if (type === "WEEKLY") {
    const days = [...new Set((weeklyDays || []).map(Number))].filter((n) => n >= 1 && n <= 7).sort((a, b) => a - b);
    if (days.length) return { kind: "WEEKLY", weekdays: days, type: "WEEKLY" };
    return { kind: "DAYS", days: 7, type: "WEEKLY" };
  }
  if (MONTH_TYPES[type]) {
    const anchor = Number(monthlyAnchorDay);
    return { kind: "MONTHS", months: MONTH_TYPES[type], anchor: anchor >= 1 && anchor <= 31 ? anchor : null, type };
  }
  const n = Number(frequencyDays);
  return Number.isInteger(n) && n > 0 ? { kind: "DAYS", days: n, type: n === 1 ? "DAILY" : null } : null;
}

/** Siguiente fecha de la regla estrictamente posterior a `ymd`. */
export function nextOccurrence(rule, ymd) {
  if (!rule || !ymd) return null;
  if (rule.kind === "DAYS") return addDays(ymd, rule.days);
  if (rule.kind === "WEEKLY") {
    for (let i = 1; i <= 7; i += 1) {
      const c = addDays(ymd, i);
      if (rule.weekdays.includes(isoWeekday(c))) return c;
    }
    return null;
  }
  if (rule.kind === "MONTHS") {
    const anchor = rule.anchor || Number(ymd.slice(8, 10));
    // Si ymd está antes del día ancla en su mes (p. ej. ancla 31 y estamos el 28-feb), cae en este mismo mes.
    const sameMonth = addMonthsAnchored(ymd, 0, anchor);
    if (sameMonth > ymd && rule.months === 1 && Number(ymd.slice(8, 10)) < anchor) return sameMonth;
    return addMonthsAnchored(ymd, rule.months, anchor);
  }
  return null;
}

/** ¿`ymd` es una fecha válida de la regla? (semanal: día de la semana; mensual: día ancla). */
export function matchesRule(rule, ymd) {
  if (!rule || !ymd) return false;
  if (rule.kind === "WEEKLY") return rule.weekdays.includes(isoWeekday(ymd));
  if (rule.kind === "MONTHS" && rule.anchor) {
    const [y, m, d] = ymd.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return d === Math.min(rule.anchor, last);
  }
  return true;
}

/** Primera fecha de la regla en `ymd` o después. */
export function firstOnOrAfter(rule, ymd) {
  if (matchesRule(rule, ymd)) return ymd;
  return nextOccurrence(rule, ymd);
}

/**
 * Próxima fecha al completar una actividad.
 * Parte de la fecha programada y avanza por el calendario hasta quedar después del día de ejecución.
 */
export function nextAfterCompletion(rule, scheduledYmd, executedYmd) {
  if (!rule) return null;
  const base = scheduledYmd || executedYmd;
  let next = nextOccurrence(rule, base);
  let guard = 0;
  while (next && executedYmd && next <= executedYmd && guard < 1000) {
    next = nextOccurrence(rule, next);
    guard += 1;
  }
  return next;
}

/** Texto legible de la frecuencia. */
export function describeRule(rule) {
  if (!rule) return "—";
  if (rule.kind === "WEEKLY") {
    const names = { 1: "Lun", 2: "Mar", 3: "Mié", 4: "Jue", 5: "Vie", 6: "Sáb", 7: "Dom" };
    return rule.weekdays.length === 7 ? "Diaria" : rule.weekdays.map((d) => names[d]).join(" · ");
  }
  if (rule.kind === "MONTHS") return `${FREQUENCY_LABEL[rule.type]}${rule.anchor ? ` (día ${rule.anchor})` : ""}`;
  if (rule.days === 1) return "Diaria";
  if (rule.days === 7) return "Semanal";
  if (rule.days === 15) return "Quincenal";
  return `Cada ${rule.days} días`;
}

/** Días aproximados del ciclo (para frequencyDays, que otros módulos usan como referencia). */
export function approxDays(rule) {
  if (!rule) return null;
  if (rule.kind === "DAYS") return rule.days;
  if (rule.kind === "WEEKLY") return Math.max(1, Math.round(7 / rule.weekdays.length));
  return Math.round(rule.months * 30.4);
}
