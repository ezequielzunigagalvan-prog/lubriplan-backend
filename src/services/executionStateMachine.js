/**
 * Estado Machine para Execution
 * Define transiciones válidas entre estados de Ejecución
 */

const STATES = {
  PENDING: "PENDING",
  OVERDUE: "OVERDUE",
  IN_PROGRESS: "IN_PROGRESS",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
};

/**
 * Define qué transiciones de estado son válidas
 * Si no está en la lista, la transición es inválida
 */
const VALID_TRANSITIONS = {
  [STATES.PENDING]: [
    STATES.OVERDUE,      // Automático por scheduler si pasó fecha
    STATES.IN_PROGRESS,  // Usuario comienza ejecución
    STATES.COMPLETED,    // Usuario salta directamente a completado
    STATES.CANCELLED,    // Usuario cancela
  ],
  [STATES.OVERDUE]: [
    STATES.IN_PROGRESS,  // Finalmente el técnico ejecuta
    STATES.COMPLETED,    // Ejecuta completamente
    STATES.CANCELLED,    // Se cancela
  ],
  [STATES.IN_PROGRESS]: [
    STATES.COMPLETED,    // Se completa
    STATES.CANCELLED,    // Se cancela durante ejecución
  ],
  [STATES.COMPLETED]: [
    // No hay transiciones válidas desde completado
    // Sí se permite reintento idempotente (COMPLETED -> COMPLETED)
  ],
  [STATES.CANCELLED]: [
    // No hay transiciones válidas desde cancelado
  ],
};

/**
 * Valida si una transición de estado es permitida
 * @param {string} fromStatus - Estado actual
 * @param {string} toStatus - Estado deseado
 * @returns {Object} { valid: boolean, reason?: string }
 */
export function validateStateTransition(fromStatus, toStatus) {
  const from = String(fromStatus || "").toUpperCase().trim();
  const to = String(toStatus || "").toUpperCase().trim();

  // Reintento idempotente: mismo estado es válido
  if (from === to) {
    return { valid: true, isIdempotent: true };
  }

  // Estado actual no existe
  if (!VALID_TRANSITIONS[from]) {
    return {
      valid: false,
      reason: `Estado origen inválido: ${from}. Estados válidos: ${Object.keys(VALID_TRANSITIONS).join(", ")}`,
    };
  }

  // Estado destino no existe
  if (!Object.values(STATES).includes(to)) {
    return {
      valid: false,
      reason: `Estado destino inválido: ${to}. Estados válidos: ${Object.values(STATES).join(", ")}`,
    };
  }

  // Verificar si transición es válida
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    return {
      valid: false,
      reason: `Transición no permitida: ${from} → ${to}. Transiciones válidas desde ${from}: ${allowed.join(", ")}`,
    };
  }

  return { valid: true };
}

/**
 * Obtiene todas las transiciones válidas desde un estado
 */
export function getValidNextStates(currentStatus) {
  const status = String(currentStatus || "").toUpperCase().trim();
  return VALID_TRANSITIONS[status] || [];
}

/**
 * Valida si es una transición válida para que un usuario TECHNICIAN pueda ejecutar
 * (casos especiales para técnicos)
 */
export function canTechnicianTransitionTo(fromStatus, toStatus) {
  const { valid } = validateStateTransition(fromStatus, toStatus);

  if (!valid) {
    return {
      allowed: false,
      reason: "Transición de estado no permitida",
    };
  }

  const from = String(fromStatus).toUpperCase();
  const to = String(toStatus).toUpperCase();

  // Técnicos no pueden cancelar ejecuciones
  if (to === STATES.CANCELLED) {
    return {
      allowed: false,
      reason: "Técnicos no pueden cancelar ejecuciones",
    };
  }

  // Técnicos no pueden cambiar directamente a OVERDUE
  // (eso es automático del scheduler)
  if (to === STATES.OVERDUE) {
    return {
      allowed: false,
      reason: "No puedes forzar una ejecución a estado vencido",
    };
  }

  return { allowed: true };
}

/**
 * Obtiene la descripción de un estado (para UI)
 */
export function getStateLabel(status) {
  const labels = {
    [STATES.PENDING]: "Pendiente",
    [STATES.OVERDUE]: "Vencida",
    [STATES.IN_PROGRESS]: "En progreso",
    [STATES.COMPLETED]: "Completada",
    [STATES.CANCELLED]: "Cancelada",
  };

  return labels[String(status).toUpperCase()] || status;
}

/**
 * Obtiene el color para mostrar un estado (para UI)
 */
export function getStateColor(status) {
  const colors = {
    [STATES.PENDING]: "#3B82F6",    // azul
    [STATES.OVERDUE]: "#EF4444",    // rojo
    [STATES.IN_PROGRESS]: "#F59E0B", // ámbar
    [STATES.COMPLETED]: "#10B981",   // verde
    [STATES.CANCELLED]: "#6B7280",   // gris
  };

  return colors[String(status).toUpperCase()] || "#000000";
}

export { STATES };
