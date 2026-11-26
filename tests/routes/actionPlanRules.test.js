import { describe, it, expect } from "vitest";
import { parseActionInput, nextProgress, statusFor, canView, canWork, isOverdue } from "../../src/routes/actionPlanRules.js";

const admin = { id: 1, role: "ADMIN" };
const sup = { id: 7, role: "SUPERVISOR" };
const today = "2026-11-25";
const base = { title: "Revisar fugas de grasa", category: "lubrication", dueDate: "2026-12-01" };

describe("parseActionInput", () => {
  it("el admin asigna responsable y fecha", () => {
    const r = parseActionInput({ ...base, ownerUserId: 7 }, { user: admin, today });
    expect(r).toMatchObject({ title: "Revisar fugas de grasa", category: "LUBRICATION", ownerUserId: 7, priority: "MEDIUM" });
    expect(r.dueDate.toISOString()).toBe("2026-12-01T12:00:00.000Z");
  });
  it("el supervisor siempre queda como responsable de lo que crea", () => {
    expect(parseActionInput({ ...base, ownerUserId: 99 }, { user: sup, today }).ownerUserId).toBe(7);
  });
  it("validaciones claras", () => {
    expect(() => parseActionInput({ ...base, title: "x", ownerUserId: 7 }, { user: admin, today })).toThrow(/mínimo/);
    expect(() => parseActionInput({ ...base, category: "OTRA", ownerUserId: 7 }, { user: admin, today })).toThrow(/grupo/);
    expect(() => parseActionInput({ ...base, dueDate: "", ownerUserId: 7 }, { user: admin, today })).toThrow(/fecha de ejecución/);
    expect(() => parseActionInput({ ...base, dueDate: "2026-11-01", ownerUserId: 7 }, { user: admin, today })).toThrow(/anterior a hoy/);
    expect(() => parseActionInput(base, { user: admin, today })).toThrow(/responsable/);
  });
  it("al editar, el supervisor no cambia fecha ni responsable", () => {
    const existing = { id: 3, ownerUserId: 7 };
    expect(() => parseActionInput({ dueDate: "2026-12-20" }, { user: sup, existing, today })).toThrow(/administrador/);
    expect(() => parseActionInput({ ownerUserId: 2 }, { user: sup, existing, today })).toThrow(/administrador/);
    expect(parseActionInput({ description: "más detalle" }, { user: sup, existing, today })).toEqual({ description: "más detalle" });
    expect(parseActionInput({ dueDate: "2026-11-10" }, { user: admin, existing, today }).dueDate).toBeInstanceOf(Date);
  });
});

describe("avance", () => {
  it("solo sube para el supervisor; el admin puede corregir", () => {
    expect(nextProgress(30, 60)).toBe(60);
    expect(() => nextProgress(60, 40)).toThrow(/solo puede aumentar/);
    expect(nextProgress(60, 40, { admin: true })).toBe(40);
    expect(() => nextProgress(50, 50)).toThrow(/mismo/);
    expect(() => nextProgress(50, 120)).toThrow(/entre 0 y 100/);
  });
  it("estado según avance", () => {
    expect(statusFor(0)).toBe("OPEN");
    expect(statusFor(40)).toBe("IN_PROGRESS");
    expect(statusFor(100)).toBe("DONE");
    expect(statusFor(50, "CANCELLED")).toBe("CANCELLED");
  });
});

describe("permisos y vencimiento", () => {
  const item = { ownerUserId: 7, status: "IN_PROGRESS", dueDate: "2026-11-20T12:00:00.000Z" };
  it("supervisor solo lo suyo; admin todo", () => {
    expect(canView(sup, item)).toBe(true);
    expect(canView({ id: 8, role: "SUPERVISOR" }, item)).toBe(false);
    expect(canView(admin, item)).toBe(true);
    expect(canWork(sup, { ...item, status: "CANCELLED" })).toBe(false);
  });
  it("vencido si sigue abierto después de la fecha", () => {
    expect(isOverdue(item, today)).toBe(true);
    expect(isOverdue({ ...item, status: "DONE" }, today)).toBe(false);
    expect(isOverdue({ ...item, dueDate: "2026-11-25T12:00:00.000Z" }, today)).toBe(false);
  });
});
