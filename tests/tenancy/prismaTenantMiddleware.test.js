// El filtro automático por planta no debe romper creates que usan la relación `plant`.
import { describe, it, expect, vi } from "vitest";
import { applyPrismaTenantMiddleware } from "../../src/tenancy/prismaTenantMiddleware.js";
import { runWithTenant } from "../../src/tenancy/tenantContext.js";

function capture() {
  let mw;
  applyPrismaTenantMiddleware({ $use: (fn) => (mw = fn) });
  return (params) => runWithTenant({ plantId: 7 }, () => mw(params, async (p) => p));
}

describe("prismaTenantMiddleware", () => {
  const run = capture();

  it("no agrega plantId si la planta viene como relación (crear ruta)", async () => {
    const out = await run({ model: "Route", action: "create", args: { data: { name: "R", plant: { connect: { id: 7 } } } } });
    expect(out.args.data.plantId).toBeUndefined();
    expect(out.args.data.plant).toEqual({ connect: { id: 7 } });
  });

  it("sí agrega plantId cuando no viene la planta", async () => {
    const out = await run({ model: "Route", action: "create", args: { data: { name: "R" } } });
    expect(out.args.data.plantId).toBe(7);
  });

  it("filtra las búsquedas por la planta del contexto", async () => {
    const out = await run({ model: "Lubricant", action: "findMany", args: { where: { name: "x" } } });
    expect(out.args.where).toEqual({ name: "x", plantId: 7 });
  });

  it("no toca modelos sin planta", async () => {
    const out = await run({ model: "User", action: "findMany", args: { where: {} } });
    expect(out.args.where).toEqual({});
  });

  it("createMany respeta filas con planta como relación o scalar", async () => {
    const out = await run({
      model: "Execution",
      action: "createMany",
      args: { data: [{ a: 1 }, { plantId: 3 }, { plant: { connect: { id: 7 } } }] },
    });
    expect(out.args.data).toEqual([{ a: 1, plantId: 7 }, { plantId: 3 }, { plant: { connect: { id: 7 } } }]);
  });
});

vi.mock("../../src/config/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
