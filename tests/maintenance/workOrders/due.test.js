import { describe, it, expect } from "vitest";
import { effectiveDueAt, isOverdue, daysOverdue, slaDueAt, CORRECTIVE_SLA_DAYS } from "../../../src/modules/maintenance/workOrders/due.js";

const DAY = 24 * 60 * 60 * 1000;

describe("workOrders/due", () => {
  it("SLA de correctivas por prioridad", () => {
    const from = new Date("2026-11-16T19:35:00Z");
    expect(slaDueAt("CRITICAL", from).getTime() - from.getTime()).toBe(CORRECTIVE_SLA_DAYS.CRITICAL * DAY);
    expect(slaDueAt("LOW", from).getTime() - from.getTime()).toBe(14 * DAY);
    expect(slaDueAt("UNKNOWN", from).getTime() - from.getTime()).toBe(7 * DAY);
  });

  it("usa dueAt, luego scheduledAt, luego el SLA (solo correctivas)", () => {
    const createdAt = new Date("2026-11-16T19:35:00Z");
    expect(effectiveDueAt({ dueAt: "2026-11-20T06:00:00Z", scheduledAt: "2026-11-18T06:00:00Z" }).toISOString()).toBe("2026-11-20T06:00:00.000Z");
    expect(effectiveDueAt({ scheduledAt: "2026-11-18T06:00:00Z" }).toISOString()).toBe("2026-11-18T06:00:00.000Z");
    expect(effectiveDueAt({ type: "CORRECTIVE", priority: "HIGH", createdAt }).getTime()).toBe(createdAt.getTime() + 3 * DAY);
    expect(effectiveDueAt({ type: "PREVENTIVE", priority: "HIGH", createdAt })).toBeNull();
  });

  it("correctiva crítica sin fecha se atrasa a las 24 h", () => {
    const wo = { type: "CORRECTIVE", priority: "CRITICAL", status: "REQUESTED", createdAt: new Date("2026-11-16T19:35:00Z") };
    expect(isOverdue(wo, new Date("2026-11-17T19:00:00Z"))).toBe(false);
    expect(isOverdue(wo, new Date("2026-11-17T20:00:00Z"))).toBe(true);
    expect(daysOverdue(wo, new Date("2026-11-19T20:00:00Z"))).toBe(3);
  });

  it("una preventiva con fecha del día no está atrasada hasta que termina ese día", () => {
    const wo = { type: "PREVENTIVE", priority: "MEDIUM", status: "APPROVED", dueAt: new Date("2026-11-19T06:00:00Z") };
    expect(isOverdue(wo, new Date("2026-11-19T20:00:00Z"))).toBe(false);
    expect(isOverdue(wo, new Date("2026-11-21T12:00:00Z"))).toBe(true);
  });

  it("las cerradas nunca están atrasadas", () => {
    for (const status of ["FINISHED", "VALIDATED", "REJECTED", "CANCELLED"]) {
      expect(isOverdue({ type: "CORRECTIVE", priority: "CRITICAL", status, createdAt: new Date("2020-01-01") })).toBe(false);
    }
  });
});
