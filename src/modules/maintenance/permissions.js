export function canApproveWorkOrder(user) {
  return ["ADMIN", "SUPERVISOR"].includes(user.role);
}

export function canAssignWorkOrder(user) {
  return ["ADMIN", "SUPERVISOR"].includes(user.role);
}

export function canValidateWorkOrder(user) {
  return ["ADMIN", "SUPERVISOR"].includes(user.role);
}

export function canDeleteAsset(user) {
  return ["ADMIN", "SUPERVISOR"].includes(user.role);
}

// assignedTo guarda el id del técnico (Technician.id); el usuario lo tiene en technicianId
export function isAssignedTo(workOrder, user) {
  return workOrder.assignedTo != null && user?.technicianId != null && workOrder.assignedTo === user.technicianId;
}

export function isRequestedBy(workOrder, user) {
  return workOrder.requestedBy === user.id;
}
