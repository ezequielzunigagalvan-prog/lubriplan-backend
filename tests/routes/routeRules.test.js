import { describe, it, expect } from "vitest";
import { parseRouteInput } from "../../src/routes/routeRules.js";

const base = { name: "Chumaceras", equipmentId: 5, quantity: 20, unit: "g", points: 2, lubricantType: "GRASA", frequencyDays: 15, lastDate: "2026-11-01" };
const today = "2026-11-23";

describe("parseRouteInput", () => {
  it("calcula la próxima fecha desde la última según la frecuencia", () => {
    const r = parseRouteInput(base, { today });
    expect(r.schedule.nextYmd).toBe("2026-11-16");
    expect(r.equipmentIds).toEqual([5]);
    expect(r.fields).toMatchObject({ quantity: 20, unit: "g", points: 2, evidenceRequired: false });
  });

  it("mensual por calendario: ancla el día de la próxima fecha", () => {
    const r = parseRouteInput({ ...base, frequencyType: "MONTHLY", nextDate: "2026-12-05" }, { today });
    expect(r.fields).toMatchObject({ frequencyType: "MONTHLY", monthlyAnchorDay: 5, frequencyDays: 30 });
  });

  it("semanal: la próxima fecha debe caer en un día elegido", () => {
    expect(() => parseRouteInput({ ...base, frequencyType: "WEEKLY", weeklyDays: [1], nextDate: "2026-11-25" }, { today })).toThrow(/días de la semana/);
    const ok = parseRouteInput({ ...base, frequencyType: "WEEKLY", weeklyDays: [3, 1], lastDate: "2026-11-23" }, { today });
    expect(ok.schedule.nextYmd).toBe("2026-11-25");
    expect(ok.fields.weeklyDays).toEqual([1, 3]);
  });

  it("varios equipos sin repetidos; el primero es el principal", () => {
    const r = parseRouteInput({ ...base, equipmentIds: [7, 3, 7, "9"], evidenceRequired: true }, { today });
    expect(r.equipmentIds).toEqual([7, 3, 9]);
    expect(r.fields.evidenceRequired).toBe(true);
  });

  it("errores claros: cantidad, bombazos, puntos, fechas", () => {
    expect(() => parseRouteInput({ ...base, quantity: 0 }, { today })).toThrow(/mayor a cero/);
    expect(() => parseRouteInput({ ...base, unit: "BOMBAZOS" }, { today })).toThrow(/bombazo/);
    expect(() => parseRouteInput({ ...base, points: 1.5 }, { today })).toThrow(/entero/);
    expect(() => parseRouteInput({ ...base, lastDate: "2026-12-01" }, { today })).toThrow(/futura/);
    expect(() => parseRouteInput({ ...base, lastDate: "", nextDate: "" }, { today })).toThrow(/última fecha/);
    expect(() => parseRouteInput({ ...base, nextDate: "2026-10-01" }, { today })).toThrow(/posterior/);
  });

  it("inspección sin cantidad es válida", () => {
    const r = parseRouteInput({ ...base, quantity: "", lubricantType: "" }, { today, isInspection: true });
    expect(r.fields.quantity).toBeNull();
    expect(r.fields.unit).toBeNull();
  });

  it("edición conserva la evidencia si no se envía", () => {
    const r = parseRouteInput(base, { today, existing: { evidenceRequired: true } });
    expect(r.fields.evidenceRequired).toBe(true);
  });
});
