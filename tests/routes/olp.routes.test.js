// Pruebas de las Órdenes de Lubricación Preventiva con una base de datos falsa en memoria.
import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import olpRoutes from "../../src/routes/olp.routes.js";
import { requireRole } from "../../src/middleware/requireRole.js";

function makeDb({ stock = 10, preventNegativeStock = true, routeOverrides = {} } = {}) {
  const state = {
    order: { id: 1, plantId: 1, equipmentId: 5, status: "OPEN", assignedTo: 7, scheduledDate: new Date(), completedAt: null },
    items: [
      { id: 11, preventiveOrderId: 1, routeId: 21, status: "PENDING", observations: null, photoUrl: null },
      { id: 12, preventiveOrderId: 1, routeId: 22, status: "PENDING", observations: null, photoUrl: null },
    ],
    routes: {
      21: { id: 21, plantId: 1, name: "Chumaceras", equipmentId: 5, lubricantId: 31, quantity: 50, unit: "ml", points: 4, frequencyDays: 7, frequencyType: "DAYS", weeklyDays: [], technicianId: null, ...routeOverrides },
      22: { id: 22, plantId: 1, name: "Reductor", equipmentId: 5, lubricantId: null, quantity: null, unit: "ml", points: 1, frequencyDays: 30, frequencyType: "DAYS", weeklyDays: [], technicianId: null },
    },
    lubricant: { id: 31, plantId: 1, name: "ISO VG 68", unit: "L", stock },
    executions: [],
    movements: [],
    routeUpdates: [],
  };

  const db = {
    state,
    preventiveOrder: {
      findFirst: async ({ where }) => (where.id === state.order.id && where.plantId === state.order.plantId ? { ...state.order } : null),
      update: async ({ data }) => {
        Object.assign(state.order, data);
        return { ...state.order, items: state.items };
      },
    },
    preventiveOrderItem: {
      findFirst: async ({ where }) => {
        const it = state.items.find((i) => i.id === where.id && i.preventiveOrderId === where.preventiveOrderId);
        return it ? { ...it } : null;
      },
      update: async ({ where, data }) => {
        const it = state.items.find((i) => i.id === where.id);
        Object.assign(it, data);
        return { ...it };
      },
      count: async ({ where }) => state.items.filter((i) => i.status === where.status).length,
    },
    route: {
      findFirst: async ({ where }) => {
        const r = state.routes[where.id];
        return r && r.plantId === where.plantId ? { ...r } : null;
      },
      updateMany: async (args) => {
        state.routeUpdates.push(args);
        return { count: 1 };
      },
    },
    lubricant: {
      findFirst: async ({ where }) => (where.id === state.lubricant.id ? { ...state.lubricant } : null),
      update: async ({ data }) => {
        state.lubricant.stock -= data.stock.decrement;
        return { stock: state.lubricant.stock };
      },
    },
    lubricantMovement: {
      create: async ({ data }) => {
        state.movements.push(data);
        return data;
      },
    },
    appSettings: { findUnique: async () => ({ preventNegativeStock }) },
    execution: {
      create: async ({ data }) => {
        const e = { id: 100 + state.executions.length, ...data };
        state.executions.push(e);
        return e;
      },
      findFirst: async () => null,
      updateMany: async () => ({ count: 1 }),
      deleteMany: async () => ({ count: 1 }),
    },
    $transaction: async (fn) => fn(db),
  };
  return db;
}

function makeApp(db, user = { id: 1, role: "TECHNICIAN", technicianId: 7 }) {
  const app = express();
  app.use(express.json());
  const auth = (req, _res, next) => {
    req.user = user;
    req.currentPlantId = 1;
    next();
  };
  app.use("/api/preventive-orders", olpRoutes({ prisma: db, auth, requireRole }));
  return app;
}

