// El chatbot de LubriPlan Card no debe dar precios y debe pedir nombre, empresa y teléfono.
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../../src/services/email/leadNotifier.js", () => ({
  notifyChatLead: vi.fn(async () => ({ ok: true })),
  hasContactInfo: () => false,
}));

const { default: landingChatRouter } = await import("../../src/ia/landingChatRouter.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api", landingChatRouter(null));
  return a;
}

async function ask(text) {
  const res = await request(app())
    .post("/api/landing/card/chat")
    .send({ messages: [{ role: "user", content: text }] });
  return res.body.reply;
}

describe("chatbot de LubriPlan Card", () => {
  it.each(["¿Cuál es el precio?", "Quiero una cotización", "¿Qué diferencia hay con LubriPlan?", "Quiero información"])(
    "no menciona precios: %s",
    async (q) => {
      const reply = await ask(q);
      expect(reply).not.toMatch(/\$\s?\d|MXN|\/mes/i);
    }
  );

  it("pide nombre, empresa y teléfono", async () => {
    const reply = await ask("¿Cuánto cuesta?");
    expect(reply).toMatch(/nombre/i);
    expect(reply).toMatch(/empresa/i);
    expect(reply).toMatch(/teléfono/i);
  });
});
