import { describe, it, expect } from "vitest";
import { parseSpecs, parseDiagramData } from "../../src/routes/equipmentTech.routes.js";

describe("parseSpecs", () => {
  it("limpia filas vacías y recorta", () => {
    const r = parseSpecs([{ label: " Potencia ", value: "15", unit: "kW" }, { label: "", value: "" }]);
    expect(r).toEqual([{ label: "Potencia", value: "15", unit: "kW" }]);
  });
  it("exige nombre y valor", () => {
    expect(() => parseSpecs([{ label: "RPM", value: "" }])).toThrow(/nombre y valor/);
    expect(() => parseSpecs("x")).toThrow(/no válidos/);
  });
});

describe("parseDiagramData", () => {
  const nodes = [
    { id: "p1", type: "PUMP_GREASE", x: 40, y: 40 },
    { id: "d1", type: "DIVIDER", x: 200, y: 40, outlets: 6 },
  ];
  it("acepta un diagrama válido", () => {
    const r = parseDiagramData({ nodes, edges: [{ id: "e1", from: "p1", to: "d1", kind: "MAIN" }] });
    expect(r.nodes).toHaveLength(2);
    expect(r.edges).toHaveLength(1);
    expect(r.version).toBe(1);
  });
  it("rechaza líneas a elementos inexistentes y posiciones inválidas", () => {
    expect(() => parseDiagramData({ nodes, edges: [{ id: "e1", from: "p1", to: "zz" }] })).toThrow(/no existe/);
    expect(() => parseDiagramData({ nodes: [{ id: "a", type: "POINT", x: "x", y: 1 }], edges: [] })).toThrow(/Posición/);
  });
});
