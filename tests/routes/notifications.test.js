import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/realtime/sseHub.js", () => {
  const hub = { send: vi.fn(), broadcast: vi.fn(), add: vi.fn(), remove: vi.fn() };
  return { sseHub: hub, default: hub };
});
vi.mock("../../src/services/webhooks.service.js", () => ({ fireWebhookEvent: vi.fn() }));

const { notificationScope, parseTypes } = await import("../../src/routes/notifications.routes.js");
const { notifyTechnicianAssignee, notifyManagers, notifyConditionReporter } = await import("../../src/notifications/notify.js");
const { runOverdueReminders, technicianMessage, managerMessage } = await import("../../src/jobs/overdueReminder.job.js");

function fakePrisma(overrides = {}) {
  const created = [];
  return {
    created,
    notification: {
      create: vi.fn(async ({ data }) => {
        const row = { id: created.length + 1, createdAt: new Date(), ...data };
        created.push(row);
        return row;
      }),
      findFirst: vi.fn(async () => null),
    },
    user: {
      findFirst: vi.fn(async () => ({ id: 50 })),
      findMany: vi.fn(async () => []),
    },
    ...overrides,
  };
}

describe("notificationScope / parseTypes", () => {
  it("cada usuario solo ve las suyas de la planta activa", () => {
    expect(notificationScope(7, 3)).toEqual({ userId: 7, OR: [{ plantId: 3 }, { plantId: null }] });
    expect(notificationScope(7, null)).toEqual({ userId: 7 });
  });
  it("solo acepta tipos válidos", () => {
    expect(parseTypes("low_stock, EXEC_OVERDUE,HACK")).toEqual(["LOW_STOCK", "EXEC_OVERDUE"]);
    expect(parseTypes("")).toBeNull();
  });
});

describe("notifyTechnicianAssignee", () => {
  it("notifica al usuario del técnico en la planta", async () => {
    const prisma = fakePrisma();
    const r = await notifyTechnicianAssignee(prisma, { plantId: 1, technicianId: 4, type: "EXEC_ASSIGNED", title: "Ruta asignada" });
    expect(r.notified).toBe(1);
    expect(prisma.created[0]).toMatchObject({ userId: 50, plantId: 1, type: "EXEC_ASSIGNED" });
  });
  it("no se notifica a sí mismo quien asigna", async () => {
    const prisma = fakePrisma();
    const r = await notifyTechnicianAssignee(prisma, { plantId: 1, technicianId: 4, actorUserId: 50, type: "EXEC_ASSIGNED", title: "x" });
    expect(r.notified).toBe(0);
    expect(prisma.created).toHaveLength(0);
  });
});

describe("notifyManagers", () => {
  it("solo supervisores/admins de la planta y excluye a quien hizo la acción", async () => {
    const prisma = fakePrisma();
    prisma.user.findMany = vi.fn(async () => [{ id: 1 }, { id: 2 }, { id: 3 }]);
    const r = await notifyManagers(prisma, { plantId: 9, excludeUserId: 2, type: "LOW_STOCK", title: "Stock bajo" });
    const where = prisma.user.findMany.mock.calls[0][0].where;
    expect(where.role).toEqual({ in: ["ADMIN", "SUPERVISOR"] });
    expect(where.userPlants).toEqual({ some: { plantId: 9, active: true } });
    expect(r.notified).toBe(2);
    expect(prisma.created.map((n) => n.userId)).toEqual([1, 3]);
  });
});

describe("notifyConditionReporter", () => {
  it("avisa a quien reportó, salvo que sea quien resolvió", async () => {
    const prisma = fakePrisma();
    expect((await notifyConditionReporter(prisma, { plantId: 1, reportedById: 50, type: "CONDITION_RESOLVED", title: "ok" })).notified).toBe(1);
    expect((await notifyConditionReporter(prisma, { plantId: 1, reportedById: 50, actorUserId: 50, type: "CONDITION_RESOLVED", title: "ok" })).notified).toBe(0);
  });
});

describe("overdueReminder", () => {
  it("mensajes", () => {
    expect(technicianMessage({ overdue: 1, today: 2 })).toMatch(/^1 actividad vencida · 2 para hoy/);
    expect(managerMessage({ overdue: 5, critical: 2, unassigned: 1 })).toBe("5 actividades vencidas · 2 en equipos críticos · 1 sin técnico");
  });

  const basePrisma = () => {
    const prisma = fakePrisma();
    prisma.plant = { findMany: vi.fn(async () => [{ id: 1, name: "Planta Norte", timezone: "America/Mexico_City" }]) };
    prisma.execution = {
      groupBy: vi.fn(async ({ where }) =>
        where.scheduledAt.lt ? [{ technicianId: 4, _count: { _all: 3 } }, { technicianId: null, _count: { _all: 1 } }] : []
      ),
      count: vi.fn(async ({ where }) => (where.technicianId === null ? 1 : 2)),
    };
    prisma.user.findMany = vi.fn(async ({ where }) =>
      where.role === "TECHNICIAN" ? [{ id: 40, technicianId: 4 }] : [{ id: 1 }]
    );
    return prisma;
  };

  it("técnico recibe sus vencidas y el supervisor el total de planta", async () => {
    const prisma = basePrisma();
    const now = new Date("2026-11-23T15:00:00Z"); // 9:00 en CDMX
    const r = await runOverdueReminders({ prisma, now, hour: 7 });
    expect(r[0]).toMatchObject({ plantId: 1, totalOverdue: 4, sent: 2 });
    const [tech, mgr] = prisma.created;
    expect(tech).toMatchObject({ userId: 40, plantId: 1, type: "EXEC_OVERDUE", title: "Tienes 3 actividades vencidas" });
    expect(mgr).toMatchObject({ userId: 1, title: "Actividades vencidas en Planta Norte" });
    expect(mgr.message).toBe("4 actividades vencidas · 2 en equipos críticos · 1 sin técnico");
    // el día en hora de México empieza a las 06:00 UTC
    expect(prisma.execution.groupBy.mock.calls[0][0].where.scheduledAt.lt.toISOString()).toBe("2026-11-23T06:00:00.000Z");
  });

  it("no envía antes de la hora ni dos veces el mismo día", async () => {
    const prisma = basePrisma();
    expect((await runOverdueReminders({ prisma, now: new Date("2026-11-23T11:00:00Z"), hour: 7 }))[0].skipped).toBe("BEFORE_WINDOW");
    prisma.notification.findFirst = vi.fn(async () => ({ id: 99 }));
    const r = await runOverdueReminders({ prisma, now: new Date("2026-11-23T15:00:00Z"), hour: 7 });
    expect(r[0].sent).toBe(0);
  });
});
