import { describe, it, expect } from "vitest";
import { convertUnits, computeRouteConsumption } from "../../src/utils/units.js";

describe("convertUnits", () => {
  it("convierte volumen y peso", () => {
    expect(convertUnits(1500, "ml", "L")).toBe(1.5);
    expect(convertUnits(2, "kg", "g")).toBe(2000);
  });
  it("no convierte peso <-> volumen", () => {
    expect(convertUnits(10, "g", "ml")).toBeNull();
  });
});

describe("computeRouteConsumption", () => {
  it("multiplica la cantidad por punto por el número de puntos", () => {
    const r = computeRouteConsumption({ quantity: 50, unit: "ml", points: 4 }, "L");
    expect(r.ok).toBe(true);
    expect(r.convertedQuantity).toBe(200);
    expect(r.inventoryQuantity).toBe(0.2);
  });

  it("no multiplica en rutas con puntos avanzados", () => {
    const r = computeRouteConsumption(
      { quantity: 50, unit: "ml", points: 4, instructions: "PUNTOS (AVANZADO) ..." },
      "ml"
    );
    expect(r.inventoryQuantity).toBe(50);
  });

  it("convierte bombazos con el valor de embolada", () => {
    const r = computeRouteConsumption(
      { quantity: 3, unit: "BOMBAZOS", points: 2, pumpStrokeValue: 1.5, pumpStrokeUnit: "g" },
      "kg"
    );
    expect(r.convertedQuantity).toBe(9);
    expect(r.convertedUnit).toBe("g");
    expect(r.inventoryQuantity).toBe(0.01); // 9 g = 0.009 kg, redondeado a 2 decimales
  });

  it("falla con bombazos sin conversión configurada", () => {
    const r = computeRouteConsumption({ quantity: 3, unit: "BOMBAZOS" }, "g");
    expect(r.ok).toBe(false);
  });

  it("falla si las unidades no son compatibles", () => {
    const r = computeRouteConsumption({ quantity: 10, unit: "g" }, "L");
    expect(r.ok).toBe(false);
  });
});
