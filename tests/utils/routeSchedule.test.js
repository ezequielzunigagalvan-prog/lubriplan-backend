import { describe, it, expect } from "vitest";
import {
  toYmd,
  ymdToDate,
  ruleOf,
  nextOccurrence,
  matchesRule,
  firstOnOrAfter,
  nextAfterCompletion,
  describeRule,
} from "../../src/utils/routeSchedule.js";

describe("fechas de calendario", () => {
  it("se guardan a las 12:00 UTC y se leen como el mismo día", () => {
    expect(ymdToDate("2026-09-01").toISOString()).toBe("2026-09-01T12:00:00.000Z");
    expect(toYmd(new Date("2026-09-01T00:00:00Z"))).toBe("2026-09-01");
    expect(toYmd(new Date("2026-09-01T12:00:00Z"))).toBe("2026-09-01");
    expect(toYmd("2026-02-30")).toBeNull();
  });
});

describe("reglas", () => {
  it("cada N días", () => {
    const r = ruleOf({ frequencyDays: 15 });
    expect(nextOccurrence(r, "2026-01-25")).toBe("2026-02-09");
    expect(describeRule(r)).toBe("Quincenal");
  });

  it("semanal en días específicos (Mar y Vie)", () => {
    const r = ruleOf({ frequencyType: "WEEKLY", weeklyDays: [2, 5] });
    expect(nextOccurrence(r, "2026-08-25")).toBe("2026-08-28"); // martes → viernes
    expect(nextOccurrence(r, "2026-08-28")).toBe("2026-09-01"); // viernes → martes
    expect(matchesRule(r, "2026-08-26")).toBe(false);
    expect(describeRule(r)).toBe("Mar · Vie");
  });

  it("mensual por calendario con día ancla y meses cortos", () => {
    const r = ruleOf({ frequencyType: "MONTHLY", monthlyAnchorDay: 31 });
    expect(nextOccurrence(r, "2026-01-31")).toBe("2026-02-28");
    expect(nextOccurrence(r, "2026-02-28")).toBe("2026-03-31");
    expect(nextOccurrence(r, "2026-03-31")).toBe("2026-04-30");
  });

  it("trimestral = 3 meses, cuatrimestral = 4, anual = 12 (no 365 días)", () => {
    expect(nextOccurrence(ruleOf({ frequencyType: "QUARTERLY", monthlyAnchorDay: 5 }), "2026-01-05")).toBe("2026-04-05");
    expect(nextOccurrence(ruleOf({ frequencyType: "FOURMONTHLY", monthlyAnchorDay: 5 }), "2026-01-05")).toBe("2026-05-05");
    expect(nextOccurrence(ruleOf({ frequencyType: "ANNUAL", monthlyAnchorDay: 29 }), "2028-02-29")).toBe("2029-02-28");
  });

  it("primera fecha válida en o después de un día", () => {
    const r = ruleOf({ frequencyType: "WEEKLY", weeklyDays: [1] });
    expect(firstOnOrAfter(r, "2026-11-23")).toBe("2026-11-23"); // lunes
    expect(firstOnOrAfter(r, "2026-11-24")).toBe("2026-11-30");
  });
});

describe("reprogramación al completar (calendario fijo)", () => {
  it("a tiempo: siguiente según la fecha programada", () => {
    expect(nextAfterCompletion(ruleOf({ frequencyDays: 7 }), "2026-11-02", "2026-11-02")).toBe("2026-11-09");
  });
  it("adelantada: no se recorre el calendario", () => {
    expect(nextAfterCompletion(ruleOf({ frequencyDays: 7 }), "2026-11-09", "2026-11-06")).toBe("2026-11-16");
  });
  it("atrasada: conserva el día de la semana y salta lo que ya pasó", () => {
    const lunes = ruleOf({ frequencyType: "WEEKLY", weeklyDays: [1] });
    expect(nextAfterCompletion(lunes, "2026-11-02", "2026-11-11")).toBe("2026-11-16");
  });
  it("mensual atrasada conserva el día del mes", () => {
    const r = ruleOf({ frequencyType: "MONTHLY", monthlyAnchorDay: 5 });
    expect(nextAfterCompletion(r, "2026-09-05", "2026-11-20")).toBe("2026-12-05");
  });
  it("diaria con varios días de atraso: mañana", () => {
    expect(nextAfterCompletion(ruleOf({ frequencyType: "DAILY" }), "2026-11-18", "2026-11-23")).toBe("2026-11-24");
  });
  it("nunca programa el mismo día de ejecución o antes", () => {
    expect(nextAfterCompletion(ruleOf({ frequencyDays: 30 }), "2026-08-25", "2026-11-23")).toBe("2026-12-23");
  });
});
