// src/routes/technicians.routes.js
import { Router } from "express";
import {
  findAll,
  findActive,
  findById,
  createTechnician,
  updateTechnician,
  deleteTechnician,
} from "../controllers/technicians.controller.js";

const router = Router();

router.get("/", findAll);
router.get("/active", findActive);
router.get("/:id", findById);

router.post("/", createTechnician);

// acepta ambos para evitar mismatch
router.patch("/:id", updateTechnician);
router.put("/:id", updateTechnician);

router.delete("/:id", deleteTechnician);

export default router;