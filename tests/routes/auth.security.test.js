// Seguridad: login sin contraseña maestra y contexto de planta validado.
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const SECRET = "test-secret-de-64-caracteres-minimo-para-pasar-validacion";
process.env.JWT_SECRET = SECRET;

const prisma = (await import("../../src/prisma.js")).default;
const authRouter = (await import("../../src/routes/auth.js")).default;
const { requireAuth } = await import("../../src/middleware/requireAuth.js");
const { getCurrentPlantId, runWithTenant } = await import("../../src/tenancy/tenantContext.js");

describe("POST /api/auth/login", () => {
  let app;
  beforeEach(async () => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use("/api/auth", authRouter);
    prisma.user.findUnique.mockResolvedValue({
      id: 1,
      name: "Admin",
      email: "admin@planta.test",
      role: "ADMIN",
      active: true,
      technicianId: null,
      passwordHash: await bcrypt.hash("ContraseñaReal123", 4),
    });
    prisma.userPlant.findMany.mockResolvedValue([]);
  });

  it('rechaza la contraseña "password" si no es la del usuario', async () => {
    const res = await request(app).post("/api/auth/login").send({ email: "admin@planta.test", password: "password" });
    expect(res.status).toBe(401);
  });

  it("acepta la contraseña real", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "admin@planta.test", password: "ContraseñaReal123" });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });
});

describe("requireAuth fija el contexto de planta validado", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue({ id: 1, role: "ADMIN", active: true, technicianId: null });
    prisma.userPlant.findFirst.mockResolvedValue({ plantId: 2 });
  });

  it("ignora una planta previa sin validar y usa la del usuario", async () => {
    const token = jwt.sign({ sub: 1 }, SECRET);
    const req = { method: "GET", originalUrl: "/api/x", headers: { authorization: `Bearer ${token}` } };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(), sendStatus: vi.fn() };

    let plantInsideNext;
    // Simula el contexto armado antes de autenticar con una planta ajena (p. ej. ?plantId=99)
    await runWithTenant({ plantId: 99 }, () =>
      requireAuth(req, res, () => {
        plantInsideNext = getCurrentPlantId();
      })
    );

    expect(req.currentPlantId).toBe(2);
    expect(plantInsideNext).toBe(2);
  });
});
