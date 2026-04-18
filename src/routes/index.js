// src/routes/index.js

// ========================
// ROUTERS BASE
// ========================
import authRouter from "./auth.js";
import usersRouter from "./users.js";
import techniciansRoutes from "./technicians.routes.js";
import emergencyActivities from "./emergencyActivities.js";
import conditionReportsRoutes from "./conditionReports.routes.js";
import notificationsRoutes from "./notifications.routes.js";
import adminLinksRoutes from "./admin.links.routes.js";
import adminOnboardingRoutes from "./admin.onboarding.routes.js";
import realtimeRoutes from "./realtime.routes.js";
import settingsRoutes from "./settings.routes.js";

// ✅ NUEVOS ROUTERS
import dashboardRoutes from "./dashboard.routes.js";
import alertsRoutes from "./alerts.routes.js";

// ========================
// IA
// ========================
import aiRouter from "../ia/aiRouter.js";

// ========================
// MIDDLEWARES
// ========================
import { requireAuth } from "../middleware/requireAuth.js";
import { requireRole } from "../middleware/requireRole.js";

// ========================
// SERVICES
// ========================
import { buildDashboardSummary } from "../dashboard/buildDashboardSummary.js";
import { toStartOfDaySafe } from "../utils/dates.js";

// ✅ IMPORT REAL (tu archivo)
import { getPredictiveMetrics } from "../dashboard/predictiveMetrics.js";

// ========================
// MOUNT ROUTES
// ========================
export function mountRoutes(app, { prisma }) {
  // ========================
  // AUTH (no requiere token)
  // ========================
  app.use("/api/auth", authRouter);

  // ========================
  // RUTAS PROTEGIDAS
  // ========================
  app.use("/api/users", requireAuth, usersRouter);
  app.use("/api/technicians", requireAuth, techniciansRoutes);

  app.use("/api", emergencyActivities({ prisma, auth: requireAuth }));
  app.use("/api", conditionReportsRoutes({ prisma, auth: requireAuth }));
  app.use("/api", notificationsRoutes({ prisma, auth: requireAuth }));
  app.use("/api", adminLinksRoutes({ prisma, auth: requireAuth }));
  app.use(
    "/api/admin",
    adminOnboardingRoutes({
      prisma,
      auth: requireAuth,
      requireRole,
    })
  );
  app.use("/api", realtimeRoutes({ auth: requireAuth }));

 // ✅ SETTINGS (GLOBAL)
app.use(
  "/api/settings",
  settingsRoutes({
    prisma,
    auth: requireAuth,
    requireRole,
  })
);

  // ========================
  // ✅ DASHBOARD (YA NO 404)
  // ========================
  app.use(
    "/api/dashboard",
    dashboardRoutes({
      prisma,
      auth: requireAuth,
      requireRole,
      buildDashboardSummary,
      toStartOfDaySafe,
      getPredictiveMetrics,
    })
  );

  // ========================
  // ✅ ALERTS (YA NO 404)
  // ========================
  app.use(
    "/api/alerts",
    alertsRoutes({
      prisma,
      auth: requireAuth,
      requireRole,
      toStartOfDaySafe,
    })
  );

  // ========================
  // IA (Resumen inteligente)
  // ========================
  app.use(
    "/api/ai",
    aiRouter({
      prisma,
      requireAuth,
      requireRole,
      buildDashboardSummary,
      toStartOfDaySafe,
    })
  );
}

// Soporte default export (opcional)
export default mountRoutes;
