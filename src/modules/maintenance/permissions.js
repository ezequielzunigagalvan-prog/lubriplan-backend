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

export function isAssignedTo(workOrder, user) {
  return workOrder.assignedTo === user.id;
}

export function isRequestedBy(workOrder, user) {
  return workOrder.requestedBy === user.id;
}
