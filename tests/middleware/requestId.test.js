// tests/middleware/requestId.test.js
import { describe, it, expect, vi } from "vitest";
import { requestId } from "../../src/middleware/requestId.js";

function makeReqRes(existingId = null) {
  const req = { headers: existingId ? { "x-request-id": existingId } : {} };
  const res = { set: vi.fn() };
  const next = vi.fn();
  return { req, res, next };
}

describe("requestId middleware", () => {
  it("genera un UUID si no viene x-request-id", () => {
    const { req, res, next } = makeReqRes();
    requestId(req, res, next);
    expect(req.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reutiliza el x-request-id del cliente si viene en el header", () => {
    const { req, res, next } = makeReqRes("my-custom-id-123");
    requestId(req, res, next);
    expect(req.id).toBe("my-custom-id-123");
  });

  it("adjunta x-request-id en la respuesta", () => {
    const { req, res, next } = makeReqRes();
    requestId(req, res, next);
    expect(res.set).toHaveBeenCalledWith("x-request-id", req.id);
  });

  it("llama next()", () => {
    const { req, res, next } = makeReqRes();
    requestId(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});
