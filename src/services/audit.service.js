import prisma from "../prisma.js";
import { logger } from "../config/logger.js";

/**
 * Loguea un cambio en auditoría
 * @param {Object} options
 * @param {number} options.plantId - ID de la planta
 * @param {number} [options.userId] - ID del usuario que hizo el cambio
 * @param {string} options.action - CREATE | UPDATE | DELETE | STATE_CHANGE
 * @param {string} options.model - Ejecución | Orden Preventiva | Lubricante
 * @param {string|number} options.recordId - ID del registro modificado
 * @param {Object} [options.changes] - Cambios realizados { before: {}, after: {} }
 * @param {string} [options.ip] - IP del cliente
 * @param {string} [options.userAgent] - User agent del cliente
 */
export async function logAudit({
  plantId,
  userId,
  action,
  model,
  recordId,
  changes,
  ip,
  userAgent,
}) {
  try {
    await prisma.auditLog.create({
      data: {
        plantId,
        userId,
        action,
        model,
        recordId: String(recordId),
        changes,
        ip: ip?.substring(0, 45), // limitar a 45 caracteres
        createdAt: new Date(),
      },
    });

    logger.debug(`[AUDIT] ${model} ${recordId}: ${action} por usuario ${userId}`);
  } catch (err) {
    // No fallar si auditoría falla, solo loguear
    logger.error(`[AUDIT ERROR] No se pudo registrar auditoría:`, err.message);
  }
}

/**
 * Loguea cambios de estado en Execution
 * Caso específico: mejor información para STATE_CHANGE
 */
export async function logExecutionStateChange({
  plantId,
  userId,
  executionId,
  oldStatus,
  newStatus,
  ip,
  userAgent,
  additionalInfo,
}) {
  try {
    const changes = {
      before: { status: oldStatus },
      after: { status: newStatus },
      ...additionalInfo,
    };

    await prisma.auditLog.create({
      data: {
        plantId,
        userId,
        action: "STATE_CHANGE",
        model: "Execution",
        recordId: String(executionId),
        changes: JSON.stringify(changes),
        ip: ip?.substring(0, 45),
        createdAt: new Date(),
      },
    });

    logger.info(`[AUDIT STATE] Execution ${executionId}: ${oldStatus} → ${newStatus} por usuario ${userId}`);
  } catch (err) {
    logger.error(`[AUDIT ERROR] No se pudo loguear cambio de estado:`, err.message);
  }
}

/**
 * Obtiene el historial de auditoría para una entidad
 */
export async function getAuditHistory({
  plantId,
  model,
  recordId,
  limit = 50,
  offset = 0,
}) {
  try {
    const logs = await prisma.auditLog.findMany({
      where: {
        plantId,
        model,
        recordId: String(recordId),
      },
      include: {
        user: {
          select: { id: true, email: true, name: true },
        },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    });

    return logs;
  } catch (err) {
    logger.error(`[AUDIT ERROR] No se pudo obtener historial:`, err.message);
    return [];
  }
}