describe("OLP: completar punto", () => {
  let db;
  beforeEach(() => {
    db = makeDb();
  });

  it("descuenta cantidad × puntos convertida a la unidad del inventario", async () => {
    const res = await request(makeApp(db)).put("/api/preventive-orders/1/items/11").send({ status: "COMPLETED" });
    expect(res.status).toBe(200);
    // 50 ml × 4 puntos = 200 ml = 0.2 L
    expect(db.state.lubricant.stock).toBeCloseTo(9.8);
    expect(db.state.movements).toHaveLength(1);
    expect(db.state.movements[0].quantity).toBe(0.2);
    const done = db.state.executions.filter((e) => e.status === 'COMPLETED');
    const next = db.state.executions.filter((e) => e.status === 'PENDING');
    expect(done).toHaveLength(1);
    expect(done[0].usedConvertedQuantity).toBe(200);
    // la ruta se reprograma y se genera su siguiente actividad pendiente
    expect(db.state.routeUpdates).toHaveLength(1);
    expect(next).toHaveLength(1);
    expect(next[0].scheduledAt.getTime()).toBeGreaterThan(Date.now());
    expect(db.state.order.status).toBe("IN_PROGRESS");
  });

  it("completar dos veces el mismo punto no descuenta dos veces", async () => {
    const app = makeApp(db);
    await request(app).put("/api/preventive-orders/1/items/11").send({ status: "COMPLETED" });
    const res = await request(app).put("/api/preventive-orders/1/items/11").send({ status: "COMPLETED" });
    expect(res.status).toBe(200);
    expect(res.body.alreadyCompleted).toBe(true);
    expect(db.state.executions.filter((e) => e.status === 'COMPLETED')).toHaveLength(1);
    expect(db.state.movements).toHaveLength(1);
    expect(db.state.lubricant.stock).toBeCloseTo(9.8);
  });

  it("rechaza si no hay stock suficiente y preventNegativeStock está activo", async () => {
    db = makeDb({ stock: 0.1 });
    const res = await request(makeApp(db)).put("/api/preventive-orders/1/items/11").send({ status: "COMPLETED" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Stock insuficiente/);
    expect(db.state.executions).toHaveLength(0);
    expect(db.state.lubricant.stock).toBe(0.1);
  });

  it("permite stock negativo si la configuración lo permite", async () => {
    db = makeDb({ stock: 0.1, preventNegativeStock: false });
    const res = await request(makeApp(db)).put("/api/preventive-orders/1/items/11").send({ status: "COMPLETED" });
    expect(res.status).toBe(200);
    expect(db.state.lubricant.stock).toBeCloseTo(-0.1);
  });

  it("completa sin descontar y avisa cuando la unidad no es convertible", async () => {
    db = makeDb({ routeOverrides: { unit: "g" } });
    const res = await request(makeApp(db)).put("/api/preventive-orders/1/items/11").send({ status: "COMPLETED" });
    expect(res.status).toBe(200);
    expect(res.body.inventoryWarning).toMatch(/No se descontó inventario/);
    expect(db.state.movements).toHaveLength(0);
    expect(db.state.executions[0].inventoryDeductedAt).toBeNull();
  });

  it("un técnico no puede ejecutar una orden asignada a otro", async () => {
    const res = await request(makeApp(db, { id: 2, role: "TECHNICIAN", technicianId: 99 }))
      .put("/api/preventive-orders/1/items/11")
      .send({ status: "COMPLETED" });
    expect(res.status).toBe(403);
  });

  it("la orden se completa sola cuando no quedan puntos pendientes (omitidos cuentan)", async () => {
    const app = makeApp(db);
    await request(app).put("/api/preventive-orders/1/items/11").send({ status: "COMPLETED" });
    await request(app).put("/api/preventive-orders/1/items/12").send({ status: "SKIPPED" });
    expect(db.state.order.status).toBe("COMPLETED");
    expect(db.state.order.completedAt).toBeInstanceOf(Date);
  });
});

describe("OLP: cerrar orden", () => {
  it("no permite cerrar con puntos pendientes", async () => {
    const db = makeDb();
    const res = await request(makeApp(db)).put("/api/preventive-orders/1/complete").send({ signatureImage: "data:x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Faltan 2/);
  });

  it("guarda la firma al cerrar", async () => {
    const db = makeDb();
    db.state.items.forEach((i) => (i.status = "COMPLETED"));
    const res = await request(makeApp(db)).put("/api/preventive-orders/1/complete").send({ signatureImage: "data:firma" });
    expect(res.status).toBe(200);
    expect(db.state.order.signatureImage).toBe("data:firma");
    expect(db.state.order.status).toBe("COMPLETED");
  });
});
