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

const TERMINAL_STATES = new Set([STATES.VALIDATED, STATES.REJECTED, STATES.CANCELLED]);

export function canTransition(order, toState, user) {
  const currentState = order.status;

  if (TERMINAL_STATES.has(currentState)) {
    return { allowed: false, reason: `Cannot transition from terminal state ${currentState}` };
  }

  const isAdmin = ["ADMIN", "SUPERVISOR"].includes(user.role);
  const isTechnician = user.role === "TECHNICIAN";
  const isAssigned = order.assignedTo === user.id;

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
      [STATES.IN_PROGRESS]: () => isAssigned,
      [STATES.CANCELLED]: () => isAdmin,
    },
    [STATES.IN_PROGRESS]: {
      [STATES.WAITING_PARTS]: () => isAssigned || isAdmin,
      [STATES.WAITING_PRODUCTION]: () => isAssigned || isAdmin,
      [STATES.FINISHED]: () => isAssigned,
      [STATES.CANCELLED]: () => isAdmin,
    },
    [STATES.WAITING_PARTS]: {
      [STATES.IN_PROGRESS]: () => true,
      [STATES.CANCELLED]: () => isAdmin,
    },
    [STATES.WAITING_PRODUCTION]: {
      [STATES.IN_PROGRESS]: () => true,
      [STATES.CANCELLED]: () => isAdmin,
    },
    [STATES.FINISHED]: {
      [STATES.VALIDATED]: () => isAdmin,
      [STATES.IN_PROGRESS]: () => isAdmin,
      [STATES.CANCELLED]: () => isAdmin,
    },
  };

  const allowedTransitions = transitions[currentState];
  if (!allowedTransitions || !allowedTransitions[toState]) {
    return { allowed: false, reason: `Transition ${currentState} → ${toState} not allowed` };
  }

  const checkFn = allowedTransitions[toState];
  const allowed = checkFn();

  if (!allowed) {
    return { allowed: false, reason: `Insufficient permissions for ${currentState} → ${toState}` };
  }

  return { allowed: true };
}

export function getRequiredFieldsForTransition(fromState, toState) {
  const required = {};

  if (toState === STATES.ASSIGNED) {
    required.assignedTo = "assignedTo is required when moving to ASSIGNED";
  }

  if (toState === STATES.FINISHED) {
    required.workDone = "workDone is required when moving to FINISHED";
  }

  if (toState === STATES.IN_PROGRESS && fromState === STATES.ASSIGNED) {
    // Only the first time we transition to IN_PROGRESS do we set startedAt
  }

  return required;
}
