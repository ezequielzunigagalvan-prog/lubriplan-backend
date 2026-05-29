import { logger } from "../config/logger.js";
// src/services/auditLog.service.js

/**
 * Crea un registro en AuditLog.
 * Fire-and-forget: no lanza excepción al caller si falla.
 */
export async function createAuditLog(prisma, { plantId, userId, userEmail, action, model, recordId, changes, ip } = {}) {
  try {
    await prisma.auditLog.create({
      data: {
        plantId: plantId ?? null,
        userId: userId ?? null,
        userEmail: userEmail ?? null,
        action: String(action),
        model: String(model),
        recordId: Number(recordId),
        changes: changes ?? null,
        ip: ip ?? null,
      },
    });
  } catch (e) {
    // Audit log failures should never crash the main flow
    logger.error("auditLog.service createAuditLog error:", e?.message);
  }
}
