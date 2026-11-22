import express from "express";
import { notifyDemoRequest } from "../services/email/leadNotifier.js";
import { logger } from "../config/logger.js";


const VALID_SOURCES = ["landing", "card"];
const VALID_STATUSES = ["NUEVO", "CONTACTADO", "CALIFICADO", "DESCARTADO"];

function extractIp(req) {
  const raw = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown";
  return String(Array.isArray(raw) ? raw[0] : raw).split(",")[0].trim();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

// Límite anti-spam: 5 solicitudes por IP por hora.
const LEAD_IP_LIMIT_PER_HOUR = 5;
const leadIpWindows = new Map();
function leadRateLimit(ip) {
  const now = Date.now();
  const entry = leadIpWindows.get(ip);
  if (!entry || now - entry.start > 3_600_000) {
    leadIpWindows.set(ip, { count: 1, start: now });
    return true;
  }
  if (entry.count >= LEAD_IP_LIMIT_PER_HOUR) return false;
  entry.count++;
  return true;
}

const clip = (v, max) => String(v || "").trim().slice(0, max);

export default function landingLeadsRoutes({ prisma, auth, requireRole }) {
  const router = express.Router();

  // POST /api/landing/lead — público, sin auth
  router.post("/landing/lead", async (req, res) => {
    try {
      const ip = extractIp(req);

      // Campo trampa invisible para bots: si viene lleno, respondemos "ok" sin guardar nada.
      if (String(req.body?.website || "").trim()) {
        return res.status(201).json({ ok: true });
      }
      if (!leadRateLimit(ip)) {
        return res.status(429).json({ error: "Demasiadas solicitudes. Intenta más tarde." });
      }

      const nombre = clip(req.body?.nombre, 120);
      const email = clip(req.body?.email, 160).toLowerCase();
      const telefono = clip(req.body?.telefono, 40);
      const empresa = clip(req.body?.empresa, 160) || null;
      const source = VALID_SOURCES.includes(req.body?.source) ? req.body.source : "landing";
      const origin = req.body?.origin === "chat" ? "chat" : "form";
      const sessionId = clip(req.body?.sessionId, 120) || null;

      // LubriPlan Card pide nombre, empresa y teléfono (correo opcional).
      // La landing principal pide nombre, correo y teléfono (empresa opcional).
      const isCard = source === "card";
      if (!nombre) return res.status(400).json({ error: "El nombre es obligatorio" });
      if (isCard && !empresa) return res.status(400).json({ error: "El nombre de la empresa es obligatorio" });
      if ((!isCard || email) && !isValidEmail(email)) return res.status(400).json({ error: "El correo no es válido" });
      if (telefono.replace(/\D/g, "").length < 7) return res.status(400).json({ error: "El teléfono no es válido" });

      const lead = await prisma.landingLead.create({
        data: { nombre, email, telefono, empresa, source, sessionId, status: "NUEVO", emailSent: false, ip },
        select: { id: true, createdAt: true },
      });

      // El destinatario vive solo en el servidor (LEAD_EMAIL); no se devuelve al navegador.
      const sent = await notifyDemoRequest({ nombre, email, telefono, empresa, source, ip, origin });
      if (sent?.ok) {
        await prisma.landingLead.update({ where: { id: lead.id }, data: { emailSent: true } });
      } else {
        logger.warn("[landingLeads] Lead guardado pero sin aviso por correo", { leadId: lead.id, reason: sent?.reason });
      }

      return res.status(201).json({ ok: true });
    } catch (e) {
      logger.error("[landingLeads] POST error:", e?.message);
      return res.status(500).json({ error: "Error registrando solicitud" });
    }
  });

  // GET /api/admin/landing-leads — ADMIN
  router.get("/admin/landing-leads", auth, requireRole(["ADMIN"]), async (req, res) => {
    try {
      const { source, status, page = "1", limit = "50" } = req.query;
      const take = Math.min(Number(limit) || 50, 200);
      const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

      const where = {};
      if (source && VALID_SOURCES.includes(source)) where.source = source;
      if (status && VALID_STATUSES.includes(status)) where.status = status;

      const [leads, total] = await Promise.all([
        prisma.landingLead.findMany({ where, orderBy: { createdAt: "desc" }, take, skip }),
        prisma.landingLead.count({ where }),
      ]);

      return res.json({ ok: true, leads, total, page: Number(page), limit: take });
    } catch (e) {
      logger.error("[landingLeads] GET error:", e?.message);
      return res.status(500).json({ error: "Error obteniendo leads" });
    }
  });

  // PATCH /api/admin/landing-leads/:id — ADMIN (cambiar status)
  router.patch("/admin/landing-leads/:id", auth, requireRole(["ADMIN"]), async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "ID inválido" });

      const data = {};
      if (req.body?.status) {
        if (!VALID_STATUSES.includes(req.body.status)) {
          return res.status(400).json({ error: `status inválido. Valores: ${VALID_STATUSES.join(", ")}` });
        }
        data.status = req.body.status;
      }

      const lead = await prisma.landingLead.update({
        where: { id },
        data,
        select: { id: true, nombre: true, email: true, status: true, source: true },
      });

      return res.json({ ok: true, lead });
    } catch (e) {
      logger.error("[landingLeads] PATCH error:", e?.message);
      return res.status(500).json({ error: "Error actualizando lead" });
    }
  });

  return router;
}
