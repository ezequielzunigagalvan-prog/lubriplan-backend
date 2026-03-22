// src/routes/realtime.routes.js
import express from "express";
import sseHub from "../realtime/sseHub.js";

function realtimeRoutes({ auth }) {
  const router = express.Router();

  // Middleware: permite token por query SOLO para SSE
  // Reusa tu auth actual metiendo el Authorization header artificialmente.
  function authSSE(req, res, next) {
    try {
      const qToken = req.query?.token;
      const hasBearer = String(req.headers.authorization || "").startsWith("Bearer ");

      if (!hasBearer && qToken) {
        req.headers.authorization = `Bearer ${qToken}`;
      }

      return auth(req, res, next);
    } catch (e) {
      console.error("authSSE error:", e);
      return res.status(401).json({ error: "Token inválido" });
    }
  }

  router.get("/realtime/stream", authSSE, (req, res) => {
    const userId = req.user?.id;
    if (!userId) return res.sendStatus(401);

    // ✅ CORS explícito para SSE (evita “No Access-Control-Allow-Origin”)
    const origin = req.headers.origin || "http://localhost:5173";
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");

    // SSE headers
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    // Primer mensaje
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);

    // Registrar cliente
    sseHub.add(userId, res);

    // keep-alive para que no muera en proxies
    const ping = setInterval(() => {
      res.write(`event: ping\ndata: {}\n\n`);
    }, 25000);

    req.on("close", () => {
      clearInterval(ping);
      sseHub.remove(userId, res);
      res.end();
    });
  });

  return router;
}

export default realtimeRoutes;