// tests/schemas/schemas.test.js
import { describe, it, expect } from "vitest";
import {
  loginSchema,
  setPasswordSchema,
  createUserSchema,
  createConditionReportSchema,
  createPurchaseOrderSchema,
} from "../../src/schemas/index.js";

describe("loginSchema", () => {
  it("acepta credenciales válidas", () => {
    const r = loginSchema.safeParse({ email: "admin@test.com", password: "12345678" });
    expect(r.success).toBe(true);
    expect(r.data.email).toBe("admin@test.com");
  });

  it("rechaza email mal formado", () => {
    const r = loginSchema.safeParse({ email: "no-email", password: "pass" });
    expect(r.success).toBe(false);
  });

  it("normaliza email a minúsculas", () => {
    const r = loginSchema.safeParse({ email: "ADMIN@TEST.COM", password: "pass" });
    expect(r.data?.email).toBe("admin@test.com");
  });
});

describe("setPasswordSchema", () => {
  it("rechaza password menor a 8 chars", () => {
    const r = setPasswordSchema.safeParse({ email: "a@b.com", password: "1234567" });
    expect(r.success).toBe(false);
    const issues = r.error.issues ?? r.error.errors ?? [];
    expect(issues[0].message).toContain("8 caracteres");
  });

  it("acepta password de 8+ chars", () => {
    const r = setPasswordSchema.safeParse({ email: "a@b.com", password: "12345678" });
    expect(r.success).toBe(true);
  });
});

describe("createUserSchema", () => {
  it("rechaza role inválido", () => {
    const r = createUserSchema.safeParse({
      name: "Test", email: "t@t.com", password: "12345678", role: "SUPERADMIN"
    });
    expect(r.success).toBe(false);
  });

  it("acepta los 3 roles válidos", () => {
    for (const role of ["ADMIN", "SUPERVISOR", "TECHNICIAN"]) {
      const r = createUserSchema.safeParse({
        name: "Test", email: "t@t.com", password: "12345678", role,
      });
      expect(r.success).toBe(true);
    }
  });
});

describe("createConditionReportSchema", () => {
  it("acepta condiciones válidas", () => {
    for (const condition of ["BUENO", "REGULAR", "MALO", "CRITICO"]) {
      const r = createConditionReportSchema.safeParse({ equipmentId: 1, condition });
      expect(r.success).toBe(true);
    }
  });

  it("rechaza condición inventada", () => {
    const r = createConditionReportSchema.safeParse({ equipmentId: 1, condition: "EXCELENTE" });
    expect(r.success).toBe(false);
  });
});

describe("createPurchaseOrderSchema", () => {
  it("rechaza orden sin items", () => {
    const r = createPurchaseOrderSchema.safeParse({ title: "Orden", items: [] });
    expect(r.success).toBe(false);
  });

  it("acepta orden con un item válido", () => {
    const r = createPurchaseOrderSchema.safeParse({
      title: "Orden de lubricantes",
      items: [{ lubricantId: 1, quantity: 10 }],
    });
    expect(r.success).toBe(true);
  });
});
