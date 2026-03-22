  // src/routes/admin.links.routes.js
  import express from "express";

  export default function adminLinksRoutes({ prisma, auth }) {
    const router = express.Router();

    // middleware simple: solo ADMIN
    const requireAdmin = (req, res, next) => {
      const role = String(req.user?.role || "").toUpperCase();
      if (role !== "ADMIN") return res.status(403).json({ error: "Sin permiso" });
      next();
    };

    // =========================
    // GET /admin/links/technicians
    // Devuelve:
    // - techUsers: usuarios TECH con su technician actual (si lo tiene)
    // - technicians: lista de technicians (y si ya están ligados a un user)
    // =========================
    router.get("/admin/links/technicians", auth, requireAdmin, async (req, res) => {
      try {
        const techUsers = await prisma.user.findMany({
          where: { role: "TECHNICIAN", active: true },
          orderBy: { name: "asc" },
          select: {
            id: true,
            name: true,
            email: true,
            technicianId: true,
            technician: { select: { id: true, name: true, code: true, status: true } },
          },
        });

        const technicians = await prisma.technician.findMany({
          where: { deletedAt: null },
          orderBy: { name: "asc" },
          select: {
            id: true,
            name: true,
            code: true,
            status: true,
            user: { select: { id: true, name: true, email: true } }, // por relation "UserTechnician"
          },
        });

        res.json({ techUsers, technicians });
      } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Error cargando vínculos" });
      }
    });

    // =========================
    // PATCH /admin/users/:id/link-technician
    // body: { technicianId: number|null, syncName?: boolean }
    // =========================
    router.patch("/admin/users/:id/link-technician", auth, requireAdmin, async (req, res) => {
      try {
        const userId = Number(req.params.id);
        if (!Number.isFinite(userId)) return res.status(400).json({ error: "ID inválido" });

        const techIdRaw = req.body?.technicianId;
        const technicianId =
          techIdRaw === null || techIdRaw === "" || techIdRaw === undefined ? null : Number(techIdRaw);

        if (technicianId !== null && !Number.isFinite(technicianId)) {
          return res.status(400).json({ error: "technicianId inválido" });
        }

        const syncName = Boolean(req.body?.syncName);

        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, role: true, technicianId: true, name: true },
        });
        if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

        if (String(user.role).toUpperCase() !== "TECHNICIAN") {
          return res.status(400).json({ error: "El usuario no es TECHNICIAN" });
        }

        // Si va a ligar a un técnico, validar que exista y que no esté ligado a otro usuario
        let tech = null;
        if (technicianId !== null) {
          tech = await prisma.technician.findFirst({
            where: { id: technicianId, deletedAt: null },
            select: { id: true, name: true, code: true },
          });
          if (!tech) return res.status(404).json({ error: "Técnico no encontrado" });

          const already = await prisma.user.findFirst({
            where: { technicianId: technicianId, id: { not: userId } },
            select: { id: true, name: true },
          });
          if (already) {
            return res.status(409).json({
              error: `Este técnico ya está ligado a otro usuario (${already.name}).`,
            });
          }
        }

        const updated = await prisma.user.update({
          where: { id: userId },
          data: {
            technicianId: technicianId,
            ...(syncName && tech ? { name: tech.name } : null),
          },
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            technicianId: true,
            technician: { select: { id: true, name: true, code: true, status: true } },
          },
        });

        res.json({ item: updated });
      } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Error actualizando vínculo" });
      }
    });

    return router;
  }