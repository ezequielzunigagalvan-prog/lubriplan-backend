// src/services/auth/passwordReset.js
// Recuperación de contraseña sin tablas nuevas.
//
// El token es un JWT firmado con JWT_SECRET + el hash de contraseña actual del usuario:
//  - vence en RESET_TTL_MIN minutos;
//  - deja de servir en cuanto la contraseña cambia (el hash ya no coincide), así que es de un solo uso;
//  - no sirve para iniciar sesión: requireAuth verifica solo con JWT_SECRET y la firma no coincide.

import jwt from "jsonwebtoken";
import { sendEmail } from "../email/email.service.js";
import { escapeHtml } from "../email/email.utils.js";

export const RESET_TTL_MIN = 30;
const PURPOSE = "password-reset";

function secretFor(user) {
  return `${process.env.JWT_SECRET}:${PURPOSE}:${user.passwordHash || ""}`;
}

export const INVITE_TTL_HOURS = 72;

/** invite: enlace de bienvenida para que un usuario nuevo defina su contraseña (dura más). */
export function createResetToken(user, { invite = false } = {}) {
  return jwt.sign({ sub: String(user.id), purpose: PURPOSE }, secretFor(user), {
    expiresIn: invite ? `${INVITE_TTL_HOURS}h` : `${RESET_TTL_MIN}m`,
  });
}

/**
 * Devuelve el usuario si el token es válido; si no, null.
 * Solo usuarios activos.
 */
export async function verifyResetToken(prisma, token) {
  const decoded = jwt.decode(String(token || ""));
  const userId = Number(decoded?.sub);
  if (!Number.isInteger(userId) || decoded?.purpose !== PURPOSE) return null;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, active: true, passwordHash: true },
  });
  if (!user || user.active === false) return null;

  try {
    const payload = jwt.verify(String(token), secretFor(user));
    return payload?.purpose === PURPOSE ? user : null;
  } catch {
    return null;
  }
}

export function resetLink(token) {
  const base = String(process.env.APP_BASE_URL || "http://localhost:5173").replace(/\/$/, "");
  // En el fragmento (#) para que el token no quede en logs de servidores ni proxies.
  return `${base}/reset-password#token=${encodeURIComponent(token)}`;
}

export async function sendResetEmail(user, token, { invite = false } = {}) {
  const link = resetLink(token);
  const name = escapeHtml(String(user.name || "").split(" ")[0] || "");
  const html = `
  <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;background:#f4f5f7;padding:24px;">
    <div style="background:#0a0c0f;border-radius:12px;padding:20px 24px;border-top:4px solid #f97316;">
      <div style="font-size:20px;font-weight:800;color:#f97316;">LubriPlan</div>
      <div style="font-size:13px;color:#9aa4b2;margin-top:4px;">${invite ? "Bienvenido a LubriPlan" : "Recuperación de contraseña"}</div>
    </div>
    <div style="background:#fff;border-radius:12px;padding:24px;margin-top:16px;border:1px solid #e2e8f0;color:#0f172a;font-size:15px;line-height:1.6;">
      <p style="margin:0 0 12px;">Hola${name ? ` ${name}` : ""},</p>
      <p style="margin:0 0 20px;">${invite ? `Se creó tu cuenta de LubriPlan con el correo ${escapeHtml(user.email || "")}. Usa el botón para crear tu contraseña y entrar:` : "Recibimos una solicitud para restablecer la contraseña de tu cuenta de LubriPlan. Usa el botón para crear una nueva:"}</p>
      <p style="margin:0 0 20px;text-align:center;">
        <a href="${escapeHtml(link)}" style="display:inline-block;background:#f97316;color:#0a0c0f;text-decoration:none;font-weight:700;padding:13px 26px;border-radius:8px;">Crear nueva contraseña</a>
      </p>
      <p style="margin:0 0 8px;font-size:13px;color:#64748b;">El enlace vence en ${invite ? `${INVITE_TTL_HOURS} horas` : `${RESET_TTL_MIN} minutos`} y solo se puede usar una vez.</p>
      <p style="margin:0;font-size:13px;color:#64748b;">${invite ? "Si no esperabas este correo, ignóralo." : "Si tú no lo pediste, ignora este correo: tu contraseña no cambiará."}</p>
    </div>
    <div style="font-size:11px;color:#94a3b8;text-align:center;margin-top:14px;word-break:break-all;">
      Si el botón no funciona, copia este enlace en tu navegador:<br>${escapeHtml(link)}
    </div>
  </div>`;

  return sendEmail({ to: [user.email], subject: invite ? "Tu cuenta de LubriPlan está lista" : "Restablece tu contraseña de LubriPlan", html });
}
