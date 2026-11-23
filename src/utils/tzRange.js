// src/utils/tzRange.js
// Límites de día en la zona horaria de la planta.
// El servidor corre en UTC; sin esto, "1 de noviembre" empezaba a las 18:00 del 31 de octubre (hora de México)
// y las actividades de la tarde quedaban en el día/mes equivocado.

export const DEFAULT_TZ = "America/Mexico_City";

const fmtCache = new Map();
function formatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(
      tz,
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    );
  }
  return fmtCache.get(tz);
}

export function safeTimeZone(tz) {
  try {
    if (!tz) return DEFAULT_TZ;
    formatter(String(tz)).format(new Date());
    return String(tz);
  } catch {
    return DEFAULT_TZ;
  }
}

/** Diferencia (ms) entre la hora local de `tz` y UTC en el instante dado. */
function offsetMs(instantMs, tz) {
  const parts = {};
  for (const p of formatter(tz).formatToParts(new Date(instantMs))) parts[p.type] = p.value;
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Instante UTC de las 00:00 del día `ymd` (YYYY-MM-DD) en `tz`. null si es inválido. */
export function zonedStartOfDay(ymd, tz = DEFAULT_TZ) {
  const m = YMD.exec(String(ymd || "").slice(0, 10));
  if (!m) return null;
  const zone = safeTimeZone(tz);
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], 0, 0, 0, 0);
  if (!Number.isFinite(guess)) return null;
  let ts = guess - offsetMs(guess, zone);
  ts = guess - offsetMs(ts, zone); // corrige cambios de horario
  return new Date(ts);
}

/** Último milisegundo del día `ymd` en `tz`. */
export function zonedEndOfDay(ymd, tz = DEFAULT_TZ) {
  const m = YMD.exec(String(ymd || "").slice(0, 10));
  if (!m) return null;
  const next = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + 1));
  const nextYmd = next.toISOString().slice(0, 10);
  const start = zonedStartOfDay(nextYmd, tz);
  return start ? new Date(start.getTime() - 1) : null;
}

/** { from, to } del mes `ym` (YYYY-MM) en `tz`. */
export function zonedMonthRange(ym, tz = DEFAULT_TZ) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ""));
  if (!m) return null;
  const y = +m[1];
  const mo = +m[2];
  if (mo < 1 || mo > 12) return null;
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return {
    from: zonedStartOfDay(`${m[1]}-${m[2]}-01`, tz),
    to: zonedEndOfDay(`${m[1]}-${m[2]}-${String(lastDay).padStart(2, "0")}`, tz),
  };
}

/** Fecha YYYY-MM-DD del instante en `tz`. */
export function zonedYmd(value, tz = DEFAULT_TZ) {
  const d = value instanceof Date ? value : new Date(value);
  if (!value || Number.isNaN(d.getTime())) return "";
  const parts = {};
  for (const p of formatter(safeTimeZone(tz)).formatToParts(d)) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Fecha y hora legibles (dd/mm/aaaa hh:mm) en `tz`, para exportaciones. */
export function zonedDateTimeLabel(value, tz = DEFAULT_TZ) {
  const d = value instanceof Date ? value : new Date(value);
  if (!value || Number.isNaN(d.getTime())) return "";
  const parts = {};
  for (const p of formatter(safeTimeZone(tz)).formatToParts(d)) parts[p.type] = p.value;
  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
}

/** Días calendario entre dos instantes, contados en `tz` (b − a). */
export function zonedDayDiff(a, b, tz = DEFAULT_TZ) {
  const ya = zonedYmd(a, tz);
  const yb = zonedYmd(b, tz);
  if (!ya || !yb) return null;
  return Math.round((Date.parse(`${yb}T00:00:00Z`) - Date.parse(`${ya}T00:00:00Z`)) / 86400000);
}
