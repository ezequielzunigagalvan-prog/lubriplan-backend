// Avisos de prospectos: formulario de demo y chatbot de la landing.
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const sendEmail = vi.fn();
vi.mock("../../src/services/email/email.service.js", () => ({ sendEmail: (...a) => sendEmail(...a) }));

const RECIPIENT = "destino-privado@ejemplo.test";
process.env.LEAD_EMAIL = RECIPIENT;

const { default: landingLeadsRoutes } = await import("../../src/routes/landingLeads.routes.js");
const { hasContactInfo, notifyChatLead } = await import("../../src/services/email/leadNotifier.js");

function makePrisma() {
  return {
    landingLead: {
      create: vi.fn(async () => ({ id: 1, createdAt: new Date() })),
      update: vi.fn(async () => ({})),
    },
  };
}

function makeApp(prisma) {
  const app = express();
  app.use(express.json());
  const noop = (_req, _res, next) => next();
  app.use("/api", landingLeadsRoutes({ prisma, auth: noop, requireRole: () => noop }));
  return app;
}

let ipCounter = 0;
const lead = (extra = {}) => ({
  nombre: "Ana <b>Pérez</b>",
  email: "ana@cliente.test",
  telefono: "55 1234 5678",
  empresa: "Planta Norte",
  ...extra,
});

describe("POST /api/landing/lead", () => {
  let prisma;
  beforeEach(() => {
    sendEmail.mockReset();
    sendEmail.mockResolvedValue({ ok: true });
    prisma = makePrisma();
  });

  it("envía el aviso a LEAD_EMAIL y no expone el destinatario en la respuesta", async () => {
    const res = await request(makeApp(prisma))
      .post("/api/landing/lead")
      .set("x-forwarded-for", `10.0.0.${++ipCounter}`)
      .send(lead());

    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain(RECIPIENT);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.to).toEqual([RECIPIENT]);
    expect(mail.replyTo).toBe("ana@cliente.test");
    // los datos del visitante se escapan dentro del HTML
    expect(mail.html).toContain("Ana &lt;b&gt;Pérez&lt;/b&gt;");
    expect(mail.html).not.toContain("<b>Pérez</b>");
    expect(prisma.landingLead.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { emailSent: true } });
  });

  it("no marca el aviso como enviado si el correo falla", async () => {
    sendEmail.mockResolvedValue({ ok: false, reason: "PROVIDER_ERROR" });
    const res = await request(makeApp(prisma))
      .post("/api/landing/lead")
      .set("x-forwarded-for", `10.0.0.${++ipCounter}`)
      .send(lead());
    expect(res.status).toBe(201);
    expect(prisma.landingLead.update).not.toHaveBeenCalled();
  });

  it("ignora a los bots que llenan el campo trampa", async () => {
    const res = await request(makeApp(prisma))
      .post("/api/landing/lead")
      .set("x-forwarded-for", `10.0.0.${++ipCounter}`)
      .send(lead({ website: "http://spam.test" }));
    expect(res.status).toBe(201);
    expect(prisma.landingLead.create).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("valida correo y teléfono", async () => {
    const app = makeApp(prisma);
    const ip = `10.0.0.${++ipCounter}`;
    expect((await request(app).post("/api/landing/lead").set("x-forwarded-for", ip).send(lead({ email: "x" }))).status).toBe(400);
    expect((await request(app).post("/api/landing/lead").set("x-forwarded-for", ip).send(lead({ telefono: "12" }))).status).toBe(400);
  });

  it("LubriPlan Card: acepta nombre, empresa y teléfono sin correo", async () => {
    const res = await request(makeApp(prisma))
      .post("/api/landing/lead")
      .set("x-forwarded-for", `10.0.0.${++ipCounter}`)
      .send({ nombre: "Luis", empresa: "Aceros MX", telefono: "8112345678", source: "card", origin: "chat" });
    expect(res.status).toBe(201);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.subject).toContain("Solicitud de información");
    expect(mail.html).toContain("No proporcionado");
    expect(mail.replyTo).toBeUndefined();
  });

  it("LubriPlan Card: exige el nombre de la empresa", async () => {
    const res = await request(makeApp(prisma))
      .post("/api/landing/lead")
      .set("x-forwarded-for", `10.0.0.${++ipCounter}`)
      .send({ nombre: "Luis", telefono: "8112345678", source: "card" });
    expect(res.status).toBe(400);
  });

  it("limita a 5 solicitudes por IP por hora", async () => {
    const app = makeApp(prisma);
    const ip = `10.0.0.${++ipCounter}`;
    for (let i = 0; i < 5; i++) {
      expect((await request(app).post("/api/landing/lead").set("x-forwarded-for", ip).send(lead())).status).toBe(201);
    }
    expect((await request(app).post("/api/landing/lead").set("x-forwarded-for", ip).send(lead())).status).toBe(429);
  });
});

describe("chatbot", () => {
  beforeEach(() => {
    sendEmail.mockReset();
    sendEmail.mockResolvedValue({ ok: true });
  });

  it("detecta correo o teléfono escrito en el chat", () => {
    expect(hasContactInfo("Soy Juan, mi correo es juan@empresa.mx")).toBe(true);
    expect(hasContactInfo("Mi cel es 55 1234 5678")).toBe(true);
    expect(hasContactInfo("Quiero una demo para 3 plantas")).toBe(false);
  });

  it("envía la conversación escapada a LEAD_EMAIL", async () => {
    await notifyChatLead({
      messages: [
        { role: "user", content: "<script>x</script> quiero demo" },
        { role: "assistant", content: "Claro" },
      ],
      ip: "1.1.1.1",
      source: "landing",
      keywords: ["demo"],
      reason: "interest",
    });
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.to).toEqual([RECIPIENT]);
    expect(mail.html).not.toContain("<script>");
  });
});
