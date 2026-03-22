// src/controllers/technicians.controller.js
import prisma from "../prisma.js";

export const findAll = async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    if (!plantId) {
      return res.status(400).json({ error: "PLANT_REQUIRED" });
    }

    const technicians = await prisma.technician.findMany({
      where: {
        plantId,
        deletedAt: null,
      },
      orderBy: { id: "desc" },
      include: {
        executions: {
  where: {
    plantId,
    executedAt: { not: null },
    status: "COMPLETED",
  },
  orderBy: [{ executedAt: "desc" }],
  take: 1,
  select: {
    executedAt: true,
  },
},
        user: {
          select: {
            id: true,
            conditionReports: {
              where: { plantId },
              orderBy: [{ detectedAt: "desc" }, { createdAt: "desc" }],
              take: 1,
              select: {
                detectedAt: true,
                createdAt: true,
              },
            },
          },
        },
      },
    });

    const result = (technicians || []).map((t) => {
      const lastExec = t.executions?.[0] ?? null;
const execDate = lastExec?.executedAt ?? null;

      const lastReport = t.user?.conditionReports?.[0] ?? null;
      const reportDate = lastReport?.detectedAt ?? lastReport?.createdAt ?? null;

      const candidates = [execDate, reportDate]
        .filter(Boolean)
        .map((d) => new Date(d))
        .filter((d) => Number.isFinite(d.getTime()));

      const lastActivityAt =
        candidates.length > 0
          ? candidates.sort((a, b) => b.getTime() - a.getTime())[0].toISOString()
          : null;

      const { executions, user, ...rest } = t;

      return {
        ...rest,
        lastActivityAt,
      };
    });

    return res.json(result);
  } catch (error) {
    console.error("Error obteniendo técnicos:", error);
    return res.status(500).json({ error: "Error obteniendo técnicos" });
  }
};

export async function findActive(req, res) {
  try {
    const plantId = req.currentPlantId;
    if (!plantId) {
      return res.status(400).json({ error: "PLANT_REQUIRED" });
    }

    const items = await prisma.technician.findMany({
      where: {
        plantId,
        deletedAt: null,
        status: {
          in: ["Activo", "ACTIVO", "Active", "ACTIVE"],
        },
      },
      orderBy: { id: "desc" },
    });

    return res.json({ ok: true, items });
  } catch (error) {
    console.error("Error obteniendo técnicos activos:", error);
    return res.status(500).json({ error: "Error obteniendo técnicos activos" });
  }
}

export async function findById(req, res) {
  try {
    const plantId = req.currentPlantId;
    if (!plantId) {
      return res.status(400).json({ error: "PLANT_REQUIRED" });
    }

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "ID inválido" });
    }

    const tech = await prisma.technician.findFirst({
      where: {
        id,
        plantId,
        deletedAt: null,
      },
    });

    if (!tech) {
      return res.status(404).json({ error: "Técnico no encontrado" });
    }

    return res.json({ ok: true, item: tech });
  } catch (error) {
    console.error("Error obteniendo técnico:", error);
    return res.status(500).json({ error: "Error obteniendo técnico" });
  }
}

export async function createTechnician(req, res) {
  try {
    const plantId = req.currentPlantId;
    if (!plantId) {
      return res.status(400).json({ error: "PLANT_REQUIRED" });
    }

    const name = String(req.body?.name || "").trim();
    const code = String(req.body?.code || "").trim().toUpperCase();
    const specialty = String(req.body?.specialty || "").trim();
    const status = String(req.body?.status || "Activo").trim();

    if (!name || !code || !specialty) {
      return res.status(400).json({
        error: "Nombre, código y especialidad son obligatorios",
      });
    }

    const created = await prisma.technician.create({
      data: {
        plantId,
        name,
        code,
        specialty,
        status,
        deletedAt: null,
      },
    });

    return res.status(201).json({
      ok: true,
      item: {
        ...created,
        lastActivityAt: null,
      },
    });
  } catch (e) {
    console.error("POST technician", e);

    if (e?.code === "P2002") {
      return res.status(409).json({
        error: "Ya existe un técnico con ese código en esta planta",
      });
    }

    return res.status(500).json({ error: "Error creando técnico" });
  }
}

export async function updateTechnician(req, res) {
  try {
    const plantId = req.currentPlantId;
    if (!plantId) {
      return res.status(400).json({ error: "PLANT_REQUIRED" });
    }

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "ID inválido" });
    }

    const exists = await prisma.technician.findFirst({
      where: {
        id,
        plantId,
        deletedAt: null,
      },
    });

    if (!exists) {
      return res.status(404).json({ error: "Técnico no existe" });
    }

    const { name, code, specialty, status } = req.body;

    const updated = await prisma.technician.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: String(name).trim() }),
        ...(code !== undefined && { code: String(code).trim().toUpperCase() }),
        ...(specialty !== undefined && { specialty: String(specialty).trim() }),
        ...(status !== undefined && { status: String(status).trim() }),
      },
    });

    return res.json({
      ok: true,
      item: {
        ...updated,
        lastActivityAt: exists.lastActivityAt ?? null,
      },
    });
  } catch (e) {
    console.error("PATCH/PUT technician", e);

    if (e?.code === "P2002") {
      return res.status(409).json({
        error: "Ya existe un técnico con ese código en esta planta",
      });
    }

    return res.status(500).json({ error: "Error actualizando técnico" });
  }
}

export async function deleteTechnician(req, res) {
  try {
    const plantId = req.currentPlantId;
    if (!plantId) {
      return res.status(400).json({ error: "PLANT_REQUIRED" });
    }

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "ID inválido" });
    }

    const exists = await prisma.technician.findFirst({
      where: {
        id,
        plantId,
        deletedAt: null,
      },
    });

    if (!exists) {
      return res.status(404).json({ error: "Técnico no encontrado" });
    }

    await prisma.technician.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    return res.json({ ok: true });
  } catch (e) {
    console.error("DELETE technician", e);
    return res.status(500).json({ error: "Error eliminando técnico" });
  }
}