// Recuperación de contraseña: token de un solo uso, sin revelar qué correos existen.
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const SECRET = "test-secret-de-64-caracteres-minimo-para-pasar-validacion";
process.env.JWT_SECRET = SECRET;
process.env.APP_BASE_URL = "https://app.ejemplo.test";

const sendEmail = vi.fn(async () => ({ ok: true }));
vi.mock("../../src/services/email/email.service.js", () => ({ sendEmail: (...a) => sendEmail(...a) }));

const prisma = (await import("../../src/prisma.js")).default;
const authRouter = (await import("../../src/routes/auth.js")).default;
const { createResetToken } = await import("../../src/services/auth/passwordReset.js");

let ipN = 0;
function app() {
  const a = express();
  a.set("trust proxy", true);
  a.use(express.json());
  a.use("/api/auth", authRouter);
  return a;
}
const post = (path, body) =>
  request(app()).post(`/api/auth${path}`).set("x-forwarded-for", `10.9.0.${++ipN}`).send(body);

let user;
beforeEach(async () => {
  vi.clearAllMocks();
  user = {
    id: 7,
    name: "Ana Pérez",
    email: "ana@planta.test",
    active: true,
    passwordHash: await bcrypt.hash("Anterior123", 4),
  };
  prisma.user.findUnique.mockImplementation(async ({ where }) =>
    where.id === user.id || where.email === user.email ? { ...user } : null
  );
  prisma.user.update.mockImplementation(async ({ data }) => {
    Object.assign(user, data);
    return user;
  });
});

describe("POST /api/auth/forgot-password", () => {
  it("responde igual exista o no el correo", async () => {
    const a = await post("/forgot-password", { email: "ana@planta.test" });
    const b = await post("/forgot-password", { email: "nadie@planta.test" });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body).toEqual(b.body);
  });

  it("envía el enlace solo a cuentas existentes y activas", async () => {
    await post("/forgot-password", { email: "ana@planta.test" });
    await new Promise((r) => setTimeout(r, 10));
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.to).toEqual(["ana@planta.test"]);
    expect(mail.html).toContain("https://app.ejemplo.test/reset-password#token=");

    sendEmail.mockClear();
    user.active = false;
    await post("/forgot-password", { email: "ana@planta.test" });
    await new Promise((r) => setTimeout(r, 10));
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("POST /api/auth/reset-password", () => {
  it("cambia la contraseña con un token válido", async () => {
    const token = createResetToken(user);
    const res = await post("/reset-password", { token, password: "NuevaClave456" });
    expect(res.status).toBe(200);
    expect(await bcrypt.compare("NuevaClave456", user.passwordHash)).toBe(true);
  });

  it("el token deja de servir después de usarse", async () => {
    const token = createResetToken(user);
    await post("/reset-password", { token, password: "NuevaClave456" });
    const again = await post("/reset-password", { token, password: "OtraClave789" });
    expect(again.status).toBe(400);
    expect(await bcrypt.compare("NuevaClave456", user.passwordHash)).toBe(true);
  });

  it("rechaza tokens vencidos, alterados o de sesión", async () => {
    const expired = jwt.sign(
      { sub: "7", purpose: "password-reset" },
      `${SECRET}:password-reset:${user.passwordHash}`,
      { expiresIn: -10 }
    );
    const sessionToken = jwt.sign({ sub: 7 }, SECRET);
    for (const token of [expired, sessionToken, createResetToken(user) + "x"]) {
      expect((await post("/reset-password", { token, password: "NuevaClave456" })).status).toBe(400);
    }
  });

  it("el token de recuperación no sirve como sesión", () => {
    expect(() => jwt.verify(createResetToken(user), SECRET)).toThrow();
  });

  it("exige al menos 8 caracteres", async () => {
    const res = await post("/reset-password", { token: createResetToken(user), password: "corta" });
    expect(res.status).toBe(400);
  });

  it("check avisa si el enlace ya no sirve", async () => {
    expect((await post("/reset-password/check", { token: createResetToken(user) })).status).toBe(200);
    expect((await post("/reset-password/check", { token: "basura" })).status).toBe(400);
  });
});
