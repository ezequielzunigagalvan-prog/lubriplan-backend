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
import sparePartsRouter from "./spareParts/router.js";
import inventoryRouter from "./inventory/router.js";
import failureCodesRouter from "./failureCodes/router.js";
import indicatorsRouter from "./indicators/router.js";
import notificationsRouter from "./notifications/router.js";
import schedulerRouter from "./scheduler/router.js";
import analyticsRouter from "./analytics/analyticsRouter.js";
import reportsRouter from "./reports/reportsRouter.js";

export function mountMaintenance(app, deps) {
  const { prisma } = deps;

  app.get("/api/maintenance/health", (req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/maintenance/me/access", requireAuth, async (req, res) => {
    try {
      const plantId = req.currentPlantId;

      if (!plantId) {
        console.error("[DEBUG] currentPlantId is null/undefined", {
          headers: req.headers,
          user: req.user?.id,
        });
        return res.status(400).json({ error: "PLANT_REQUIRED" });
      }

      // Use raw SQL to bypass Prisma schema issues
      const access = await prisma.$queryRaw`
        SELECT enabled, plan FROM "mtPlantAccess" WHERE plantid = ${plantId}
      `;

      const result = access?.[0];
      return res.json({
        enabled: !!result?.enabled,
        role: req.user.role,
        plan: result?.plan ?? null,
      });
    } catch (err) {
      console.error("[maintenance/access]", err);
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
  maintenanceRouter.use("/spare-parts", sparePartsRouter);
  maintenanceRouter.use("/inventory", inventoryRouter);
  maintenanceRouter.use("/failure-codes", failureCodesRouter);
  maintenanceRouter.use("/indicators", indicatorsRouter);
  maintenanceRouter.use("/notifications", notificationsRouter);
  maintenanceRouter.use("/scheduler", schedulerRouter);
  maintenanceRouter.use("/analytics", analyticsRouter);
  maintenanceRouter.use("/reports", reportsRouter);

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
