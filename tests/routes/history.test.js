import { describe, it, expect } from "vitest";
import {
  zonedStartOfDay,
  zonedEndOfDay,
  zonedMonthRange,
  zonedDayDiff,
  zonedDateTimeLabel,
  safeTimeZone,
} from "../../src/utils/tzRange.js";
import {
  resolveRange,
  buildExecutionsWhere,
  buildMovementsWhere,
  activityKind,
  toCsv,
} from "../../src/routes/history.routes.js";

const MX = "America/Mexico_City";

describe("tzRange", () => {
  it("calcula el inicio y fin del día en hora de México (UTC-6)", () => {
    expect(zonedStartOfDay("2026-11-01", MX).toISOString()).toBe("2026-11-01T06:00:00.000Z");
    expect(zonedEndOfDay("2026-11-30", MX).toISOString()).toBe("2026-12-01T05:59:59.999Z");
  });

  it("rango de mes completo", () => {
    const r = zonedMonthRange("2026-02", MX);
    expect(r.from.toISOString()).toBe("2026-02-01T06:00:00.000Z");
    expect(r.to.toISOString()).toBe("2026-03-01T05:59:59.999Z");
    expect(zonedMonthRange("2026-13", MX)).toBeNull();
  });

  it("respeta zonas con horario de verano", () => {
    // Nueva York en julio: UTC-4
    expect(zonedStartOfDay("2026-07-10", "America/New_York").toISOString()).toBe("2026-07-10T04:00:00.000Z");
  });

  it("una actividad a las 19:00 del 31 de octubre (México) cuenta en octubre", () => {
    const executedAt = new Date("2026-11-01T01:00:00.000Z"); // 31-oct 19:00 CDMX
    const oct = zonedMonthRange("2026-10", MX);
    const nov = zonedMonthRange("2026-11", MX);
    expect(executedAt >= oct.from && executedAt <= oct.to).toBe(true);
    expect(executedAt >= nov.from && executedAt <= nov.to).toBe(false);
  });

  it("días de retraso contados en la zona de la planta", () => {
    expect(zonedDayDiff("2026-11-10T18:00:00Z", "2026-11-12T03:00:00Z", MX)).toBe(1);
    expect(zonedDayDiff("2026-11-10T18:00:00Z", "2026-11-10T20:00:00Z", MX)).toBe(0);
  });

  it("formato de fecha y zona inválida", () => {
    expect(zonedDateTimeLabel("2026-11-01T01:30:00Z", MX)).toBe("31/10/2026 19:30");
    expect(safeTimeZone("Mars/Base")).toBe(MX);
    expect(zonedStartOfDay("no-fecha", MX)).toBeNull();
  });
});

describe("resolveRange", () => {
  it("usa from/to y, si no vienen, el mes", () => {
    expect(resolveRange({ from: "2026-11-01", to: "2026-11-30" }, MX).from.toISOString()).toBe("2026-11-01T06:00:00.000Z");
    expect(resolveRange({ month: "2026-10" }, MX).to.toISOString()).toBe("2026-11-01T05:59:59.999Z");
    expect(resolveRange({}, MX)).toEqual({ from: null, to: null });
  });
  it("rechaza fechas inválidas o invertidas", () => {
    expect(resolveRange({ from: "xx" }, MX).error).toBeTruthy();
    expect(resolveRange({ from: "2026-11-30", to: "2026-11-01" }, MX).error).toBeTruthy();
  });
});

describe("buildExecutionsWhere", () => {
  const range = { from: new Date("2026-11-01T06:00:00Z"), to: null };

  it("solo completadas de la planta", () => {
    const w = buildExecutionsWhere({ plantId: 3, query: {}, range, techScope: null });
    expect(w.AND).toContainEqual({ plantId: 3 });
    expect(w.AND).toContainEqual({ status: "COMPLETED" });
    expect(w.AND).toContainEqual({ executedAt: { gte: range.from } });
  });

  it("el técnico solo ve lo suyo aunque pida otro técnico", () => {
    const w = buildExecutionsWhere({ plantId: 1, query: { technicianId: "9" }, range, techScope: 4 });
    expect(w.AND).toContainEqual({ technicianId: 4 });
    expect(w.AND).not.toContainEqual({ technicianId: 9 });
  });

  it("filtros de condición, mala condición, evidencia y equipo", () => {
    const c = buildExecutionsWhere({ plantId: 1, query: { condition: "critico" }, range, techScope: null });
    expect(c.AND).toContainEqual({ condition: "CRITICO" });

    const bad = buildExecutionsWhere({ plantId: 1, query: { filter: "bad-condition" }, range, techScope: null });
    expect(bad.AND).toContainEqual({ condition: { in: ["MALO", "CRITICO"] } });

    const noCond = buildExecutionsWhere({ plantId: 1, query: { condition: "MALO" }, range, techScope: null, withCondition: false });
    expect(JSON.stringify(noCond)).not.toContain("MALO");

    const ev = buildExecutionsWhere({ plantId: 1, query: { evidence: "1", equipmentId: "7" }, range, techScope: null });
    expect(ev.AND).toContainEqual({ evidenceImage: { not: null } });
    expect(ev.AND).toContainEqual({ OR: [{ equipmentId: 7 }, { route: { is: { equipmentId: 7 } } }] });
  });

  it("buscar por folio", () => {
    const w = buildExecutionsWhere({ plantId: 1, query: { q: "#152" }, range, techScope: null });
    expect(w.AND.at(-1).OR[0]).toEqual({ id: 152 });
  });
});

describe("buildMovementsWhere", () => {
  it("scope de planta, tipo y técnico", () => {
    const w = buildMovementsWhere({ plantId: 2, query: { type: "out" }, range: {}, techScope: 5 });
    expect(w.AND[0]).toEqual({ OR: [{ lubricant: { plantId: 2 } }, { execution: { is: { plantId: 2 } } }] });
    expect(w.AND).toContainEqual({ type: "OUT" });
    expect(w.AND).toContainEqual({ execution: { is: { plantId: 2, technicianId: 5 } } });
  });
});

describe("activityKind", () => {
  it("distingue ruta, inspección, emergencia, OLP, manual y ruta eliminada", () => {
    expect(activityKind({ route: { routeKind: "LUBRICATION" } })).toBe("ROUTE");
    expect(activityKind({ route: { routeKind: "INSPECTION" } })).toBe("INSPECTION");
    expect(activityKind({ manualTitle: "EMERGENTE · Bomba" })).toBe("EMERGENCY");
    expect(activityKind({ sourceType: "OLP", route: {} })).toBe("OLP");
    expect(activityKind({ origin: "MANUAL", manualTitle: "Limpieza" })).toBe("MANUAL");
    expect(activityKind({ origin: "ROUTE", route: null, manualTitle: "Ruta X" })).toBe("DELETED_ROUTE");
  });
});

describe("toCsv", () => {
  it("escapa comas, comillas y saltos, y neutraliza fórmulas", () => {
    const csv = toCsv(["A", "B"], [["x, y", 'di "hola"'], ["=SUMA(1)", -5], ["línea\nnueva", null]]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain('"x, y","di ""hola"""');
    expect(csv).toContain("'=SUMA(1),-5");
    expect(csv).toContain('"línea\nnueva",');
  });
});
