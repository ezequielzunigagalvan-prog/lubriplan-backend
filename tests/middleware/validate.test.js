// tests/middleware/validate.test.js
import { describe, it, expect, vi } from "vitest";
import { validate } from "../../src/middleware/validate.js";
import { z } from "zod";

const schema = z.object({
  email: z.string().email(),
  age:   z.number({ coerce: true }).int().positive(),
});

function makeReqRes(body = {}) {
  const req = { body };
  const res = {
    status: vi.fn().mockReturnThis(),
    json:   vi.fn().mockReturnThis(),
  };
  const next = vi.fn();
  return { req, res, next };
}

describe("validate middleware", () => {
  it("llama next() con body válido", () => {
    const { req, res, next } = makeReqRes({ email: "test@example.com", age: "25" });
    validate(schema)(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.body.age).toBe(25); // coerced
  });

  it("retorna 400 con email inválido", () => {
    const { req, res, next } = makeReqRes({ email: "no-es-email", age: 25 });
    validate(schema)(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: "Datos inválidos" }));
    expect(next).not.toHaveBeenCalled();
  });

  it("incluye el campo con error en la respuesta", () => {
    const { req, res, next } = makeReqRes({ email: "bad", age: -1 });
    validate(schema)(req, res, next);
    const call = res.json.mock.calls[0][0];
    expect(call.errors).toBeInstanceOf(Array);
    expect(call.errors.some(e => e.field === "email")).toBe(true);
  });

  it("retorna 400 si el body está vacío", () => {
    const { req, res, next } = makeReqRes({});
    validate(schema)(req, res, next);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
