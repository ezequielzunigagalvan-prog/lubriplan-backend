// src/utils/workOrderStateManager.js

/**
 * Work Order State Machine
 * Define transiciones válidas entre estados
 */

export const WORK_ORDER_STATES = {
  REQUESTED: "REQUESTED",
  PENDING_APPROVAL: "PENDING_APPROVAL",
  APPROVED: "APPROVED",
  ASSIGNED: "ASSIGNED",
  IN_PROGRESS: "IN_PROGRESS",
  WAITING_PARTS: "WAITING_PARTS",
  FINISHED: "FINISHED",
  VALIDATED: "VALIDATED",
  REJECTED: "REJECTED",
};

export const VALID_TRANSITIONS = {
  [WORK_ORDER_STATES.REQUESTED]: [WORK_ORDER_STATES.PENDING_APPROVAL],
  [WORK_ORDER_STATES.PENDING_APPROVAL]: [
    WORK_ORDER_STATES.APPROVED,
    WORK_ORDER_STATES.REJECTED,
  ],
  [WORK_ORDER_STATES.APPROVED]: [WORK_ORDER_STATES.ASSIGNED],
  [WORK_ORDER_STATES.ASSIGNED]: [WORK_ORDER_STATES.IN_PROGRESS],
  [WORK_ORDER_STATES.IN_PROGRESS]: [
    WORK_ORDER_STATES.FINISHED,
    WORK_ORDER_STATES.WAITING_PARTS,
  ],
  [WORK_ORDER_STATES.WAITING_PARTS]: [
    WORK_ORDER_STATES.IN_PROGRESS,
    WORK_ORDER_STATES.FINISHED,
  ],
  [WORK_ORDER_STATES.FINISHED]: [
    WORK_ORDER_STATES.VALIDATED,
    WORK_ORDER_STATES.REJECTED,
  ],
};

/**
 * Valida si una transición de estado es permitida
 */
export function isValidTransition(currentStatus, newStatus) {
  if (!currentStatus || !newStatus) return false;
  const validStates = VALID_TRANSITIONS[currentStatus] || [];
  return validStates.includes(newStatus);
}

/**
 * Valida transición y retorna error si es inválida
 */
export function validateTransition(currentStatus, newStatus) {
  if (!isValidTransition(currentStatus, newStatus)) {
    return {
      valid: false,
      error: `Cannot transition from ${currentStatus} to ${newStatus}`,
      validTransitions: VALID_TRANSITIONS[currentStatus] || [],
    };
  }
  return { valid: true };
}

/**
 * Obtiene estados terminales (donde no hay más transiciones)
 */
export function isTerminalState(status) {
  return !VALID_TRANSITIONS[status] || VALID_TRANSITIONS[status].length === 0;
}
