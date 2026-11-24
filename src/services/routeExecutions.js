// src/services/routeExecutions.js
// Actividad programada de una ruta.
//
// Invariante: cada ruta tiene UNA sola actividad abierta (pendiente/vencida) y su fecha es la
// próxima fecha de la ruta (Route.nextDate). Lo usan alta, edición y cierre de actividades.

import { ymdToDate } from "../utils/routeSchedule.js";

/** Ids de los equipos de la ruta (el principal primero). */
export function routeEquipmentIds(route) {
  const list = Array.isArray(route?.equipments) ? [...route.equipments] : [];
  if (list.length) {
    return list.sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.equipmentId - b.equipmentId).map((x) => x.equipmentId);
  }
  return route?.equipmentId ? [route.equipmentId] : [];
}

/**
 * Equipo para la evidencia de la siguiente actividad de una ruta con varios equipos:
 * al azar, sin repetir hasta pasar por todos (excluye los últimos n-1 elegidos).
 */
export async function pickEvidenceEquipment(tx, routeId, equipmentIds, random = Math.random) {
  if (!equipmentIds.length) return null;
  if (equipmentIds.length === 1) return equipmentIds[0];
  const recent = await tx.execution.findMany({
    where: { routeId, evidenceEquipmentId: { not: null } },
    orderBy: [{ scheduledAt: "desc" }, { id: "desc" }],
    take: equipmentIds.length - 1,
    select: { evidenceEquipmentId: true },
  });
  const used = new Set(recent.map((r) => r.evidenceEquipmentId));
  const candidates = equipmentIds.filter((id) => !used.has(id));
  const pool = candidates.length ? candidates : equipmentIds;
  return pool[Math.floor(random() * pool.length)];
}

/**
 * Deja una sola actividad abierta en la fecha `ymd` (YYYY-MM-DD).
 * Reutiliza la abierta existente (la mueve) y elimina duplicadas.
 */
export async function syncOpenExecution(tx, { plantId, route, ymd, technicianId }) {
  if (!ymd) return null;
  const scheduledAt = ymdToDate(ymd);
  const equipmentIds = routeEquipmentIds(route);
  const multi = equipmentIds.length > 1;

  const open = await tx.execution.findMany({
    where: { plantId, routeId: route.id, status: { in: ["PENDING", "OVERDUE"] } },
    orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
    select: { id: true, evidenceEquipmentId: true },
  });
  const [keep, ...extra] = open;
  if (extra.length) await tx.execution.deleteMany({ where: { plantId, id: { in: extra.map((x) => x.id) } } });

  let evidenceEquipmentId = null;
  if (route.evidenceRequired && multi) {
    evidenceEquipmentId =
      keep?.evidenceEquipmentId && equipmentIds.includes(keep.evidenceEquipmentId)
        ? keep.evidenceEquipmentId
        : await pickEvidenceEquipment(tx, route.id, equipmentIds);
  }

  const data = {
    scheduledAt,
    status: "PENDING",
    technicianId: technicianId ?? null,
    equipmentId: equipmentIds[0] ?? route.equipmentId ?? null,
    evidenceEquipmentId,
  };
  if (keep) return tx.execution.update({ where: { id: keep.id }, data, select: { id: true, scheduledAt: true } });
  return tx.execution.create({ data: { plantId, routeId: route.id, ...data }, select: { id: true, scheduledAt: true } });
}
