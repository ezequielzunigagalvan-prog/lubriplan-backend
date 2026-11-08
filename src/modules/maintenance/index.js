import express from "express";
import { requireAuth } from "../../middleware/requireAuth.js";
import { requireRole } from "../../middleware/requireRole.js";
import { requireMaintenanceAccess } from "./access.js";
import assetsRouter from "./assets/router.js";
import workOrdersRouter from "./workOrders/router.js";
import dashboardRouter from "./dashboard/router.js";
import plansRouter from "./plans/router.js";
import metersRouter from "./meters/router.js";
import calendarRouter from "./calendar/router.js";
import complianceRouter from "./compliance/router.js";

export function mountMaintenance(app, deps) {
  const { prisma } = deps;

  app.get("/api/maintenance/health", (req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/maintenance/me/access", requireAuth, async (req, res) => {
    try {
      const access = await prisma.mtPlantAccess.findUnique({
        where: { plantId: req.currentPlantId ?? 0 },
        select: { enabled: true, plan: true },
      });

      return res.json({
        enabled: !!access?.enabled,
        role: req.user.role,
        plan: access?.plan ?? null,
      });
    } catch (err) {
      return res.status(500).json({ error: "Error checking access" });
    }
  });

  const maintenanceRouter = express.Router();
  maintenanceRouter.use(requireAuth, requireMaintenanceAccess);

  maintenanceRouter.use("/assets", assetsRouter);
  maintenanceRouter.use("/work-orders", workOrdersRouter);
  maintenanceRouter.use("/plans", plansRouter);
  maintenanceRouter.use("/meters", metersRouter);
  maintenanceRouter.use("/calendar", calendarRouter);
  maintenanceRouter.use("/compliance", complianceRouter);
  maintenanceRouter.use("/dashboard", dashboardRouter);

  maintenanceRouter.get("/assignable-users", async (req, res) => {
    try {
      const plantId = req.currentPlantId;

      const technicians = await prisma.technician.findMany({
        where: { plantId },
        select: {
          id: true,
          name: true,
          code: true,
          specialty: true,
        },
        orderBy: { name: "asc" },
      });

      return res.json(technicians);
    } catch (err) {
      return res.status(500).json({ error: "Error fetching technicians" });
    }
  });

  app.use("/api/maintenance", maintenanceRouter);
}
