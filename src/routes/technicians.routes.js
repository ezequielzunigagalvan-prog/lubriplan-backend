// src/routes/technicians.routes.js
// Montado en index.js como: app.use("/api/technicians", requireAuth, router)
import { Router } from "express";
import { requireRole } from "../middleware/requireRole.js";
import {
  findAll,
  findActive,
  findById,
  nextCode,
  createTechnician,
  updateTechnician,
  deleteTechnician,
} from "../controllers/technicians.controller.js";
import prisma from "../prisma.js";
import { logger } from "../config/logger.js";
import { logAudit } from "../services/audit.service.js";
import { listOtherPlantTechnicians, borrowTechnician } from "../services/borrowTechnician.js";

const router = Router();

// Lectura: cualquier usuario autenticado de la planta (los selectores de asignación la usan).
router.get("/", findAll);
router.get("/active", findActive);
router.get("/next-code", requireRole(["ADMIN", "SUPERVISOR"]), nextCode);

// Técnicos de otras plantas (para asignarlos a una actividad de esta planta).
router.get("/other-plants", requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
  try {
    if (!req.currentPlantId) return res.status(400).json({ error: "PLANT_REQUIRED" });
    const items = await listOtherPlantTechnicians(prisma, { user: req.user, currentPlantId: req.currentPlantId });
    return res.json({ items });
  } catch (e) {
    logger.error("GET /technicians/other-plants", e);
    return res.status(500).json({ error: "No se pudieron cargar los técnicos de otras plantas" });
  }
});

// Trae a un técnico de otra planta: devuelve su perfil en esta planta (lo crea si hace falta).
router.post("/borrow", requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
  try {
    if (!req.currentPlantId) return res.status(400).json({ error: "PLANT_REQUIRED" });
    const technicianId = Number(req.body?.technicianId);
    if (!Number.isInteger(technicianId)) return res.status(400).json({ error: "Elige un técnico" });
    const r = await borrowTechnician(prisma, { user: req.user, currentPlantId: req.currentPlantId, technicianId });
    if (r.created || r.accessGranted) {
      logAudit({
        plantId: req.currentPlantId,
        userId: req.user?.id,
        action: "CREATE",
        model: "Technician",
        recordId: r.technician.id,
        changes: { after: { profileFromPlantId: r.fromPlantId, sourceTechnicianId: technicianId, created: r.created, accessGranted: r.accessGranted } },
        ip: req.ip,
      });
    }
    return res.json(r);
  } catch (e) {
    if (e?.status) return res.status(e.status).json({ error: e.message });
    logger.error("POST /technicians/borrow", e);
    return res.status(500).json({ error: "No se pudo asignar el técnico de otra planta" });
  }
});
router.get("/:id", findById);

// Escritura: antes no había control de rol y un técnico podía crear, editar o borrar técnicos.
// Igual que en la pantalla: ADMIN y SUPERVISOR crean/editan; solo ADMIN elimina.
const managers = requireRole(["ADMIN", "SUPERVISOR"]);

router.post("/", managers, createTechnician);
router.patch("/:id", managers, updateTechnician);
router.put("/:id", managers, updateTechnician);
router.delete("/:id", requireRole(["ADMIN"]), deleteTechnician);

export default router;
