// src/routes/equipmentMove.routes.js
// Trasladar un equipo a otra planta (solo ADMIN). Lógica en services/equipmentMove.js.
import express from "express";
import { scopePlantIds, canAccessPlant } from "../services/accessScope.js";
import { logger } from "../config/logger.js";
import { logAudit } from "../services/audit.service.js";
import { notifyManagers } from "../notifications/notify.js";
import { previewMove, moveEquipment, MoveError } from "../services/equipmentMove.js";

export default function equipmentMoveRoutes({ prisma, auth, requireRole }) {
  const router = express.Router();
  const adminOnly = [auth, requireRole(["ADMIN"])];

  const args = (req) => ({
    equipmentId: Number(req.params.id),
    fromPlantId: req.currentPlantId,
    toPlantId: Number(req.query.toPlantId ?? req.body?.toPlantId),
  });
  const fail = (res, e, label) => {
    if (e instanceof MoveError) return res.status(e.status).json({ error: e.message });
    logger.error(label, e);
    return res.status(500).json({ error: "No se pudo trasladar el equipo" });
  };

  // Plantas destino posibles
  router.get("/equipment/move-targets", ...adminOnly, async (req, res) => {
    try {
      // Solo plantas del mismo cliente (las del admin); el dueño de la plataforma, todas.
      const scope = await scopePlantIds(prisma, req.user);
      const plants = await prisma.plant.findMany({
        where: { active: true, id: scope === null ? { not: req.currentPlantId } : { in: scope.filter((id) => id !== req.currentPlantId) } },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      });
      return res.json({ ok: true, items: plants });
    } catch (e) {
      return fail(res, e, "GET move-targets");
    }
  });

  // La planta destino debe estar dentro del alcance del admin.
  const assertTarget = async (req) => {
    const to = Number(req.query.toPlantId ?? req.body?.toPlantId);
    if (Number.isInteger(to) && !(await canAccessPlant(prisma, req.user, to))) throw new MoveError("Elige la planta destino");
  };

  router.get("/equipment/:id/move-preview", ...adminOnly, async (req, res) => {
    try {
      await assertTarget(req);
      return res.json({ ok: true, ...(await previewMove(prisma, args(req))) });
    } catch (e) {
      return fail(res, e, "GET move-preview");
    }
  });

  router.post("/equipment/:id/move", ...adminOnly, async (req, res) => {
    try {
      await assertTarget(req);
      const a = args(req);
      const r = await moveEquipment(prisma, a);
      logAudit({
        plantId: a.fromPlantId,
        userId: req.user.id,
        action: "UPDATE",
        model: "Equipment",
        recordId: a.equipmentId,
        changes: { before: { plantId: a.fromPlantId }, after: { plantId: a.toPlantId }, moved: r },
        ip: req.ip,
      });
      notifyManagers(prisma, {
        plantId: a.toPlantId,
        excludeUserId: req.user.id,
        type: "EXEC_ASSIGNED",
        title: "Equipo trasladado a tu planta",
        message: `${r.equipment.name}${r.equipment.code ? ` (${r.equipment.code})` : ""} · ${r.movedRoutes} ruta${r.movedRoutes === 1 ? "" : "s"} y ${r.movedOpenActivities} actividad${r.movedOpenActivities === 1 ? "" : "es"} pendiente${r.movedOpenActivities === 1 ? "" : "s"}${r.unassignedTechnicians.length ? " · revisar técnicos" : ""}`,
        link: `/equipments/${r.equipment.id}`,
      }).catch((err) => logger.error("notify equipment moved", err));
      return res.json({ ok: true, ...r });
    } catch (e) {
      return fail(res, e, "POST move");
    }
  });

  return router;
}
