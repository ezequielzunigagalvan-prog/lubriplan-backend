import express from "express";
import { Resend } from "resend";

const LEAD_EMAIL = process.env.LEAD_EMAIL || "lubriplan@hidrolub.com";
const EMAIL_FROM = process.env.EMAIL_FROM || "LubriPlan <onboarding@resend.dev>";

const VALID_SOURCES = ["landing", "card"];
const VALID_STATUSES = ["NUEVO", "CONTACTADO", "CALIFICADO", "DESCARTADO"];

function extractIp(req) {
  const raw = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown";
  return String(Array.isArray(raw) ? raw[0] : raw).split(",")[0].trim();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

async function sendLeadEmail({ nombre, email, telefono, empresa, source, ip }) {
  try {
    const apiKey = String(process.env.RESEND_API_KEY || "").trim();
    if (!apiKey) return;

    const resend = new Resend(apiKey);
    const sourceLabel = source === "card" ? "LubriPlan Card" : "LubriPlan";

    await resend.emails.send({
      from: EMAIL_FROM,
      to: [LEAD_EMAIL],
      subject: `📋 Nuevo lead — ${nombre} solicita demo de ${sourceLabel}`,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:580px;margin:0 auto;background:#f8fafc;padding:24px;">
          <div style="background:#0f172a;border-radius:16px;padding:20px 24px;margin-bottom:20px;">
            <div style="font-size:22px;font-weight:900;color:#f97316;letter-spacing:-0.5px;">${sourceLabel}</div>
            <div style="font-size:13px;color:#94a3b8;margin-top:4px;">Nuevo prospecto solicita demo</div>
          </div>

          <div style="background:#fff;border-radius:12px;padding:20px 24px;border:1px solid #e2e8f0;margin-bottom:16px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr>
                <td style="padding:8px 0;font-size:12px;font-weight:700;color:#94a3b8;width:110px;text-transform:uppercase;letter-spacing:.5px;">Nombre</td>
                <td style="padding:8px 0;font-size:14px;color:#0f172a;font-weight:600;">${nombre}</td>
              </tr>
              <tr style="border-top:1px solid #f1f5f9;">
                <td style="padding:8px 0;font-size:12px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;">Correo</td>
                <td style="padding:8px 0;font-size:14px;"><a href="mailto:${email}" style="color:#f97316;text-decoration:none;">${email}</a></td>
              </tr>
              <tr style="border-top:1px solid #f1f5f9;">
                <td style="padding:8px 0;font-size:12px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;">Teléfono</td>
                <td style="padding:8px 0;font-size:14px;color:#0f172a;">${telefono}</td>
              </tr>
              ${empresa ? `
              <tr style="border-top:1px solid #f1f5f9;">
                <td style="padding:8px 0;font-size:12px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;">Empresa</td>
                <td style="padding:8px 0;font-size:14px;color:#0f172a;">${empresa}</td>
              </tr>` : ""}
              <tr style="border-top:1px solid #f1f5f9;">
                <td style="padding:8px 0;font-size:12px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;">Producto</td>
                <td style="padding:8px 0;"><span style="background:#fff7ed;color:#c2410c;border:1px solid #fed7aa;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;">${sourceLabel}</span></td>
              </tr>
            </table>
          </div>

          <div style="font-size:11px;color:#94a3b8;text-align:center;">
            IP: ${ip} · ${new Date().toLocaleString("es-MX", { timeZone: "America/Mexico_City" })}
          </div>
        </div>
      `,
    });
  } catch (e) {
    console.error("[landingLeads] Error enviando email:", e?.message);
  }
}

export default function landingLeadsRoutes({ prisma, auth, requireRole }) {
  const router = express.Router();

  // POST /api/landing/lead — público, sin auth
  router.post("/landing/lead", async (req, res) => {
    try {
      const nombre = String(req.body?.nombre || "").trim();
      const email = String(req.body?.email || "").trim().toLowerCase();
      const telefono = String(req.body?.telefono || "").trim();
      const empresa = String(req.body?.empresa || "").trim() || null;
      const source = VALID_SOURCES.includes(req.body?.source) ? req.body.source : "landing";
      const sessionId = String(req.body?.sessionId || "").trim() || null;
      const ip = extractIp(req);

      if (!nombre) return res.status(400).json({ error: "nombre es obligatorio" });
      if (!email || !isValidEmail(email)) return res.status(400).json({ error: "email inválido" });
      if (!telefono || telefono.length < 7) return res.status(400).json({ error: "teléfono inválido" });

      const lead = await prisma.landingLead.create({
        data: { nombre, email, telefono, empresa, source, sessionId, status: "NUEVO", emailSent: false, ip },
        select: { id: true, nombre: true, email: true, source: true, createdAt: true },
      });

      await sendLeadEmail({ nombre, email, telefono, empresa, source, ip });
      await prisma.landingLead.update({ where: { id: lead.id }, data: { emailSent: true } });

      return res.status(201).json({ ok: true, lead });
    } catch (e) {
      console.error("[landingLeads] POST error:", e?.message);
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
      console.error("[landingLeads] GET error:", e?.message);
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
      console.error("[landingLeads] PATCH error:", e?.message);
      return res.status(500).json({ error: "Error actualizando lead" });
    }
  });

  return router;
}
