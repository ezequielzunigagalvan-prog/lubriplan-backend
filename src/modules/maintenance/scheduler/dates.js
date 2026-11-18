const TIMEZONE = process.env.MAINTENANCE_TIMEZONE || "America/Mexico_City";

function getLocalDateParts(date, tz = TIMEZONE) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;

  return {
    year: parseInt(get("year")),
    month: parseInt(get("month")),
    day: parseInt(get("day")),
    hour: parseInt(get("hour")),
    minute: parseInt(get("minute")),
    second: parseInt(get("second")),
  };
}

function localDateToUTC(year, month, day, hour = 0, minute = 0, second = 0, tz = TIMEZONE) {
  const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
  const date = new Date(dateStr);

  const parts = getLocalDateParts(date, tz);
  const offset = new Date(dateStr) - new Date(
    new Date(dateStr).toLocaleString("en-US", { timeZone: tz })
  );

  return new Date(date.getTime() - offset);
}

function addMonthsNoDrift(date, months, tz = TIMEZONE) {
  const parts = getLocalDateParts(date, tz);
  let { year, month, day } = parts;

  month += months;
  year += Math.floor((month - 1) / 12);
  month = ((month - 1) % 12) + 1;

  const lastDay = new Date(year, month, 0).getDate();
  if (day > lastDay) {
    day = lastDay;
  }

  return localDateToUTC(year, month, day, 0, 0, 0, tz);
}

export function addInterval(date, unit, every, tz = TIMEZONE) {
  if (!date) return null;

  const parts = getLocalDateParts(date, tz);
  let { year, month, day } = parts;

  if (unit === "DAY") {
    const d = new Date(date);
    d.setDate(d.getDate() + every);
    return localDateToUTC(d.getFullYear(), d.getMonth() + 1, d.getDate(), 0, 0, 0, tz);
  } else if (unit === "WEEK") {
    const d = new Date(date);
    d.setDate(d.getDate() + every * 7);
    return localDateToUTC(d.getFullYear(), d.getMonth() + 1, d.getDate(), 0, 0, 0, tz);
  } else if (unit === "MONTH") {
    return addMonthsNoDrift(date, every, tz);
  } else if (unit === "YEAR") {
    return addMonthsNoDrift(date, every * 12, tz);
  }

  return date;
}

export function buildCycleKey(plan, dueAt, triggerType = "TIME") {
  if (triggerType === "TIME") {
    const year = dueAt.getUTCFullYear();
    const month = String(dueAt.getUTCMonth() + 1).padStart(2, "0");
    const day = String(dueAt.getUTCDate()).padStart(2, "0");
    return `T:${year}-${month}-${day}`;
  } else if (triggerType === "METER") {
    const umbral = plan.lastMeterTrigger || plan.meterBaseline || 0;
    return `M:${umbral}`;
  }

  return null;
}

export function getStartOfDayUTC(date = new Date(), tz = TIMEZONE) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export function getEndOfDayUTC(date = new Date(), tz = TIMEZONE) {
  const d = new Date(date);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

/** Medianoche (hora local de la planta) del día de `date`, expresada en UTC. */
export function startOfLocalDay(date = new Date(), tz = TIMEZONE) {
  const { year, month, day } = getLocalDateParts(new Date(date), tz);
  return localDateToUTC(year, month, day, 0, 0, 0, tz);
}
