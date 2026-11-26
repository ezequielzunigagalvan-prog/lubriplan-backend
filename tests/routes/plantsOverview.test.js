import { describe, it, expect } from "vitest";
import { plantHealth } from "../../src/routes/plantsOverview.routes.js";

const base = { overdue: 0, criticalReports: 0, compliance: 100, lowStock: 0, unassigned: 0 };

describe("plantHealth", () => {
  it("planta en orden", () => {
    const h = plantHealth(base);
    expect(h.level).toBe("ok");
    expect(h.score).toBe(100);
    expect(h.reasons).toEqual([]);
  });
  it("atención por atrasadas o inventario", () => {
    expect(plantHealth({ ...base, overdue: 2 }).level).toBe("warning");
    expect(plantHealth({ ...base, lowStock: 1 }).level).toBe("warning");
    expect(plantHealth({ ...base, compliance: 85 }).level).toBe("warning");
  });
  it("crítica por reporte crítico, cumplimiento bajo o muchas atrasadas", () => {
    expect(plantHealth({ ...base, criticalReports: 1 }).level).toBe("critical");
    expect(plantHealth({ ...base, compliance: 60 }).level).toBe("critical");
    expect(plantHealth({ ...base, overdue: 12 }).level).toBe("critical");
  });
  it("sin actividades programadas no penaliza el cumplimiento", () => {
    const h = plantHealth({ ...base, compliance: null });
    expect(h.level).toBe("ok");
    expect(h.score).toBe(100);
  });
  it("el puntaje baja con los problemas y explica por qué", () => {
    const h = plantHealth({ ...base, compliance: 90, overdue: 3, unassigned: 2 });
    expect(h.score).toBe(90 - 9 - 2);
    expect(h.reasons).toContain("3 atrasadas");
    expect(h.reasons).toContain("2 sin técnico");
  });
});
