// src/routes/actionPlanRules.js
// Reglas del Plan de acción (funciones puras, probadas en tests/routes/actionPlanRules.test.js).
//
// Permisos:
//  - ADMIN ve todos los pendientes de la planta, crea, asigna responsable y fecha, y puede corregir el avance.
//  - SUPERVISOR solo ve sus pendientes (donde es responsable). Puede crear pendientes para sí mismo,
//    registrar avances (solo hacia arriba), comentar y subir evidencia.

export const CATEGORIES = ["LUBRICATION", "SAFETY", "PREDICTIVE", "AUDIT"];
export const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export class ActionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export const isAdmin = (user) => String(user?.role || "").toUpperCase() === "ADMIN";

export function canView(user, item) {
  return isAdmin(user) || item?.ownerUserId === user?.id;
}

export function canWork(user, item) {
  if (!item || item.status === "CANCELLED") return false;
  return canView(user, item);
}

/** Estado según el avance (CANCELLED se conserva). */
export function statusFor(progress, current = "OPEN") {
  if (current === "CANCELLED") return "CANCELLED";
  if (progress >= 100) return "DONE";
  if (progress > 0) return "IN_PROGRESS";
  return "OPEN";
}

/** Valida un nuevo avance. El supervisor solo puede avanzar; el admin puede corregir hacia abajo. */
export function nextProgress(current, wanted, { admin = false } = {}) {
  const n = Number(wanted);
  if (!Number.isInteger(n) || n < 0 || n > 100) throw new ActionError("El avance debe ser un número entero entre 0 y 100");
  if (n === current) throw new ActionError("El avance es el mismo que ya tiene");
  if (n < current && !admin) throw new ActionError("El avance solo puede aumentar; pide a un administrador corregirlo");
  return n;
}

/** Fecha "YYYY-MM-DD" → 12:00 UTC de ese día (mismo criterio que rutas y actividades). */
export function dueDateOf(value) {
  const s = String(value || "").slice(0, 10);
  if (!YMD.test(s)) return null;
  const d = new Date(`${s}T12:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Datos de alta/edición. Devuelve solo los campos que el usuario puede cambiar.
 * { user, existing, today: "YYYY-MM-DD" }
 */
export function parseActionInput(body = {}, { user, existing = null, today } = {}) {
  const admin = isAdmin(user);
  const out = {};
  const errors = [];
  const has = (k) => body[k] !== undefined;

  if (!existing || has("title")) {
    const title = String(body.title || "").trim();
    if (title.length < 3) errors.push("Escribe el pendiente (mínimo 3 caracteres)");
    else out.title = title.slice(0, 160);
  }
  if (!existing || has("category")) {
    const c = String(body.category || "").toUpperCase();
    if (!CATEGORIES.includes(c)) errors.push("Elige el grupo: Lubricación, Seguridad, Predictivos o Auditoría");
    else out.category = c;
  }
  if (has("description")) out.description = String(body.description || "").trim().slice(0, 2000) || null;
  if (!existing || has("priority")) {
    const pr = String(body.priority || "MEDIUM").toUpperCase();
    if (!PRIORITIES.includes(pr)) errors.push("Prioridad no válida");
    else out.priority = pr;
  }
  if (has("equipmentId")) {
    const e = body.equipmentId === null || body.equipmentId === "" ? null : Number(body.equipmentId);
    if (e !== null && !(Number.isInteger(e) && e > 0)) errors.push("Equipo no válido");
    else out.equipmentId = e;
  }

  // Fecha de ejecución: obligatoria al crear; al editar, solo el admin la cambia.
  if (!existing || has("dueDate")) {
    if (existing && !admin) {
      errors.push("Solo un administrador puede cambiar la fecha de ejecución");
    } else {
      const d = dueDateOf(body.dueDate);
      if (!d) errors.push("Indica la fecha de ejecución");
      else if (!existing && today && String(body.dueDate).slice(0, 10) < today) errors.push("La fecha de ejecución no puede ser anterior a hoy");
      else out.dueDate = d;
    }
  }

  // Responsable: el admin lo asigna; el supervisor siempre es responsable de lo que crea.
  if (!existing) {
    if (admin) {
      const o = Number(body.ownerUserId);
      if (!(Number.isInteger(o) && o > 0)) errors.push("Elige el responsable");
      else out.ownerUserId = o;
    } else {
      out.ownerUserId = user.id;
    }
  } else if (has("ownerUserId")) {
    if (!admin) errors.push("Solo un administrador puede cambiar al responsable");
    else {
      const o = Number(body.ownerUserId);
      if (!(Number.isInteger(o) && o > 0)) errors.push("Responsable no válido");
      else out.ownerUserId = o;
    }
  }

  if (errors.length) throw new ActionError(errors.join(". "));
  return out;
}

/** ¿Está vencido? (abierto y con fecha de ejecución anterior a hoy en la planta). */
export function isOverdue(item, today) {
  if (!item || ["DONE", "CANCELLED"].includes(item.status)) return false;
  return String(new Date(item.dueDate).toISOString()).slice(0, 10) < today;
}
