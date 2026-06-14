/**
 * Middleware para validar transiciones de estado en Execution
 * Previene cambios de estado inválidos
 */

import { validateStateTransition, canTechnicianTransitionTo } from "../services/executionStateMachine.js";
import { logger } from "../config/logger.js";

/**
 * Valida que la transición de estado sea permitida
 * Se ejecuta después de tener el execution actual y el nuevo estado deseado
 *
 * Uso: Call this after loading currentExecution
 * validateStateChangeAllowed(req, res, currentExecution, newStatus)
 */
export function validateStateChangeAllowed(req, res, currentExecution, newStatus) {
  if (!currentExecution || !newStatus) {
    logger.warn("[STATE MACHINE] Validación incompleta de estado");
    return true; // No bloquear si faltan datos
  }

  const currentStatus = String(currentExecution.status || "").toUpperCase();
  const targetStatus = String(newStatus || "").toUpperCase();

  const { valid, isIdempotent, reason } = validateStateTransition(currentStatus, targetStatus);

  if (!valid) {
    logger.warn(`[STATE MACHINE] Transición inválida: ${currentStatus} → ${targetStatus}. Razón: ${reason}`);
    return false;
  }

  // Para técnicos, validaciones adicionales
  if (req.user?.role === "TECHNICIAN") {
    const { allowed, reason: techReason } = canTechnicianTransitionTo(currentStatus, targetStatus);
    if (!allowed) {
      logger.warn(`[STATE MACHINE] Técnico intenta transición no permitida: ${currentStatus} → ${targetStatus}. ${techReason}`);
      return false;
    }
  }

  if (isIdempotent) {
    logger.debug(`[STATE MACHINE] Reintento idempotente: ${currentStatus} → ${targetStatus}`);
  } else {
    logger.info(`[STATE MACHINE] Transición válida: ${currentStatus} → ${targetStatus} por ${req.user?.email}`);
  }

  return true;
}

/**
 * Middleware express que valida un cambio de estado pendiente en el body
 * Uso: app.put("/api/executions/:id/complete", validateExecutionStateTransitionMiddleware, handler)
 */
export function validateExecutionStateTransitionMiddleware(req, res, next) {
  // Este middleware es informativo — el handler debe cargar currentExecution
  // y llamar a validateStateChangeAllowed()
  // No bloqueamos aquí porque necesitamos el execution del BD
  next();
}
