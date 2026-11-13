import express from "express";
import { z } from "zod";
import prisma from "../../../prisma.js";
import { logger } from "../../../config/logger.js";

const router = express.Router();

const createTechnicianSchema = z.object({
  name: z.string().min(1),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  speciality: z.string().optional(),
  code: z.string().optional(),
  joinDate: z.string().datetime().optional(),
  status: z.enum(["Activo", "Inactivo"]).default("Activo"),
  certifications: z.array(z.string()).optional(),
});

// GET /technicians - Listar técnicos
router.get("/", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const { search, status, page = 1, limit = 50 } = req.query;

    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 50));
    const skip = (pageNum - 1) * limitNum;

    const where = {
      plantId,
      deletedAt: null,
    };

    if (status) where.status = status;
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
        { code: { contains: search, mode: "insensitive" } },
      ];
    }

    const technicians = await prisma.technician.findMany({
      where,
      select: {
        id: true,
        name: true,
        code: true,
        email: true,
        phone: true,
        specialty: true,
        status: true,
        createdAt: true,
      },
      skip,
      take: limitNum,
      orderBy: { name: "asc" },
    });

    const total = await prisma.technician.count({ where });

    return res.json({
      data: technicians,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum),
    });
  } catch (err) {
    logger.error("[technicians GET]", err);
    return res.status(500).json({ error: "Error fetching technicians" });
  }
});

// GET /:id - Obtener técnico
router.get("/:id", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const technicianId = parseInt(req.params.id);

    const technician = await prisma.technician.findFirst({
      where: { id: technicianId, plantId, deletedAt: null },
    });

    if (!technician) {
      return res.status(404).json({ error: "Technician not found" });
    }

    return res.json(technician);
  } catch (err) {
    logger.error("[technicians/:id GET]", err);
    return res.status(500).json({ error: "Error fetching technician" });
  }
});

// POST / - Crear técnico
router.post("/", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const parsed = createTechnicianSchema.parse(req.body);

    // Generar código si no se proporciona
    const code = parsed.code || `TEC-${Date.now()}`;

    const technician = await prisma.technician.create({
      data: {
        plantId,
        name: parsed.name,
        code,
        email: parsed.email || null,
        phone: parsed.phone || null,
        specialty: parsed.speciality || "General",
        certifications: JSON.stringify(parsed.certifications || []),
        status: parsed.status || "Activo",
      },
    });

    return res.status(201).json(technician);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors[0]?.message });
    }
    logger.error("[technicians POST]", err);
    return res.status(500).json({ error: "Error creating technician" });
  }
});

// PATCH /:id - Actualizar técnico
router.patch("/:id", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const technicianId = parseInt(req.params.id);

    const technician = await prisma.technician.findFirst({
      where: { id: technicianId, plantId },
    });

    if (!technician) {
      return res.status(404).json({ error: "Technician not found" });
    }

    const updateData = {};
    const fieldMapping = {
      name: "name",
      email: "email",
      phone: "phone",
      speciality: "specialty",
      status: "status",
      certifications: "certifications",
    };

    for (const [key, dbField] of Object.entries(fieldMapping)) {
      if (key in req.body) {
        if (dbField === "certifications") {
          updateData[dbField] = JSON.stringify(req.body[key]);
        } else if (dbField === "specialty") {
          updateData[dbField] = req.body[key] || "General";
        } else {
          updateData[dbField] = req.body[key];
        }
      }
    }

    if (Object.keys(updateData).length === 0) {
      return res.json(technician);
    }

    const updated = await prisma.technician.update({
      where: { id: technicianId },
      data: updateData,
    });

    return res.json(updated);
  } catch (err) {
    logger.error("[technicians PATCH]", err);
    return res.status(500).json({ error: "Error updating technician" });
  }
});

// DELETE /:id - Eliminar técnico
router.delete("/:id", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const technicianId = parseInt(req.params.id);

    const technician = await prisma.technician.findFirst({
      where: { id: technicianId, plantId },
    });

    if (!technician) {
      return res.status(404).json({ error: "Technician not found" });
    }

    // Soft delete - marcar como inactivo
    const updated = await prisma.technician.update({
      where: { id: technicianId },
      data: { status: "Inactivo", deletedAt: new Date() },
    });

    return res.json({ message: "Technician deactivated", technician: updated });
  } catch (err) {
    logger.error("[technicians DELETE]", err);
    return res.status(500).json({ error: "Error deleting technician" });
  }
});

export default router;
