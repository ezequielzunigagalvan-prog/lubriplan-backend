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

const router = Router();

// Lectura: cualquier usuario autenticado de la planta (los selectores de asignación la usan).
router.get("/", findAll);
router.get("/active", findActive);
router.get("/next-code", requireRole(["ADMIN", "SUPERVISOR"]), nextCode);
router.get("/:id", findById);

// Escritura: antes no había control de rol y un técnico podía crear, editar o borrar técnicos.
// Igual que en la pantalla: ADMIN y SUPERVISOR crean/editan; solo ADMIN elimina.
const managers = requireRole(["ADMIN", "SUPERVISOR"]);

router.post("/", managers, createTechnician);
router.patch("/:id", managers, updateTechnician);
router.put("/:id", managers, updateTechnician);
router.delete("/:id", requireRole(["ADMIN"]), deleteTechnician);

export default router;
