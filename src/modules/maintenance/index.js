import express from "express";
import { requireAuth } from "../../middleware/requireAuth.js";
import { requireRole } from "../../middleware/requireRole.js";
import { requireMaintenanceAccess } from "./access.js";
import { getNextWorkOrderNumber, formatWorkOrderNumber } from "./utils/numeracion.js";
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
import techniciansRouter from "./technicians/router.js";

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

      // Check if plant has maintenance access enabled
      const access = await prisma.mtPlantAccess.findUnique({
        where: { plantId },
      });

      return res.json({
        enabled: !!access?.enabled,
        role: req.user.role,
        plan: access?.plan ?? null,
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
  maintenanceRouter.use("/technicians", techniciansRouter);
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
        where: { plantId, deletedAt: null },
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

  maintenanceRouter.post("/reportar-falla", async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      const { assetId, title, description, priority = "HIGH" } = req.body;

      if (!title || !assetId) {
        return res.status(400).json({ error: "title and assetId are required" });
      }

      const number = await getNextWorkOrderNumber(plantId);

      const wo = await prisma.mtWorkOrder.create({
        data: {
          plantId,
          number,
          type: "CORRECTIVE",
          priority,
          assetId: parseInt(assetId),
          title,
          description: description || "",
          requestedBy: req.user.id,
          status: "REQUESTED",
        },
        select: {
          id: true,
          number: true,
          status: true,
          createdAt: true,
        },
      });

      return res.status(201).json({
        ...wo,
        number: formatWorkOrderNumber(wo.number),
        message: "Falla reportada exitosamente"
      });
    } catch (err) {
      console.error("[maintenance/reportar-falla POST]", err);
      return res.status(500).json({ error: "Error reporting failure" });
    }
  });

  app.use("/api/maintenance", maintenanceRouter);
}
