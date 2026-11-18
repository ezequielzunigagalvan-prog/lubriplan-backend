export const STATES = {
  REQUESTED: "REQUESTED",
  REJECTED: "REJECTED",
  APPROVED: "APPROVED",
  ASSIGNED: "ASSIGNED",
  IN_PROGRESS: "IN_PROGRESS",
  WAITING_PARTS: "WAITING_PARTS",
  WAITING_PRODUCTION: "WAITING_PRODUCTION",
  FINISHED: "FINISHED",
  VALIDATED: "VALIDATED",
  CANCELLED: "CANCELLED",
};

export const TERMINAL_STATES = new Set([STATES.VALIDATED, STATES.REJECTED, STATES.CANCELLED]);
export const CLOSED_STATES = [STATES.FINISHED, STATES.VALIDATED, STATES.REJECTED, STATES.CANCELLED];

export const isManager = (user) => ["ADMIN", "SUPERVISOR"].includes(user?.role);

/**
 * `assignedTo` guarda el id del TÉCNICO (Technician.id), no del usuario.
 * Un usuario es "el asignado" si su ficha de técnico vinculada coincide.
 */
export function isAssignedTechnician(order, user) {
  return order.assignedTo != null && user?.technicianId != null && order.assignedTo === user.technicianId;
}

/**
 * Reglas de transición. Los supervisores/admin también pueden ejecutar los pasos del técnico
 * (iniciar, terminar) para registrar trabajos hechos por personal sin usuario en el sistema.
 */
export function canTransition(order, toState, user) {
  const currentState = order.status;

  if (TERMINAL_STATES.has(currentState)) {
    return { allowed: false, reason: `Cannot transition from terminal state ${currentState}` };
  }

  const isAdmin = isManager(user);
  const isAssigned = isAssignedTechnician(order, user);

  const transitions = {
    [STATES.REQUESTED]: {
      [STATES.APPROVED]: () => isAdmin,
      [STATES.REJECTED]: () => isAdmin,
      [STATES.CANCELLED]: () => isAdmin,
    },
    [STATES.APPROVED]: {
      [STATES.ASSIGNED]: () => isAdmin,
      [STATES.CANCELLED]: () => isAdmin,
    },
    [STATES.ASSIGNED]: {
      [STATES.ASSIGNED]: () => isAdmin, // reasignar
      [STATES.IN_PROGRESS]: () => isAssigned || isAdmin,
      [STATES.CANCELLED]: () => isAdmin,
    },
    [STATES.IN_PROGRESS]: {
      [STATES.WAITING_PARTS]: () => isAssigned || isAdmin,
      [STATES.WAITING_PRODUCTION]: () => isAssigned || isAdmin,
      [STATES.FINISHED]: () => isAssigned || isAdmin,
      [STATES.CANCELLED]: () => isAdmin,
    },
    [STATES.WAITING_PARTS]: {
      [STATES.IN_PROGRESS]: () => isAssigned || isAdmin,
      [STATES.CANCELLED]: () => isAdmin,
    },
    [STATES.WAITING_PRODUCTION]: {
      [STATES.IN_PROGRESS]: () => isAssigned || isAdmin,
      [STATES.CANCELLED]: () => isAdmin,
    },
    [STATES.FINISHED]: {
      [STATES.VALIDATED]: () => isAdmin,
      [STATES.IN_PROGRESS]: () => isAdmin, // reabrir
      [STATES.CANCELLED]: () => isAdmin,
    },
  };

  const allowedTransitions = transitions[currentState];
  if (!allowedTransitions || !allowedTransitions[toState]) {
    return { allowed: false, reason: `Transition ${currentState} → ${toState} not allowed` };
  }

  if (!allowedTransitions[toState]()) {
    return { allowed: false, reason: `Insufficient permissions for ${currentState} → ${toState}` };
  }

  return { allowed: true };
}

/** Estados a los que el usuario puede mover la OT desde su estado actual. */
export function availableTransitions(order, user) {
  return Object.values(STATES).filter((to) => canTransition(order, to, user).allowed);
}

export function getRequiredFieldsForTransition(fromState, toState) {
  const required = {};

  if (toState === STATES.ASSIGNED) {
    required.assignedTo = "assignedTo is required when moving to ASSIGNED";
  }

  if (toState === STATES.FINISHED) {
    required.workDone = "workDone is required when moving to FINISHED";
  }

  if (toState === STATES.REJECTED || toState === STATES.CANCELLED) {
    required.comment = "A reason (comment) is required to reject or cancel";
  }

  return required;
}
