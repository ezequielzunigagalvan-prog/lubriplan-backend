// Módulo Técnicos: permisos, código automático, edición completa y borrado que libera asignaciones.
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const db = {
  technician: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  execution: { groupBy: vi.fn(), updateMany: vi.fn() },
  route: { groupBy: vi.fn(), updateMany: vi.fn() },
  preventiveOrder: { updateMany: vi.fn() },
  $transaction: vi.fn(async (fn) => fn(db)),
};
vi.mock("../../src/prisma.js", () => ({ default: db }));

const { default: techniciansRouter } = await import("../../src/routes/technicians.routes.js");

function app(role = "ADMIN") {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user = { id: 1, role };
    req.currentPlantId = 1;
    next();
  });
  a.use("/api/technicians", techniciansRouter);
  return a;
}

const tech = (over = {}) => ({
  id: 5,
  plantId: 1,
  name: "Miguel Cruz",
  code: "TEC-001",
  email: null,
  phone: null,
  specialty: "Lubricación",
  certifications: '["ISO 18436"]',
  status: "ACTIVO",
  deletedAt: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  db.technician.findFirst.mockResolvedValue(tech());
  db.technician.update.mockImplementation(async ({ data }) => ({ ...tech(), ...data }));
  db.technician.create.mockImplementation(async ({ data }) => ({ id: 9, ...data }));
  db.execution.groupBy.mockResolvedValue([]);
  db.route.groupBy.mockResolvedValue([]);
  db.route.updateMany.mockResolvedValue({ count: 2 });
  db.execution.updateMany.mockResolvedValue({ count: 3 });
  db.preventiveOrder.updateMany.mockResolvedValue({ count: 1 });
});

describe("permisos", () => {
  it("un técnico no puede crear, editar ni eliminar técnicos", async () => {
    const a = app("TECHNICIAN");
    expect((await request(a).post("/api/technicians").send({ name: "X", specialty: "Y" })).status).toBe(403);
    expect((await request(a).put("/api/technicians/5").send({ name: "X" })).status).toBe(403);
    expect((await request(a).patch("/api/technicians/5").send({ name: "X" })).status).toBe(403);
    expect((await request(a).delete("/api/technicians/5")).status).toBe(403);
    expect(db.technician.create).not.toHaveBeenCalled();
    expect(db.technician.update).not.toHaveBeenCalled();
  });

  it("un supervisor edita pero no elimina", async () => {
    const a = app("SUPERVISOR");
    expect((await request(a).put("/api/technicians/5").send({ name: "Nuevo" })).status).toBe(200);
    expect((await request(a).delete("/api/technicians/5")).status).toBe(403);
  });

  it("cualquier rol puede listar", async () => {
    db.technician.findMany.mockResolvedValue([]);
    expect((await request(app("TECHNICIAN")).get("/api/technicians")).status).toBe(200);
  });
});

describe("crear", () => {
  it("genera el siguiente código TEC-### libre de la planta", async () => {
    db.technician.findMany.mockResolvedValue([{ code: "TEC-001" }, { code: "TEC-007" }, { code: "TEC-ABC" }]);
    const res = await request(app()).post("/api/technicians").send({ name: "Ana", specialty: "Lubricación" });
    expect(res.status).toBe(201);
    expect(db.technician.create.mock.calls[0][0].data.code).toBe("TEC-008");
    expect(res.body.item.certifications).toEqual([]);
  });

  it("valida el correo", async () => {
    const res = await request(app()).post("/api/technicians").send({ name: "Ana", specialty: "L", email: "malo" });
    expect(res.status).toBe(400);
  });
});

describe("editar", () => {
  it("guarda correo, teléfono y certificaciones (antes se ignoraban)", async () => {
    const res = await request(app())
      .put("/api/technicians/5")
      .send({ email: "miguel@planta.mx", phone: "55 1234 5678", certifications: ["ICML MLT I"], status: "INACTIVO" });
    expect(res.status).toBe(200);
    const data = db.technician.update.mock.calls[0][0].data;
    expect(data.email).toBe("miguel@planta.mx");
    expect(data.phone).toBe("55 1234 5678");
    expect(data.certifications).toBe('["ICML MLT I"]');
    expect(data.status).toBe("Inactivo");
    expect(res.body.item.certifications).toEqual(["ICML MLT I"]);
  });

  it("no permite dejar el nombre vacío", async () => {
    expect((await request(app()).put("/api/technicians/5").send({ name: "  " })).status).toBe(400);
  });
});

describe("listar", () => {
  it("incluye carga de trabajo, acceso a la app y certificaciones como lista", async () => {
    db.technician.findMany.mockResolvedValue([
      { ...tech(), executions: [], user: { id: 3, active: true, conditionReports: [] } },
    ]);
    db.execution.groupBy
      .mockResolvedValueOnce([{ technicianId: 5, _count: { _all: 4 } }]) // pendientes
      .mockResolvedValueOnce([{ technicianId: 5, _count: { _all: 1 } }]) // vencidas
      .mockResolvedValueOnce([{ technicianId: 5, _count: { _all: 12 } }]); // completadas 30d
    db.route.groupBy.mockResolvedValue([{ technicianId: 5, _count: { _all: 6 } }]);

    const res = await request(app()).get("/api/technicians");
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      status: "Activo",
      hasAppAccess: true,
      certifications: ["ISO 18436"],
      stats: { pending: 4, overdue: 1, completed30d: 12, routes: 6 },
    });
    expect(res.body[0].user).toBeUndefined();
  });
});

describe("eliminar", () => {
  it("libera rutas, actividades pendientes y OLP sin iniciar antes del borrado lógico", async () => {
    const res = await request(app()).delete("/api/technicians/5");
    expect(res.status).toBe(200);
    expect(res.body.released).toEqual({ routes: 2, activities: 3, orders: 1 });
    expect(db.execution.updateMany.mock.calls[0][0].where.status).toEqual({ in: ["PENDING", "OVERDUE"] });
    expect(db.preventiveOrder.updateMany.mock.calls[0][0].where.status).toEqual({ in: ["DRAFT", "OPEN"] });
    expect(db.technician.update.mock.calls[0][0].data.deletedAt).toBeInstanceOf(Date);
  });
});
