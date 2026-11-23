import { describe, it, expect } from "vitest";
import {
  resolvePeriod,
  complianceStats,
  conditionStats,
  lubricantKind,
  toDisplayQty,
  oleIndex,
} from "../../src/routes/analysis.routes.js";

const MX = "America/Mexico_City";
// 18:00 UTC = 12:00 en CDMX
const at = (ymd, hourUtc = 18) => new Date(`${ymd}T${String(hourUtc).padStart(2, "0")}:00:00Z`);

describe("resolvePeriod", () => {
  it("últimos N días terminando hoy (hora de planta) y periodo anterior del mismo largo", () => {
    const now = new Date("2026-11-23T03:00:00Z"); // 22-nov 21:00 en CDMX
    const p = resolvePeriod({ days: "30" }, MX, now);
    expect(p.today).toBe("2026-11-22");
    expect(p.fromYmd).toBe("2026-10-24");
    expect(p.toYmd).toBe("2026-11-22");
    expect(p.days).toBe(30);
    expect(p.prev).toMatchObject({ fromYmd: "2026-09-24", toYmd: "2026-10-23" });
    expect(p.from.toISOString()).toBe("2026-10-24T06:00:00.000Z");
  });
  it("rango explícito y validación", () => {
    expect(resolvePeriod({ from: "2026-11-01", to: "2026-11-30" }, MX).days).toBe(30);
    expect(resolvePeriod({ from: "2026-11-30", to: "2026-11-01" }, MX).error).toBeTruthy();
  });
});

describe("complianceStats", () => {
  const P = { tz: MX, today: "2026-11-20", fromYmd: "2026-11-01", toYmd: "2026-11-30" };
  const rows = [
    { status: "COMPLETED", scheduledAt: at("2026-11-05"), executedAt: at("2026-11-05") }, // a tiempo
    { status: "COMPLETED", scheduledAt: at("2026-11-05"), executedAt: at("2026-11-04") }, // adelantada = a tiempo
    { status: "COMPLETED", scheduledAt: at("2026-11-05"), executedAt: at("2026-11-08") }, // 3 días tarde
    { status: "PENDING", scheduledAt: at("2026-11-10"), executedAt: null }, // vencida
    { status: "OVERDUE", scheduledAt: at("2026-11-11"), executedAt: null }, // vencida
    { status: "PENDING", scheduledAt: at("2026-11-20"), executedAt: null }, // hoy: aún en tiempo
    { status: "COMPLETED", scheduledAt: at("2026-11-20"), executedAt: at("2026-11-20") }, // hoy hecha
    { status: "PENDING", scheduledAt: at("2026-11-25"), executedAt: null }, // futura
    { status: "COMPLETED", scheduledAt: at("2026-10-30"), executedAt: at("2026-11-02") }, // fuera del periodo
  ];

  it("cuenta exigibles, a tiempo, tarde y vencidas", () => {
    const s = complianceStats(rows, P);
    expect(s).toMatchObject({ scheduled: 8, due: 6, completed: 4, onTime: 3, late: 1, overdue: 2, dueToday: 1, upcoming: 1 });
    expect(s.complianceRate).toBe(66.7);
    expect(s.onTimeRate).toBe(50);
    expect(s.avgLateDays).toBe(3);
  });

  it("usa el día de la planta, no el de UTC", () => {
    // Programada 5-nov 12:00 CDMX, ejecutada 5-nov 23:30 CDMX (= 6-nov 05:30 UTC): a tiempo
    const s = complianceStats([{ status: "COMPLETED", scheduledAt: at("2026-11-05"), executedAt: new Date("2026-11-06T05:30:00Z") }], P);
    expect(s.onTime).toBe(1);
    expect(s.late).toBe(0);
  });

  it("sin actividades exigibles el porcentaje es null, no 0", () => {
    expect(complianceStats([], P).complianceRate).toBeNull();
  });
});

describe("conditionStats", () => {
  it("condición normal sobre las que tienen dato", () => {
    const s = conditionStats([{ condition: "BUENO" }, { condition: "REGULAR" }, { condition: "MALO" }, { condition: "CRITICO" }, { condition: null }]);
    expect(s).toMatchObject({ BUENO: 1, REGULAR: 1, MALO: 1, CRITICO: 1, SIN_DATO: 1, withData: 4, abnormal: 2, normalRate: 50 });
  });
});

describe("consumo", () => {
  it("tipo de lubricante por tipo, nombre o unidad", () => {
    expect(lubricantKind({ type: "Grasa multipropósito", unit: "kg" })).toBe("GRASA");
    expect(lubricantKind({ type: "Aceite hidráulico", unit: "L" })).toBe("ACEITE");
    expect(lubricantKind({ name: "ISO 68", unit: "ml" })).toBe("ACEITE");
    expect(lubricantKind({ name: "Cartucho", unit: "pza" })).toBe("OTRO");
  });
  it("convierte a L y kg", () => {
    expect(toDisplayQty(1500, "ml", "ACEITE")).toEqual({ qty: 1.5, unit: "L" });
    expect(toDisplayQty(250, "g", "GRASA")).toEqual({ qty: 0.25, unit: "kg" });
    expect(toDisplayQty(3, "pza", "OTRO")).toEqual({ qty: 3, unit: "pza" });
  });
});

describe("oleIndex", () => {
  it("producto de los tres indicadores", () => {
    expect(oleIndex(90, 80, 95)).toBe(68.4);
    expect(oleIndex(null, 80, 95)).toBeNull();
  });
});
