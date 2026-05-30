// tests/middleware/requireAuth.test.js
import { describe, it, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";

// Necesitamos mockear prisma antes de importar requireAuth
const mockUser = { id: 1, role: "ADMIN", active: true, technicianId: null };
const mockUserPlant = { plantId: 1 };

vi.mock("../../src/prisma.js", () => ({
  default: {
    user: { findUnique: vi.fn() },
    userPlant: { findUnique: vi.fn(), findFirst: vi.fn() },
  },
}));

vi.mock("../../src/config/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const SECRET = "test-secret-de-64-caracteres-minimo-para-pasar-validacion";
process.env.JWT_SECRET = SECRET;

const { requireAuth } = await import("../../src/middleware/requireAuth.js");
const prisma = (await import("../../src/prisma.js")).default;

function makeReqRes(token) {
  const req = {
    method: "GET",
    originalUrl: "/api/test",
    headers: { authorization: token ? `Bearer ${token}` : "" },
  };
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    sendStatus: vi.fn().mockReturnThis(),
  };
  const next = vi.fn();
  return { req, res, next };
}

describe("requireAuth middleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue(mockUser);
    prisma.userPlant.findFirst.mockResolvedValue(mockUserPlant);
  });

  it("retorna 401 sin token", async () => {
    const { req, res, next } = makeReqRes(null);
    await requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("retorna 401 con token inválido", async () => {
    const { req, res, next } = makeReqRes("token.invalido.falso");
    await requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("llama next() con token válido", async () => {
    const token = jwt.sign({ sub: 1, role: "ADMIN" }, SECRET, { expiresIn: "1h" });
    const { req, res, next } = makeReqRes(token);
    await requireAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toMatchObject({ id: 1, role: "ADMIN" });
  });

  it("retorna 401 si el usuario está inactivo", async () => {
    prisma.user.findUnique.mockResolvedValue({ ...mockUser, active: false });
    const token = jwt.sign({ sub: 1 }, SECRET, { expiresIn: "1h" });
    const { req, res, next } = makeReqRes(token);
    await requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("retorna 401 si el usuario no existe en BD", async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const token = jwt.sign({ sub: 999 }, SECRET, { expiresIn: "1h" });
    const { req, res, next } = makeReqRes(token);
    await requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("responde 204 a OPTIONS sin validar token", async () => {
    const { req, res, next } = makeReqRes(null);
    req.method = "OPTIONS";
    await requireAuth(req, res, next);
    expect(res.sendStatus).toHaveBeenCalledWith(204);
  });
});
