// src/utils/routeScheduling.js
// Funciones puras de cálculo de fechas para rutas de lubricación.
// Extraídas de index.js para reutilización en preventiveOrders.routes.js
// sin duplicar lógica.

/**
 * Parsea cualquier representación de fecha a un objeto Date a mediodía local
 * (evita desfases UTC). Devuelve null si el valor no es parseable.
 */
export function parseDateOrNull(value) {
  if (!value) return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(
      value.getFullYear(),
      value.getMonth(),
      value.getDate(),
      12, 0, 0, 0
    );
  }

  const s = String(value).trim();
  if (!s) return null;

  const onlyDate = s.slice(0, 10);
  const [y, m, d] = onlyDate.split("-").map(Number);

  if (!y || !m || !d) return null;

  return new Date(y, m - 1, d, 12, 0, 0, 0);
}

/** Devuelve la fecha a las 00:00:00 local. */
export function startOfDay(value) {
  const d = parseDateOrNull(value);
  if (!d) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

/** Devuelve la fecha a las 23:59:59.999 local. */
export function endOfDay(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  const out = new Date(dt);
  out.setHours(23, 59, 59, 999);
  return out;
}

/** Fija la hora a las 12:00 para evitar desfases UTC al guardar scheduledAt. */
export function toSafeNoon(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  const out = new Date(dt);
  out.setHours(12, 0, 0, 0);
  return out;
}

/** Último día del mes (base 0 para el mes). */
function getLastDayOfMonth(year, monthIndexZeroBased) {
  return new Date(year, monthIndexZeroBased + 1, 0).getDate();
}

/**
 * Suma N meses a baseDate fijando el día al anchorDay (sin desbordarse
 * más allá del último día del mes destino).
 */
export function addMonthsClamped(baseDate, monthsToAdd, anchorDay) {
  const base = startOfDay(baseDate);
  const y = base.getFullYear();
  const m = base.getMonth();

  const targetMonthDate = new Date(y, m + monthsToAdd, 1);
  const targetYear  = targetMonthDate.getFullYear();
  const targetMonth = targetMonthDate.getMonth();

  const desiredDay = Number(anchorDay) || base.getDate();
  const lastDay    = getLastDayOfMonth(targetYear, targetMonth);
  const finalDay   = Math.min(desiredDay, lastDay);

  return new Date(targetYear, targetMonth, finalDay, 0, 0, 0, 0);
}

/** Número de día ISO (1=Lun … 7=Dom) */
function getIsoWeekday(date) {
  const jsDay = date.getDay();
  return jsDay === 0 ? 7 : jsDay;
}

/**
 * Dado fromDate, devuelve el próximo día de la semana que esté en weeklyDays
 * (array de números ISO 1-7). Busca hasta 14 días hacia adelante.
 */
export function getNextWeeklySelectedDate(fromDate, weeklyDays = []) {
  const base = startOfDay(fromDate);
  const validDays = Array.from(new Set((weeklyDays || []).map(Number)))
    .filter((n) => n >= 1 && n <= 7)
    .sort((a, b) => a - b);

  if (!validDays.length) return null;

  for (let i = 1; i <= 14; i += 1) {
    const candidate = new Date(base);
    candidate.setDate(candidate.getDate() + i);

    const iso = getIsoWeekday(candidate);
    if (validDays.includes(iso)) {
      candidate.setHours(0, 0, 0, 0);
      return candidate;
    }
  }

  return null;
}

/**
 * Calcula la próxima fecha programada de una ruta.
 *
 * Reglas:
 * - Si nextDate ya viene definida (override manual), la usa directamente.
 * - Si no, calcula desde lastDate según el tipo de frecuencia.
 *
 * @param {object} opts
 * @param {Date|string|null} opts.lastDate       Última fecha ejecutada
 * @param {Date|string|null} opts.nextDate       Override de próxima fecha (o null)
 * @param {number}           opts.frequencyDays  Días entre ejecuciones (fallback)
 * @param {string|null}      opts.frequencyType  WEEKLY|MONTHLY|BIMONTHLY|QUARTERLY|SEMIANNUAL|ANNUAL
 * @param {number[]}         opts.weeklyDays     Días ISO (1-7) para WEEKLY
 * @param {number|null}      opts.monthlyAnchorDay Día del mes para frecuencias mensuales
 * @returns {Date|null}
 */
export function resolveNextRouteDate({
  lastDate,
  nextDate,
  frequencyDays,
  frequencyType,
  weeklyDays,
  monthlyAnchorDay,
}) {
  const parsedNext = parseDateOrNull(nextDate);
  if (parsedNext) return startOfDay(parsedNext);

  const parsedLast = parseDateOrNull(lastDate);
  if (!parsedLast) return null;

  const type = String(frequencyType || "").toUpperCase().trim();

  if (type === "WEEKLY" && Array.isArray(weeklyDays) && weeklyDays.length > 0) {
    return getNextWeeklySelectedDate(parsedLast, weeklyDays);
  }

  if (type === "MONTHLY") {
    return addMonthsClamped(parsedLast, 1, monthlyAnchorDay || parsedLast.getDate());
  }

  if (type === "BIMONTHLY") {
    return addMonthsClamped(parsedLast, 2, monthlyAnchorDay || parsedLast.getDate());
  }

  if (type === "QUARTERLY") {
    return addMonthsClamped(parsedLast, 4, monthlyAnchorDay || parsedLast.getDate());
  }

  if (type === "SEMIANNUAL") {
    return addMonthsClamped(parsedLast, 6, monthlyAnchorDay || parsedLast.getDate());
  }

  if (type === "ANNUAL") {
    return addMonthsClamped(parsedLast, 12, monthlyAnchorDay || parsedLast.getDate());
  }

  const days = Number(frequencyDays);
  if (Number.isFinite(days) && days > 0) {
    const d = startOfDay(parsedLast);
    d.setDate(d.getDate() + days);
    return d;
  }

  return null;
}
