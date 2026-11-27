// Separación entre clientes: un ADMIN solo ve y administra lo de sus plantas.
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { scopePlantIds, assertCanManageUser, assertPlantsInScope, ScopeError } from "../../src/services/accessScope.js";
import ownerRoutes, { parseClientInput } from "../../src/routes/owner.routes.js";

// Usuarios: 1 dueño (plantas 1 y 5 por soporte), 2 admin cliente A (planta 1), 3 técnico A (planta 1),
// 4 admin cliente B (planta 5), 6 usuario con plantas 1 y 5.
const links = [
  { userId: 1, plantId: 1 }, { userId: 1, plantId: 5 },
  { userId: 2, plantId: 1 }, { userId: 3, plantId: 1 },
  { userId: 4, plantId: 5 }, { userId: 6, plantId: 1 }, { userId: 6, plantId: 5 },
];
const owners = new Set([1]);
const db = {
  userPlant: { findMany: async ({ where }) => links.filter((l) => l.userId === where.userId).map((l) => ({ plantId: l.plantId })) },
  user: {
    findUnique: async ({ where }) =>
      [1, 2, 3, 4, 6].includes(where.id)
        ? { id: where.id, isPlatformOwner: owners.has(where.id), userPlants: links.filter((l) => l.userId === where.id).map((l) => ({ plantId: l.plantId })) }
        : null,
  },
};
const owner = { id: 1, role: "ADMIN", isPlatformOwner: true };
const adminA = { id: 2, role: "ADMIN" };

describe("Alcance entre clientes", () => {
  it("el dueño ve todas las plantas; un admin solo las suyas", async () => {
    expect(await scopePlantIds(db, owner)).toBeNull();
    expect(await scopePlantIds(db, adminA)).toEqual([1]);
  });

  it("un admin administra a usuarios de su cliente", async () => {
    await expect(assertCanManageUser(db, adminA, 3)).resolves.toBeTruthy();
  });

  it("un admin no puede tocar usuarios de otro cliente, compartidos ni al dueño", async () => {
    await expect(assertCanManageUser(db, adminA, 4)).rejects.toBeInstanceOf(ScopeError);
    await expect(assertCanManageUser(db, adminA, 6)).rejects.toBeInstanceOf(ScopeError);
    await expect(assertCanManageUser(db, adminA, 1)).rejects.toBeInstanceOf(ScopeError);
  });

  it("un admin no puede asignar plantas de otro cliente", async () => {
    await expect(assertPlantsInScope(db, adminA, [1])).resolves.toBeUndefined();
    await expect(assertPlantsInScope(db, adminA, [1, 5])).rejects.toBeInstanceOf(ScopeError);
    await expect(assertPlantsInScope(db, owner, [1, 5, 9])).resolves.toBeUndefined();
  });
});

describe("Consola del dueño", () => {
  const app = (user) => {
    const a = express();
    a.use(express.json());
    a.use("/api/owner", ownerRoutes({ prisma: {}, auth: (req, _res, next) => ((req.user = user), next()) }));
    return a;
  };

  it("responde 404 a cualquier admin que no sea el dueño", async () => {
    expect((await request(app(adminA)).get("/api/owner/overview")).status).toBe(404);
    expect((await request(app(adminA)).post("/api/owner/clients").send({})).status).toBe(404);
  });

  it("valida el alta del cliente y por defecto no liga al dueño", () => {
    const r = parseClientInput({ plantName: "Planta X", adminName: "Ana", adminEmail: "ANA@x.com", adminPassword: "12345678" });
    expect(r.linkMe).toBe(false);
    expect(r.admin).toMatchObject({ mode: "new", email: "ana@x.com" });
    expect(() => parseClientInput({ plantName: "", adminName: "a", adminEmail: "a@b.co", adminPassword: "12345678" })).toThrow();
    expect(() => parseClientInput({ plantName: "P", adminName: "a", adminEmail: "a@b.co", adminPassword: "123" })).toThrow();
    expect(parseClientInput({ plantName: "P", adminName: "a", adminEmail: "a@b.co", sendInvite: true }).admin.password).toBe("");
    expect(parseClientInput({ plantName: "P", adminMode: "existing", adminUserId: 4 }).admin).toEqual({ mode: "existing", userId: 4 });
  });
});
