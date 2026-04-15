    // index.js (o src/index.js segun tu backend)
    import express from "express";
    import dotenv from "dotenv";
    dotenv.config();
    import cors from "cors";
    import path from "path";
    import fs from "fs";
    import multer from "multer";
    import { toStartOfDaySafe } from "./utils/dates.js";
    import { ensureDir, getUploadsRoot, getUploadsRoots } from "./utils/uploads.js";
    import usersRouter from "./routes/users.js";
    import authRouter from "./routes/auth.js";
    import { requireAuth } from "./middleware/requireAuth.js";
    import techniciansRoutes from "./routes/technicians.routes.js";
    import emergencyActivitiesRoutes from "./routes/emergencyActivities.js";
    import conditionReportsRoutes from "./routes/conditionReports.routes.js";
    import notificationsRoutes from "./routes/notifications.routes.js";
    import { sseHub } from "./realtime/sseHub.js";
    import { notifyManagers, notifyTechnicianAssignee } from "./notifications/notify.js"; 
    import realtimeRoutes from "./routes/realtime.routes.js";
    import adminLinksRoutes from "./routes/admin.links.routes.js";
    import { buildDashboardSummary } from "./dashboard/buildDashboardSummary.js";
    import aiRouter from "./ia/aiRouter.js";
    import prisma from "./prisma.js";
    import { getPredictiveMetrics } from "./dashboard/predictiveMetrics.js";
    import analyticsRoutes from "./routes/analytics.routes.js";
    import settingsRoutes from "./routes/settings.routes.js";
    import { attachCurrentPlant } from "./middleware/currentPlant.js";
  import { requirePlantAccess } from "./middleware/requirePlantAccess.js";
  import plantsRoutes from "./routes/plants.routes.js";
  import { runWithTenant } from "./tenancy/tenantContext.js";
  import {
    sendConditionAlertEmail,
    sendCriticalActivityEmail,
    sendOverdueSummaryEmail,
  } from "./services/email/email.service.js";
  import { runOverdueSummaryJob, startOverdueSummaryScheduler } from "./jobs/overdueSummary.job.js";
  import uploadsRoutes from "./routes/uploads.routes.js";
  import exportRoutes from "./routes/export.js";
  import importRoutes from "./routes/import.js";
  import { destroyCloudinaryImage, normalizeImageInput } from "./lib/cloudinary.js";
  import { startMonthlyExecutiveReportScheduler } from "./jobs/monthlyExecutiveReport.job.js";
  import monthlyReportRoutes from "./routes/monthlyReport.routes.js";



    



    // OK En DEV: lee rol de header y trae technicianId del User real
    export const ROLES = {
      ADMIN: "ADMIN",
      SUPERVISOR: "SUPERVISOR",
      TECHNICIAN: "TECHNICIAN",
    };

    export async function devAttachUser(req, res, next) {
      try {
        // OK Si ya hay user (porque algun middleware anterior lo puso), no hagas nada
        if (req.user) return next();

        // OK Si viene JWT, NO simules usuario
        // (dejamos que requireAuth se encargue en las rutas protegidas)
        const auth = req.headers.authorization || "";
        if (auth.startsWith("Bearer ")) {
          return next();
        }

        // OK DEV: usa un user real de BD via header x-user-id (o fallback a 1)
        const userIdRaw = req.header("x-user-id") || req.header("X-User-Id");
        const userId =
          userIdRaw != null && String(userIdRaw).trim() !== "" ? Number(userIdRaw) : null;

        const finalUserId = Number.isFinite(userId) ? userId : 1;

        const dbUser = await prisma.user.findUnique({
          where: { id: finalUserId },
          select: {
            id: true,
            role: true,
            active: true,
            technicianId: true,
          },
        });

        if (!dbUser || dbUser.active === false) {
          return res.status(401).json({ error: "Usuario invalido/inactivo (DEV)" });
        }

        req.user = {
          id: dbUser.id,
          role: dbUser.role,
          technicianId: dbUser.technicianId ?? null,
        };

        return next();
      } catch (e) {
        console.error("devAttachUser error:", e);
        return res.status(500).json({ error: "Error attach user (DEV)" });
      }
    }

    // OK Requiere rol (RBAC)
    export function requireRole(allowed = []) {
      const allowedUpper = (allowed || []).map((r) => String(r).toUpperCase().trim());
      return (req, res, next) => {
        const role = String(req.user?.role || "").toUpperCase().trim();
        if (!allowedUpper.includes(role)) {
          return res.status(403).json({ error: "No autorizado" });
        }
        next();
      };
    }
  const app = express();
  app.set("etag", false);
  app.locals.prisma = prisma;

  const allowedOrigins = new Set([
    "http://localhost:5173",
    "http://192.168.1.69:5173",
    "https://lubriplan-frontend.vercel.app",
    "https://lubriplan.com",
    "https://www.lubriplan.com",
    "https://app.lubriplan.com",
  ]);

  const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);

    if (allowedOrigins.has(origin) || origin.endsWith(".vercel.app")) {
      return callback(null, true);
    }

    return callback(new Error(`Not allowed by CORS: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "Cache-Control",
    "cache-control",
    "Pragma",
    "pragma",
    "x-plant-id",
    "X-Plant-Id",
    "x-user-id",
    "X-User-Id",
  ],
};


  // 1) CORS primero
 app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("Surrogate-Control", "no-store");
    next();
  });

  // 2) Preflight
  app.options("*", cors(corsOptions), (req, res) => res.sendStatus(204));

  // 3) Body parsers
  app.use(express.json({ limit: "20mb" }));
  app.use(express.urlencoded({ extended: true, limit: "20mb" }));

  // 4) Logger DEV
  if (process.env.NODE_ENV !== "production") {
    app.use((req, res, next) => {
      const t0 = Date.now();
      res.on("finish", () => {
        if (!req.originalUrl.startsWith("/api")) return;
        console.log("ðŸŸ¦ IN", req.method, req.originalUrl, {
          status: res.statusCode,
          ms: Date.now() - t0,
        });
      });
      next();
    });
  }

  // 5) DEV attach user
  if (process.env.NODE_ENV !== "production") {
    app.use((req, res, next) => {
      if (req.method === "OPTIONS") return res.sendStatus(204);
      return devAttachUser(req, res, next);
    });
  }

  /* ========= ROUTES PUBLICAS ========= */
  app.use("/api/auth", authRouter);

  // 6) resolver planta actual DESPUES de tener usuario
  app.use(attachCurrentPlant);

  // 7) tenant context DESPUES de resolver currentPlantId
  app.use((req, res, next) => {
    runWithTenant({ plantId: req.currentPlantId || null }, () => next());
  });


  /* ========= ROUTES PROTEGIDAS ========= */
  app.use("/api/users", requireAuth, usersRouter);
  app.use("/api/technicians", requireAuth, techniciansRoutes);

  app.use("/api", emergencyActivitiesRoutes({ prisma, auth: requireAuth }));
  app.use(
    "/api",
    conditionReportsRoutes({
      prisma,
      auth: requireAuth,
      requirePlantAccess: requirePlantAccess(prisma),
    })
  );

  app.use("/api/export", exportRoutes);
  app.use("/api/import", importRoutes);
  console.log(">>> exportRoutes montado");

  app.use(
    "/api",
    notificationsRoutes({
      prisma,
      auth: requireAuth,
      requirePlantAccess: requirePlantAccess(prisma),
    })
  );
  app.use("/api", adminLinksRoutes({ prisma, auth: requireAuth }));
  app.use(
    "/api",
    settingsRoutes({
      prisma,
      auth: requireAuth,
      requireRole,
    })
  );

  app.use(
    "/api",
    monthlyReportRoutes({
      prisma,
      requireRole,
      buildDashboardSummary,
      toStartOfDaySafe,
    })
  );

  app.use("/api", analyticsRoutes({ prisma, auth: requireAuth }));

  app.use("/api", realtimeRoutes({ auth: requireAuth }));

  app.use("/api/ai", aiRouter({
    prisma,
    requireAuth,
    requireRole,
    buildDashboardSummary,
    toStartOfDaySafe,
  }));

  app.use(
    "/api",
    plantsRoutes({
      prisma,
      auth: requireAuth,
      requireRole,
    })
  );

  app.use("/api/uploads", uploadsRoutes({ auth: requireAuth }));



  // OK carpeta publica para archivos subidos
  const uploadsDir = ensureDir(getUploadsRoot());
  const uploadRoots = getUploadsRoots().map((dirPath) => ensureDir(dirPath));

  app.get("/uploads/*", (req, res, next) => {
    try {
      const requestPath = decodeURIComponent(String(req.path || "")).replace(/^\/uploads\//, "");
      const safePath = requestPath
        .replaceAll("\\", "/")
        .replaceAll("../", "")
        .replaceAll("..", "");
      const fileName = path.basename(safePath);

      const exactCandidates = uploadRoots.map((rootDir) => path.join(rootDir, safePath));
      for (const candidate of exactCandidates) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return res.sendFile(candidate);
        }
      }

      if (fileName) {
        for (const rootDir of uploadRoots) {
          const directCandidates = [
            path.join(rootDir, "routes", fileName),
            path.join(rootDir, "condition-reports", fileName),
          ];
          for (const candidate of directCandidates) {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
              return res.sendFile(candidate);
            }
          }
        }
      }
    } catch (uploadServeError) {
      console.error("uploads serve error:", uploadServeError);
    }
    return next();
  });

  for (const dirPath of uploadRoots) {
    app.use("/uploads", express.static(dirPath));
  }

  console.log("ðŸ”¥ BACKEND CORRECTO CARGADO");

  startMonthlyExecutiveReportScheduler({
    prisma,
    buildDashboardSummary,
    toStartOfDaySafe,
    baseUrl: process.env.APP_BASE_URL || "http://localhost:5173",
  });

  startOverdueSummaryScheduler({
    prisma,
    baseUrl: process.env.APP_BASE_URL || "http://localhost:5173",
  });

    /* ========= PROTECCION GLOBAL ========= */
    process.on("unhandledRejection", (reason) => {
      console.error("Unhandled Rejection:", reason);
    });
    process.on("uncaughtException", (err) => {
      console.error("Uncaught Exception:", err);
    });

    function getDashboardScope(req) {
      const role = String(req.user?.role || "").toUpperCase();
      const technicianId =
        req.user?.technicianId != null ? Number(req.user.technicianId) : null;

      return { role, technicianId };
    }

    function isAdmin(role) {
      return role === "ADMIN";
    }

    function isSupervisor(role) {
      return role === "SUPERVISOR";
    }

    function isTechnician(role) {
      return role === "TECHNICIAN";
    }

    // ===== AUTH HELPERS =====

    const getTechId = (req) => {
      const t = Number(req?.user?.technicianId);
      return Number.isFinite(t) ? t : null;
    };

  function requireManager(req, res, next) {
    try {
      const role = String(req.user?.role || "").toUpperCase();

      if (role === "ADMIN" || role === "SUPERVISOR") {
        return next();
      }

      return res.status(403).json({ error: "No autorizado" });
    } catch {
      return res.status(401).json({ error: "Token invalido" });
    }
  }

  function isCriticalCondition(c) {
    const s = String(c || "").toUpperCase().trim();
    return s === "CRITICO" || s === "CRITICO" || s === "CRITICAL";
  }


  function normalizeRouteMethod(value) {
    return String(value || "")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
  }

  function normalizeRouteName(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // quita acentos
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

    /* ========= HELPERS ========= */
    function parseDateOrNull(value) {
    if (!value) return null;

    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return new Date(
        value.getFullYear(),
        value.getMonth(),
        value.getDate(),
        12, 0, 0, 0
      );
    }

    const s = String(value).trim();
    if (!s) return null;

    const onlyDate = s.slice(0, 10);
    const [y, m, d] = onlyDate.split("-").map(Number);

    if (!y || !m || !d) return null;

    return new Date(y, m - 1, d, 12, 0, 0, 0);
  }

    function startOfDay(value) {
    const d = parseDateOrNull(value);
    if (!d) return null;

    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  }
  const toStartOfDay = (value) => startOfDay(value);

    const endOfDay = (d) => {
      const dt = d instanceof Date ? d : new Date(d);
      if (Number.isNaN(dt.getTime())) return null;
      const out = new Date(dt);
      out.setHours(23, 59, 59, 999);
      return out;
    };

    // OK evita desfase UTC/local guardando scheduledAt a medio dia
    const toSafeNoon = (d) => {
      const dt = d instanceof Date ? d : new Date(d);
      if (Number.isNaN(dt.getTime())) return null;
      const out = new Date(dt);
      out.setHours(12, 0, 0, 0);
      return out;
    };

    // OK parsea YYYY-MM-DD como local (no UTC)
    const parseDateOnlyLocal = (ymd) => {
  if (!ymd) return null;
  const [y, m, d] = String(ymd).slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 12, 0, 0, 0);
};

    const dateKeyInTimezone = (value, timezone = "America/Mexico_City") => {
  if (!value) return "";
  const dt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dt.getTime())) return "";

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(dt);

  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
};

    const convertUnits = (value, from, to) => {
      if (value == null) return null;
      const v = Number(value);
      if (!Number.isFinite(v) || v < 0) return null;

      const f = String(from || "").toLowerCase().trim();
      const t = String(to || "").toLowerCase().trim();

      if (f === t) return v;

      // Volumen
      const vol = { ml: 1, l: 1000 };
      if (vol[f] && vol[t]) return (v * vol[f]) / vol[t];

      // Peso
      const mass = { g: 1, kg: 1000 };
      if (mass[f] && mass[t]) return (v * mass[f]) / mass[t];

      // NO convertir peso <-> volumen
      return null;
    };
    
    const includeExecPremium = {
    route: {
      include: {
        equipment: true,
        lubricant: true,
      },
    },
    equipment: true,      // OK clave para MANUAL
    technician: true,
    lubricantMovements: {
      include: {
        lubricant: { select: { id: true, name: true, code: true, unit: true } },
      },
      orderBy: { createdAt: "desc" },
    },
  };

  function getLastDayOfMonth(year, monthIndexZeroBased) {
    return new Date(year, monthIndexZeroBased + 1, 0).getDate();
  }

  function addMonthsClamped(baseDate, monthsToAdd, anchorDay) {
    const base = startOfDay(baseDate);
    const y = base.getFullYear();
    const m = base.getMonth();

    const targetMonthDate = new Date(y, m + monthsToAdd, 1);
    const targetYear = targetMonthDate.getFullYear();
    const targetMonth = targetMonthDate.getMonth();

    const desiredDay = Number(anchorDay) || base.getDate();
    const lastDay = getLastDayOfMonth(targetYear, targetMonth);
    const finalDay = Math.min(desiredDay, lastDay);

    return new Date(targetYear, targetMonth, finalDay, 0, 0, 0, 0);
  }

  function getIsoWeekday(date) {
    const jsDay = date.getDay(); // 0 domingo ... 6 sabado
    return jsDay === 0 ? 7 : jsDay;
  }

  function getNextWeeklySelectedDate(fromDate, weeklyDays = []) {
    const base = startOfDay(fromDate);
    const validDays = Array.from(new Set((weeklyDays || []).map(Number)))
      .filter((n) => n >= 1 && n <= 7)
      .sort((a, b) => a - b);

    if (!validDays.length) return null;

    for (let i = 1; i <= 14; i += 1) {
      const candidate = new Date(base);
      candidate.setDate(candidate.getDate() + i);

      const iso = getIsoWeekday(candidate);
      if (validDays.includes(iso)) {
        candidate.setHours(0, 0, 0, 0);
        return candidate;
      }
    }

    return null;
  }

  function resolveNextRouteDate({
    lastDate,
    nextDate,
    frequencyDays,
    frequencyType,
    weeklyDays,
    monthlyAnchorDay,
  }) {
    const parsedNext = parseDateOrNull(nextDate);
    if (parsedNext) return startOfDay(parsedNext);

    const parsedLast = parseDateOrNull(lastDate);
    if (!parsedLast) return null;

    const type = String(frequencyType || "").toUpperCase().trim();

    if (type === "WEEKLY" && Array.isArray(weeklyDays) && weeklyDays.length > 0) {
      return getNextWeeklySelectedDate(parsedLast, weeklyDays);
    }

    if (type === "MONTHLY") {
      return addMonthsClamped(parsedLast, 1, monthlyAnchorDay || parsedLast.getDate());
    }

    if (type === "BIMONTHLY") {
      return addMonthsClamped(parsedLast, 2, monthlyAnchorDay || parsedLast.getDate());
    }

    if (type === "QUARTERLY") {
      return addMonthsClamped(parsedLast, 4, monthlyAnchorDay || parsedLast.getDate());
    }

    if (type === "SEMIANNUAL") {
      return addMonthsClamped(parsedLast, 6, monthlyAnchorDay || parsedLast.getDate());
    }

    if (type === "ANNUAL") {
      return addMonthsClamped(parsedLast, 12, monthlyAnchorDay || parsedLast.getDate());
    }

    const days = Number(frequencyDays);
    if (Number.isFinite(days) && days > 0) {
      const d = startOfDay(parsedLast);
      d.setDate(d.getDate() + days);
      return d;
    }

    return null;
  }

    // =========================
    // HELPERS: unidades a "base"
    // base aceite: ml
    // base grasa: g
    // =========================
    function toBaseQuantity(qty, unit) {
      const n = Number(qty || 0);
      const u = String(unit || "").toLowerCase().trim();
      if (!Number.isFinite(n)) return 0;

      // ml / L
      if (u === "ml") return n;
      if (u === "l" || u === "lt" || u === "litro" || u === "litros") return n * 1000;

      // g / kg
      if (u === "g" || u === "gr" || u === "gramo" || u === "gramos") return n;
      if (u === "kg" || u === "kilogramo" || u === "kilogramos") return n * 1000;

      // fallback
      return n;
    }

    function safeNum(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function round2(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 100) / 100;
  }

  function normalizeUnit(u) {
    const s = String(u || "").trim();
    if (!s) return "";
    if (s.toUpperCase() === "BOMBAZOS") return "BOMBAZOS";
    if (s === "L") return "L";
    return s.toLowerCase();
  }

  function normalizeKind(kindRaw) {
    const s = String(kindRaw || "").trim().toUpperCase();

    if (s.includes("ACEITE")) return "ACEITE";
    if (s.includes("GRASA")) return "GRASA";

    return "OTRO";
  }

  function inferKindFromUnits(...units) {
    for (const raw of units) {
      const unit = normalizeUnit(raw);
      if (!unit) continue;
      if (["ml", "l"].includes(unit)) return "ACEITE";
      if (["g", "gr", "kg"].includes(unit)) return "GRASA";
    }
    return "OTRO";
  }

  function resolveAnalyticsKind(source) {
    const explicitKind =
      [
        source?.lubricantType,
        source?.lubricant?.type,
        source?.lubricant?.name,
        source?.lubricantName,
      ]
        .map((value) => normalizeKind(value))
        .find((value) => value && value !== "OTRO") || "OTRO";

    if (explicitKind !== "OTRO") return explicitKind;

    return inferKindFromUnits(
      source?.lubricant?.unit,
      source?.convertedUnit,
      source?.inputUnit,
      source?.unit
    );
  }

  function executionMatchesAnalyticsFilters(execution, { kind = "OTRO", lubricantId = null } = {}) {
    const route = execution?.route || null;
    const movement = Array.isArray(execution?.lubricantMovements)
      ? execution.lubricantMovements[0] || null
      : null;
    const manualSource = {
      lubricant: movement?.lubricant || null,
      inputUnit: movement?.inputUnit || execution?.usedInputUnit || "",
      convertedUnit: movement?.convertedUnit || execution?.usedConvertedUnit || "",
    };

    if (lubricantId != null) {
      const routeLubricantId =
        route?.lubricantId != null ? Number(route.lubricantId) : null;
      const movementLubricantId =
        movement?.lubricantId != null ? Number(movement.lubricantId) : null;
      if (routeLubricantId !== Number(lubricantId) && movementLubricantId !== Number(lubricantId)) {
        return false;
      }
    }

    if (kind && kind !== "OTRO") {
      const routeKind = resolveAnalyticsKind(route);
      const fallbackKind = resolveAnalyticsKind(manualSource);
      if (routeKind !== kind && fallbackKind !== kind) return false;
    }

    return true;
  }

  function summarizeEquipmentAssignedTechnician(routes) {
    const stats = new Map();

    for (const route of Array.isArray(routes) ? routes : []) {
      const technician = route?.technician || null;
      const technicianId =
        technician?.id != null
          ? Number(technician.id)
          : route?.technicianId != null
          ? Number(route.technicianId)
          : null;

      if (!Number.isFinite(technicianId)) continue;

      if (!stats.has(technicianId)) {
        stats.set(technicianId, {
          technician: technician || { id: technicianId, name: "Tecnico", code: "" },
          count: 0,
        });
      }

      const row = stats.get(technicianId);
      row.count += 1;
      if (technician) row.technician = technician;
    }

    const ranked = Array.from(stats.values()).sort((a, b) => b.count - a.count);
    if (!ranked.length) return null;

    const top = ranked[0];
    const distinctCount = ranked.length;

    return {
      ...top.technician,
      assignedRoutesCount: top.count,
      assignmentMode: distinctCount === 1 ? "CONSENSUS" : "MIXED",
    };
  }

  /**
   * Devuelve unidad base esperada por tipo:
   * - ACEITE => ml
   * - GRASA  => g
   */
  function getBaseUnitByKind(kind) {
    if (kind === "ACEITE") return "ml";
    if (kind === "GRASA") return "g";
    return "";
  }

  function getPreferredAnalyticsDisplayUnit(kind) {
    if (kind === "ACEITE") return "L";
    if (kind === "GRASA") return "kg";
    return "";
  }

  function formatAnalyticsDisplayLabel(quantity, baseUnit, kind) {
    const qty = Number(quantity);
    if (!Number.isFinite(qty)) return null;

    const preferredUnit = getPreferredAnalyticsDisplayUnit(kind);
    if (preferredUnit && baseUnit) {
      const converted = convertSimpleUnits(qty, baseUnit, preferredUnit);
      if (converted != null) {
        return `${round2(converted)} ${preferredUnit}`;
      }
    }

    return baseUnit ? `${round2(qty)} ${baseUnit}` : `${round2(qty)}`;
  }

  /**
   * Convierte unidades homogeneas:
   * volumen: ml <-> l
   * masa: g <-> kg
   */
  function convertSimpleUnits(value, fromUnit, toUnit) {
    const qty = Number(value);
    if (!Number.isFinite(qty)) return null;

    const from = normalizeUnit(fromUnit);
    const to = normalizeUnit(toUnit);

    if (!from || !to) return null;
    if (from === to) return qty;

    // volumen
    if (from === "ml" && to === "L") return qty / 1000;
    if (from === "L" && to === "ml") return qty * 1000;
    if (from === "ml" && to === "l") return qty / 1000;
    if (from === "l" && to === "ml") return qty * 1000;

    // masa
    if (from === "g" && to === "kg") return qty / 1000;
    if (from === "kg" && to === "g") return qty * 1000;

    // compatibilidad L/l
    if (from === "L" && to === "l") return qty;
    if (from === "l" && to === "L") return qty;

    return null;
  }

  /**
   * Para analytics:
   * prioridad:
   * 1) campos premium guardados en execution:
   *    usedInputQuantity, usedInputUnit, usedConvertedQuantity, usedConvertedUnit
   * 2) fallback a usedQuantity + route.unit
   *
   * Retorna:
   * {
   *   inputQuantity,
   *   inputUnit,
   *   convertedQuantity,
   *   convertedUnit,
   *   comparableBaseQuantity,
   *   comparableBaseUnit
   * }
   */
  function resolveExecutionConsumptionForAnalytics(execution) {
    const route = execution?.route || null;
    const movement = Array.isArray(execution?.lubricantMovements)
      ? execution.lubricantMovements[0] || null
      : null;
    const fallbackSource = {
      lubricant: movement?.lubricant || null,
      inputUnit: movement?.inputUnit || execution?.usedInputUnit || "",
      convertedUnit: movement?.convertedUnit || execution?.usedConvertedUnit || "",
    };
    const kind = resolveAnalyticsKind(route) !== "OTRO"
      ? resolveAnalyticsKind(route)
      : resolveAnalyticsKind(fallbackSource);
    const baseUnit = getBaseUnitByKind(kind);

    const inputQty =
      execution?.usedInputQuantity != null
        ? Number(execution.usedInputQuantity)
        : execution?.usedQuantity != null
        ? Number(execution.usedQuantity)
        : null;

    const inputUnitRaw =
      execution?.usedInputUnit ||
      route?.unit ||
      "";

    const convertedQty =
      execution?.usedConvertedQuantity != null
        ? Number(execution.usedConvertedQuantity)
        : null;

    const convertedUnitRaw =
      execution?.usedConvertedUnit ||
      "";

    let finalInputQuantity = Number.isFinite(inputQty) ? inputQty : null;
    let finalInputUnit = normalizeUnit(inputUnitRaw || "");

    let finalConvertedQuantity = Number.isFinite(convertedQty) ? convertedQty : null;
    let finalConvertedUnit = normalizeUnit(convertedUnitRaw || "");

    // fallback si no existen campos premium
    if (finalConvertedQuantity == null && finalInputQuantity != null) {
      if (finalInputUnit && finalInputUnit !== "BOMBAZOS") {
        finalConvertedQuantity = finalInputQuantity;
        finalConvertedUnit = finalInputUnit;
      }
    }

    // comparable value: lo que usaremos para ranking y percentiles
    let comparableBaseQuantity = null;
    let comparableBaseUnit = baseUnit || finalConvertedUnit || finalInputUnit || "";

    if (finalConvertedQuantity != null) {
      if (baseUnit && finalConvertedUnit) {
        const toBase = convertSimpleUnits(finalConvertedQuantity, finalConvertedUnit, baseUnit);
        comparableBaseQuantity = toBase != null ? toBase : finalConvertedQuantity;
        comparableBaseUnit = toBase != null ? baseUnit : finalConvertedUnit;
      } else {
        comparableBaseQuantity = finalConvertedQuantity;
        comparableBaseUnit = finalConvertedUnit || comparableBaseUnit;
      }
    } else if (finalInputQuantity != null && finalInputUnit && finalInputUnit !== "BOMBAZOS") {
      if (baseUnit) {
        const toBase = convertSimpleUnits(finalInputQuantity, finalInputUnit, baseUnit);
        comparableBaseQuantity = toBase != null ? toBase : finalInputQuantity;
        comparableBaseUnit = toBase != null ? baseUnit : finalInputUnit;
      } else {
        comparableBaseQuantity = finalInputQuantity;
        comparableBaseUnit = finalInputUnit;
      }
    }

    return {
      kind,
      inputQuantity: finalInputQuantity,
      inputUnit: finalInputUnit,
      convertedQuantity: finalConvertedQuantity,
      convertedUnit: finalConvertedUnit,
      comparableBaseQuantity,
      comparableBaseUnit,
    };
  }

    // Normaliza types de movimiento (acepta IN/OUT/ADJUST y ENTRADA/SALIDA/AJUSTE)
    const normalizeMovementType = (raw) => {
      const v = String(raw || "").toUpperCase().trim();
      if (v === "IN" || v === "ENTRADA") return "IN";
      if (v === "OUT" || v === "SALIDA") return "OUT";
      if (v === "ADJUST" || v === "AJUSTE") return "ADJUST";
      return null;
    };

    // =========================
    // HELPERS: filtros analytics
    // =========================
    function kindWhere(kind) {
      const K = String(kind || "ALL").toUpperCase();
      if (K === "ALL") return {};

      const greaseUnitOr = [
        { lubricant: { unit: { equals: "g", mode: "insensitive" } } },
        { lubricant: { unit: { equals: "gr", mode: "insensitive" } } },
        { lubricant: { unit: { equals: "gramo", mode: "insensitive" } } },
        { lubricant: { unit: { equals: "gramos", mode: "insensitive" } } },
        { lubricant: { unit: { equals: "kg", mode: "insensitive" } } },
        { lubricant: { unit: { equals: "kilogramo", mode: "insensitive" } } },
        { lubricant: { unit: { equals: "kilogramos", mode: "insensitive" } } },
      ];

      const oilUnitOr = [
        { lubricant: { unit: { equals: "ml", mode: "insensitive" } } },
        { lubricant: { unit: { equals: "l", mode: "insensitive" } } },
        { lubricant: { unit: { equals: "lt", mode: "insensitive" } } },
        { lubricant: { unit: { equals: "litro", mode: "insensitive" } } },
        { lubricant: { unit: { equals: "litros", mode: "insensitive" } } },
      ];

      if (K === "GRASA") {
        return {
          OR: [{ lubricant: { type: { contains: "grasa", mode: "insensitive" } } }, ...greaseUnitOr],
        };
      }

      return {
        OR: [{ lubricant: { type: { contains: "aceite", mode: "insensitive" } } }, ...oilUnitOr],
      };
    }

    function maybeLubricantIdWhere(lubricantIdRaw) {
      const raw = lubricantIdRaw;
      if (raw == null) return {};
      const s = String(raw).trim();
      if (!s) return {};
      const id = Number(s);
      if (!Number.isFinite(id) || id <= 0) return {};
      return { lubricantId: id };
    }

  /* ========= TEST ========= */
  app.get("/test", (req, res) => {
    res.json({ ok: true });
  });

  app.get("/me", requireAuth, async (req, res) => {
    res.json({ ok: true, user: req.user });
  });



  // =========================
  // SSE: Real-time stream
  // GET /realtime/stream
  // =========================
  const sseClients = new Map(); // userId -> Set(res)

  function sseSend(res, event, data) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  function broadcastToRole(roles = [], event, payload) {
    const target = new Set((roles || []).map(r => String(r).toUpperCase()));

    for (const [userId, set] of sseClients.entries()) {
      for (const res of set) {
        const role = String(res.locals?.userRole || "").toUpperCase();
        if (!target.size || target.has(role)) {
          sseSend(res, event, payload);
        }
      }
    }
  }

  // OK SSE: Real-time stream
// GET /api/realtime/stream?token=JWT   (EventSource NO manda headers, por eso permitimos token en query)
app.get(
  "/api/realtime/stream",
  (req, _res, next) => {
    try {
      // OK Permitir token por query SOLO para SSE
      // Si ya viene Authorization, lo respetamos.
      const qtoken = req.query?.token;
      const hasAuthHeader = String(req.headers.authorization || "").startsWith("Bearer ");

      if (!hasAuthHeader && qtoken && String(qtoken).trim() !== "") {
        req.headers.authorization = `Bearer ${String(qtoken).trim()}`;
      }

      return next();
    } catch (e) {
      return next(e);
    }
  },
  requireAuth,
  (req, res) => {
    // headers SSE
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    // (opcional) si usas Nginx/Proxy:
    res.setHeader("X-Accel-Buffering", "no");

    res.flushHeaders?.();

    const userId = req.user?.id ?? "anon";
    res.locals.userRole = req.user?.role || "";

    // registra cliente
    if (!sseClients.has(userId)) sseClients.set(userId, new Set());
    sseClients.get(userId).add(res);

    // hello
    sseSend(res, "hello", {
      ok: true,
      userId,
      role: res.locals.userRole,
      at: new Date().toISOString(),
    });

    // keep-alive
    const ping = setInterval(() => {
      res.write(`event: ping\ndata: {}\n\n`);
    }, 25000);

    req.on("close", () => {
      clearInterval(ping);
      const set = sseClients.get(userId);
      if (set) {
        set.delete(res);
        if (set.size === 0) sseClients.delete(userId);
      }
    });
  }
);

// OK exporta helpers para usarlos donde disparas eventos
export const realtime = {
  broadcastToRole,
};

app.get("/api/dashboard/summary", requireAuth, async (req, res) => {
  try {
    const month = String(req.query.month || "").trim();
    const days = Number(req.query.days ?? 30);

    const plantId = req.currentPlantId;
    if (!plantId) {
      return res.status(400).json({ error: "PLANT_REQUIRED" });
    }

    const payload = await buildDashboardSummary({
      prisma,
      user: req.user,
      month,
      days,
      plantId,
      toStartOfDaySafe,
    });

    return res.json(payload);
  } catch (e) {
    console.error("dashboard summary error:", e);
    res.status(500).json({ error: "Error dashboard summary" });
  }
});

  // -------------------------
// GET /dashboard/alerts?month=YYYY-MM
// - ADMIN y SUPERVISOR
// - MULTI-PLANTA
// -------------------------
app.get("/api/dashboard/alerts", requireAuth, requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
  try {
    const role = String(req.user?.role || "").toUpperCase();

    const plantId = req.currentPlantId;
    if (!plantId) {
      return res.status(400).json({ error: "PLANT_REQUIRED" });
    }

    const month = String(req.query.month || "").trim(); // "2026-01"
    const now = new Date();

    // si no viene month, usa el mes actual
    const [y, m] = month ? month.split("-").map(Number) : [now.getFullYear(), now.getMonth() + 1];

    const year = Number.isFinite(y) ? y : now.getFullYear();
    const monthNum = Number.isFinite(m) ? m : now.getMonth() + 1;

    const from = new Date(year, monthNum - 1, 1, 0, 0, 0, 0);
    const to = new Date(year, monthNum, 0, 23, 59, 59, 999);
    const plant = await prisma.plant.findUnique({
      where: { id: plantId },
      select: { timezone: true },
    });
    const plantTimezone = String(plant?.timezone || "America/Mexico_City");
    const todayKey = dateKeyInTimezone(new Date(), plantTimezone);

    const openExecutionsInMonth = await prisma.execution.findMany({
      where: {
        plantId,
        scheduledAt: { gte: from, lte: to },
        status: { not: "COMPLETED" },
      },
      select: {
        scheduledAt: true,
      },
    });

    // 1) Actividades vencidas EN EL MES (no completadas y con día local anterior a hoy)
    const overdueActivities = (openExecutionsInMonth || []).filter((ex) => {
      const scheduledKey = dateKeyInTimezone(ex?.scheduledAt, plantTimezone);
      return Boolean(scheduledKey) && Boolean(todayKey) && scheduledKey < todayKey;
    }).length;

    // 2) Pendientes sin tecnico EN EL MES (solo status PENDING)
    const unassignedPending = await prisma.execution.count({
      where: {
        plantId,
        scheduledAt: { gte: from, lte: to },
        status: "PENDING",
        technicianId: null,
      },
    });

    // 3) Bajo stock (solo planta actual)
    const lubs = await prisma.lubricant.findMany({
      where: {
        plantId,
        minStock: { not: null },
      },
      select: { stock: true, minStock: true },
    });

    let lowStockCount = 0;
    for (const l of lubs) {
      const min = Number(l.minStock);
      const stock = Number(l.stock);
      if (Number.isFinite(min) && Number.isFinite(stock) && stock <= min) lowStockCount += 1;
    }

    // 4) Condicion MALA EN EL MES (solo ejecutadas) OK SOLO "MALO"
    const badConditionCount = await prisma.execution.count({
      where: {
        plantId,
        status: "COMPLETED",
        condition: "MALO",
        executedAt: { gte: from, lte: to },
      },
    });

    // 4b) OK Ejecuciones CRITICAS EN EL MES (solo ejecutadas)
    const criticalExecutions = await prisma.execution.count({
      where: {
        plantId,
        status: "COMPLETED",
        condition: "CRITICO",
        executedAt: { gte: from, lte: to },
      },
    });

    // 5) Equipos sin rutas (solo planta actual)
    const equipmentWithoutRoutes = await prisma.equipment.count({
      where: {
        plantId,
        routes: { none: {} },
      },
    });

    // 6) Consumo fuera de rango EN EL MES (+/-30%)
    const outOfRangeExecs = await prisma.execution.findMany({
      where: {
        plantId,
        status: "COMPLETED",
        executedAt: { gte: from, lte: to },
        usedQuantity: { not: null },
        route: { quantity: { gt: 0 } },
      },
      select: {
        usedQuantity: true,
        route: { select: { quantity: true, points: true, instructions: true } },
      },
    });

    const TOL_PCT = 0.30; // +/-30%
    let outOfRangeConsumption = 0;

    for (const ex of outOfRangeExecs) {
      const used = Number(ex.usedQuantity);
      const qty = Number(ex?.route?.quantity);
      const pts = Math.max(1, Number(ex?.route?.points ?? 1));
      const instr = String(ex?.route?.instructions || "");
      const isAdvanced = instr.includes("PUNTOS (AVANZADO)");

      if (!Number.isFinite(used) || !Number.isFinite(qty) || qty <= 0) continue;

      const expectedTotal = qty * pts;
      const actualTotal = isAdvanced ? used : used * pts;

      const deviation = Math.abs(actualTotal - expectedTotal) / expectedTotal;
      if (deviation > TOL_PCT) outOfRangeConsumption += 1;
    }

    // 7) OK Reportes de condicion abiertos (OPEN / IN_PROGRESS) EN EL MES
    const conditionReportsOpen = await prisma.conditionReport.count({
      where: {
        plantId,
        detectedAt: { gte: from, lte: to },
        status: { in: ["OPEN", "IN_PROGRESS"] },
      },
    });

    const total =
      overdueActivities +
      lowStockCount +
      unassignedPending +
      badConditionCount +
      criticalExecutions +
      equipmentWithoutRoutes +
      outOfRangeConsumption +
      conditionReportsOpen;

    return res.json({
      ok: true,
      updatedAt: new Date().toISOString(),
      role,
      plantId,
      month: `${year}-${String(monthNum).padStart(2, "0")}`,
      range: { from: from.toISOString(), to: to.toISOString() },
      alerts: {
        overdueActivities,
        lowStockCount,
        unassignedPending,
        badConditionCount,
        criticalExecutions,
        equipmentWithoutRoutes,
        outOfRangeConsumption,
        conditionReportsOpen,
      },
      total,
    });
  } catch (e) {
    console.error("Error dashboard alerts:", e);
    res.status(500).json({ error: "Error dashboard alerts" });
  }
});

 // -------------------------
// GET /api/dashboard/priority-queue?month=YYYY-MM
// ADMIN / SUPERVISOR
// Devuelve una cola unificada y accionable
// -------------------------
app.get(
  "/api/dashboard/priority-queue",
  requireAuth,
  requireRole(["ADMIN", "SUPERVISOR"]),
  async (req, res) => {
    try {
      const role = String(req.user?.role || "").toUpperCase();

      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const month = String(req.query.month || "").trim(); // "YYYY-MM"
      const now = new Date();
      const [y, m] = month ? month.split("-").map(Number) : [now.getFullYear(), now.getMonth() + 1];
      const year = Number.isFinite(y) ? y : now.getFullYear();
      const monthNum = Number.isFinite(m) ? m : now.getMonth() + 1;

      const from = new Date(year, monthNum - 1, 1, 0, 0, 0, 0);
      const to = new Date(year, monthNum, 0, 23, 59, 59, 999);
      const plant = await prisma.plant.findUnique({
        where: { id: plantId },
        select: { timezone: true },
      });
      const plantTimezone = String(plant?.timezone || "America/Mexico_City");
      const todayKey = dateKeyInTimezone(new Date(), plantTimezone);

      const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
      const sevFromScore = (score) =>
        score >= 90 ? "CRITICAL" : score >= 70 ? "HIGH" : score >= 45 ? "MED" : "LOW";
      const add = (arr, item) => arr.push(item);

      // =========================
      // 1) Operativas del mes
      // =========================

      // A) Overdue del mes
      const openExecsInMonth = await prisma.execution.findMany({
        where: {
          plantId,
          scheduledAt: { gte: from, lte: to },
          status: { not: "COMPLETED" },
        },
        select: {
          id: true,
          scheduledAt: true,
          status: true,
          technicianId: true,
          route: {
            select: {
              name: true,
              equipment: {
                select: { id: true, name: true, code: true, location: true, criticality: true },
              },
            },
          },
          equipment: {
            select: { id: true, name: true, code: true, location: true, criticality: true },
          },
        },
        orderBy: { scheduledAt: "asc" },
        take: 25,
      });

      const overdueExecs = (openExecsInMonth || []).filter((ex) => {
        const scheduledKey = dateKeyInTimezone(ex?.scheduledAt, plantTimezone);
        return Boolean(scheduledKey) && Boolean(todayKey) && scheduledKey < todayKey;
      });

      // B) Sin tecnico
      const unassignedExecs = (openExecsInMonth || []).filter((ex) => ex?.technicianId == null);

      // C) Reportes OPEN
      const openReports = await prisma.conditionReport.findMany({
        where: {
          plantId,
          status: "OPEN",
        },
        select: {
          id: true,
          detectedAt: true,
          condition: true,
          category: true,
          equipment: {
            select: { id: true, name: true, code: true, location: true, criticality: true },
          },
        },
        orderBy: { detectedAt: "desc" },
        take: 20,
      });

      // D) Bajo stock real
      const lowStockRaw = await prisma.lubricant.findMany({
        where: {
          plantId,
          minStock: { not: null },
        },
        select: {
          id: true,
          name: true,
          unit: true,
          stock: true,
          minStock: true,
          code: true,
        },
        take: 50,
      });

      const lowStockLubricants = lowStockRaw.filter((l) => {
        const stock = Number(l.stock || 0);
        const min = Number(l.minStock);
        return Number.isFinite(min) && stock <= min;
      });

      // =========================
      // 2) Predictivo fisico
      // =========================
      const ym = `${year}-${String(monthNum).padStart(2, "0")}`;

      const metrics = await getPredictiveMetrics({
        prisma,
        toStartOfDaySafe,
        plantId,
        month: ym,
        histDays: 90,
        shortWindowDays: 14,
        now,
      });

      const dteTop = (metrics?.lubricantDaysToEmptyTop || []).filter(
        (x) => String(x?.risk || "").toUpperCase() !== "LOW"
      );

      const anomaliesTop = (metrics?.equipmentConsumptionAnomaliesTop || []).filter(
        (x) => String(x?.risk || "").toUpperCase() !== "LOW"
      );

      // =========================
      // 2b) Reincidencia MALO/CRITICO
      // =========================
      const badEvents = await prisma.execution.findMany({
        where: {
          plantId,
          status: "COMPLETED",
          executedAt: { gte: from, lte: to },
          condition: { in: ["MALO", "CRITICO"] },
        },
        select: {
          executedAt: true,
          condition: true,
          route: {
            select: {
              equipmentId: true,
              equipment: {
                select: { id: true, name: true, code: true, location: true, criticality: true },
              },
            },
          },
          equipment: {
            select: { id: true, name: true, code: true, location: true, criticality: true },
          },
        },
      });

      const badByEq = new Map();
      for (const ex of badEvents || []) {
        const eq = ex?.equipment || ex?.route?.equipment;
        const eqId = eq?.id ?? ex?.route?.equipmentId;
        if (eqId == null) continue;

        const t = ex?.executedAt ? new Date(ex.executedAt).getTime() : NaN;
        if (!Number.isFinite(t)) continue;

        if (!badByEq.has(eqId)) badByEq.set(eqId, { total: 0, crit: 0, lastAt: null, eq });
        const s = badByEq.get(eqId);

        s.total += 1;
        if (String(ex.condition).toUpperCase() === "CRITICO") s.crit += 1;
        if (!s.lastAt || t > new Date(s.lastAt).getTime()) s.lastAt = ex.executedAt;
      }

      const repeatedFailures = [];
      for (const [equipmentId, s] of badByEq.entries()) {
        const score = s.total + s.crit * 1.5;
        let risk = "LOW";
        if (s.total >= 3 || s.crit >= 2) risk = "HIGH";
        else if (s.total >= 2 || s.crit >= 1) risk = "MED";

        if (risk !== "LOW") {
          repeatedFailures.push({
            equipmentId,
            equipment: s.eq || null,
            badTotal: s.total,
            critTotal: s.crit,
            lastBadAt: s.lastAt,
            score: Number(score.toFixed(2)),
            risk,
          });
        }
      }

      repeatedFailures.sort((a, b) => (b.score - a.score) || (b.badTotal - a.badTotal));

      // =========================
      // 2c) Critico + sin tecnico + vencido
      // =========================
      const criticalUnassignedOverdue = await prisma.execution.findMany({
        where: {
          plantId,
          scheduledAt: { gte: from, lte: to },
          status: { not: "COMPLETED" },
          technicianId: null,
          route: {
            equipment: {
              criticality: { in: ["ALTA", "CRITICA", "CRITICA"] },
            },
          },
        },
        select: {
          id: true,
          scheduledAt: true,
          status: true,
          route: {
            select: {
              name: true,
              equipment: {
                select: { id: true, name: true, code: true, location: true, criticality: true },
              },
            },
          },
        },
        orderBy: { scheduledAt: "asc" },
        take: 20,
      });
      const criticalUnassignedOverdueSafe = (criticalUnassignedOverdue || []).filter((ex) => {
        const scheduledKey = dateKeyInTimezone(ex?.scheduledAt, plantTimezone);
        return Boolean(scheduledKey) && Boolean(todayKey) && scheduledKey < todayKey;
      });

      // =========================
      // 3) Priority queue
      // =========================
      const queue = [];
      const equipmentLabel = (eq) => {
        if (!eq) return "";
        const name = String(eq?.name || "").trim();
        const code = String(eq?.code || "").trim();
        if (name && code) return `${name} (${code})`;
        return name || code || "";
      };

      for (const ex of overdueExecs || []) {
        const eq = ex?.equipment || ex?.route?.equipment || null;
        const crit = String(eq?.criticality || "").toUpperCase();
        const isCritical = ["ALTA", "CRITICA", "CRITICA"].includes(crit);

        const scheduledKey = dateKeyInTimezone(ex?.scheduledAt, plantTimezone);
        const daysLate =
          scheduledKey && todayKey
            ? Math.max(
                0,
                Math.floor(
                  (new Date(`${todayKey}T00:00:00`).getTime() -
                    new Date(`${scheduledKey}T00:00:00`).getTime()) /
                    86400000
                )
              )
            : 0;

        let score = 55 + clamp(daysLate * 6, 0, 30);
        if (isCritical) score += 20;
        if (ex?.technicianId == null) score += 10;
        score = clamp(score, 0, 100);

        add(queue, {
          key: `EXEC_OVERDUE:${ex.id}`,
          type: "EXEC_OVERDUE",
          severity: sevFromScore(score),
          score,
          title: `Actividad vencida${isCritical ? " (crí­tica)" : ""}`,
          reason: `Programada ${daysLate} día(s) atrás${equipmentLabel(eq) ? ` · ${equipmentLabel(eq)}` : ""}`,
          suggestedOwner: ex?.technicianId ? "TECHNICIAN" : "SUPERVISOR",
          entity: {
            executionId: ex.id,
            equipmentId: eq?.id ?? null,
          },
          link: `/activities?status=OVERDUE&month=${ym}`,
        });
      }

      for (const ex of unassignedExecs || []) {
        const eq = ex?.equipment || ex?.route?.equipment || null;
        const crit = String(eq?.criticality || "").toUpperCase();
        const isCritical = ["ALTA", "CRITICA", "CRITICA"].includes(crit);

        let score = 45;
        const scheduledKey = dateKeyInTimezone(ex?.scheduledAt, plantTimezone);
        const isOverdue = Boolean(scheduledKey) && Boolean(todayKey) && scheduledKey < todayKey;

        if (isOverdue) score += 20;
        if (isCritical) score += 20;

        score = clamp(score, 0, 100);

        add(queue, {
          key: `EXEC_UNASSIGNED:${ex.id}`,
          type: "EXEC_UNASSIGNED",
          severity: sevFromScore(score),
          score,
          title: `Actividad sin técnico${isCritical ? " (crí­tica)" : ""}`,
          reason: `${isOverdue ? "Vencida" : "Pendiente"}${equipmentLabel(eq) ? ` · ${equipmentLabel(eq)}` : ""}`,
          suggestedOwner: "SUPERVISOR",
          entity: {
            executionId: ex.id,
            equipmentId: eq?.id ?? null,
          },
          link: `/activities?filter=unassigned&month=${ym}`,
        });
      }

      for (const r of openReports || []) {
        const eq = r?.equipment || null;
        const lvl = String(r?.condition || "REGULAR").toUpperCase();
        const crit = String(eq?.criticality || "").toUpperCase();
        const isCriticalEq = ["ALTA", "CRITICA", "CRITICA"].includes(crit);

        let score = 50;
        if (lvl === "CRITICO") score += 35;
        else if (lvl === "MALO") score += 25;
        else if (lvl === "REGULAR") score += 10;

        if (isCriticalEq) score += 10;
        score = clamp(score, 0, 100);

        add(queue, {
          key: `COND_REPORT:${r.id}`,
          type: "COND_REPORT",
          severity: sevFromScore(score),
          score,
          title: `Condición anormal: ${lvl}`,
          reason: `${r?.category ? String(r.category) : "Sin categorí­a"}${equipmentLabel(eq) ? ` · ${equipmentLabel(eq)}` : ""}`,
          suggestedOwner: "SUPERVISOR",
          entity: { reportId: r.id, equipmentId: eq?.id ?? null },
          link: `/condition-reports?status=OPEN`,
        });
      }

      for (const it of repeatedFailures.slice(0, 20)) {
        const eq = it?.equipment || null;
        const crit = String(eq?.criticality || "").toUpperCase();
        const isCriticalEq = ["ALTA", "CRITICA", "CRITICA"].includes(crit);

        let score = 55;
        if (String(it.risk).toUpperCase() === "HIGH") score += 25;
        else score += 12;

        if (isCriticalEq) score += 10;
        score = clamp(score, 0, 100);

        add(queue, {
          key: `REPEATED_FAILURE:${it.equipmentId}`,
          type: "REPEATED_FAILURE",
          severity: sevFromScore(score),
          score,
          title: `Reincidencia MALO/CRITICO`,
          reason: `Eventos: ${it.badTotal} · CRITICOS: ${it.critTotal}${equipmentLabel(eq) ? ` · ${equipmentLabel(eq)}` : ""}`,
          suggestedOwner: "SUPERVISOR",
          entity: { equipmentId: it.equipmentId },
          link: `/activities?filter=bad-condition&month=${ym}`,
        });
      }

      for (const ex of criticalUnassignedOverdueSafe || []) {
        const eq = ex?.route?.equipment || null;
        const score = 95;

        add(queue, {
          key: `CRITICAL_UNASSIGNED_OVERDUE:${ex.id}`,
          type: "CRITICAL_UNASSIGNED_OVERDUE",
          severity: "CRITICAL",
          score,
          title: `Crítica vencida sin técnico`,
          reason: `${equipmentLabel(eq) || "Equipo"} · Ruta: ${ex?.route?.name || "-"}`,
          suggestedOwner: "SUPERVISOR",
          entity: { executionId: ex.id, equipmentId: eq?.id ?? null },
          link: `/activities?status=OVERDUE&month=${ym}`,
        });
      }

      for (const l of lowStockLubricants || []) {
        const stock = Number(l.stock || 0);
        const score = clamp(70 + (stock <= 0 ? 15 : 0), 0, 100);

        add(queue, {
          key: `LOW_STOCK:${l.id}`,
          type: "LOW_STOCK",
          severity: sevFromScore(score),
          score,
          title: `Bajo stock`,
          reason: `${l.name}${l.code ? ` (${l.code})` : ""} · Stock: ${stock} ${l.unit || ""}`,
          suggestedOwner: "ADMIN",
          entity: { lubricantId: l.id },
          link: `/inventory`,
        });
      }

      for (const it of dteTop.slice(0, 10)) {
        const risk = String(it?.risk || "").toUpperCase();
        let score = 60;
        if (risk === "HIGH") score = 90;
        else if (risk === "MED") score = 75;

        if (it?.underMin) score = Math.min(100, score + 8);

        add(queue, {
          key: `DTE:${it.lubricantId}`,
          type: "DAYS_TO_EMPTY",
          severity: sevFromScore(score),
          score,
          title: `Days-to-empty ${risk === "HIGH" ? "crítico" : "en riesgo"}`,
          reason: `${it.name || "Lubricante"} · DTE: ${
            it.daysToEmpty ?? it.dte ?? "—"
          } día(s) · Stock: ${Number(it.stock || 0)} ${it.unit || ""}${it?.underMin ? " · Bajo mínimo" : ""}`,
          suggestedOwner: "ADMIN",
          entity: { lubricantId: it.lubricantId },
          link: `/inventory`,
        });
      }

      for (const it of anomaliesTop.slice(0, 10)) {
        const risk = String(it?.risk || "").toUpperCase();
        let score = 58;
        if (risk === "HIGH") score = 88;
        else if (risk === "MED") score = 72;

        const crit = String(it?.criticality || "").toUpperCase();
        if (["ALTA", "CRITICA", "CRITICA"].includes(crit)) score = Math.min(100, score + 7);

        add(queue, {
          key: `ANOMALY:${it.equipmentId}`,
          type: "CONSUMPTION_ANOMALY",
          severity: sevFromScore(score),
          score,
          title: `Anomalí­a de consumo (${risk})`,
          reason: `${it.name || "Equipo"}${it.code ? ` (${it.code})` : ""} · Ratio: ${
            it.ratio ?? "—"
          } · Base: ${it.baselineAvgDaily ?? "-"} · Ult.14: ${it.last14AvgDaily ?? it.lastNAvgDaily ?? "-"}`,
          suggestedOwner: "SUPERVISOR",
          entity: { equipmentId: it.equipmentId },
          link: `/analysis`,
        });
      }

      // =========================
      // 4) Deduplicacion + orden
      // =========================
      const seen = new Set();
      const dedup = [];
      for (const item of queue) {
        if (!item?.key) continue;
        if (seen.has(item.key)) continue;
        seen.add(item.key);
        dedup.push(item);
      }

      dedup.sort((a, b) => (b.score - a.score) || String(a.type).localeCompare(String(b.type)));

      const top = dedup.slice(0, 20);

      return res.json({
        ok: true,
        updatedAt: new Date().toISOString(),
        role,
        month: ym,
        range: { from: from.toISOString(), to: to.toISOString() },
        priorityQueue: top,
        total: dedup.length,
      });
    } catch (e) {
      console.error("Error dashboard priority queue:", e);
      res.status(500).json({ error: "Error dashboard priority queue" });
    }
  }
);

// -------------------------
// DEV: ejecutar resumen de vencidas manualmente
// -------------------------
app.post("/api/dev/run-overdue-summary", async (req, res) => {
  try {
    const result = await runOverdueSummaryJob({
      prisma,
      baseUrl: process.env.APP_URL || "http://localhost:5173",
    });

    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Error ejecutando overdue summary job" });
  }
});


 // -------------------------
// GET /api/dashboard/alerts/predictive?month=YYYY-MM
// ADMIN / SUPERVISOR
// -------------------------
app.get(
  "/api/dashboard/alerts/predictive",
  requireAuth,
  requireRole(["ADMIN", "SUPERVISOR"]),
  async (req, res) => {
    try {
      const role = String(req.user?.role || "").toUpperCase();

      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const month = String(req.query.month || "").trim();
      const now = new Date();

      const [y, m] = month ? month.split("-").map(Number) : [now.getFullYear(), now.getMonth() + 1];
      const year = Number.isFinite(y) ? y : now.getFullYear();
      const monthNum = Number.isFinite(m) ? m : now.getMonth() + 1;

      const from = new Date(year, monthNum - 1, 1, 0, 0, 0, 0);
      const to = new Date(year, monthNum, 0, 23, 59, 59, 999);
      const plant = await prisma.plant.findUnique({
        where: { id: plantId },
        select: { timezone: true },
      });
      const plantTimezone = String(plant?.timezone || "America/Mexico_City");
      const todayKey = dateKeyInTimezone(new Date(), plantTimezone);

      const histDays = 90;
      const histFrom = new Date(new Date());
      histFrom.setDate(histFrom.getDate() - histDays);

      // 1) completadas historial
      const completed = await prisma.execution.findMany({
        where: {
          plantId,
          status: "COMPLETED",
          executedAt: { gte: histFrom, lte: now },
        },
        select: {
          scheduledAt: true,
          executedAt: true,
          route: { select: { equipmentId: true } },
        },
      });

      const completedSafe = (completed || []).filter(
        (ex) => ex?.scheduledAt && ex?.executedAt && ex?.route?.equipmentId != null
      );

      // 2) riesgo por atraso
      const byEquipment = new Map();

      for (const ex of completedSafe) {
        const equipmentId = ex.route.equipmentId;

        const schedDay = toStartOfDaySafe(new Date(ex.scheduledAt));
        const execDay = toStartOfDaySafe(new Date(ex.executedAt));
        const delayDays = Math.floor((execDay.getTime() - schedDay.getTime()) / 86400000);

        if (!byEquipment.has(equipmentId)) {
          byEquipment.set(equipmentId, { total: 0, late2plus: 0, sumDelay: 0, maxDelay: 0 });
        }

        const s = byEquipment.get(equipmentId);
        s.total += 1;
        s.sumDelay += delayDays;
        if (delayDays >= 2) s.late2plus += 1;
        if (delayDays > s.maxDelay) s.maxDelay = delayDays;
      }

      const riskEquipments = [];
      for (const [equipmentId, s] of byEquipment.entries()) {
        const avgDelay = s.total ? s.sumDelay / s.total : 0;
        const lateRate = s.total ? s.late2plus / s.total : 0;

        let risk = "LOW";
        if (s.total >= 4 && lateRate >= 0.35) risk = "HIGH";
        else if (s.total >= 3 && lateRate >= 0.2) risk = "MED";

        riskEquipments.push({
          equipmentId,
          totalCompleted: s.total,
          late2plus: s.late2plus,
          lateRate: Number(lateRate.toFixed(3)),
          avgDelayDays: Number(avgDelay.toFixed(2)),
          maxDelayDays: s.maxDelay,
          risk,
        });
      }

      riskEquipments.sort((a, b) => {
        const score = (x) => (x.risk === "HIGH" ? 3 : x.risk === "MED" ? 2 : 1);
        const ds = score(b) - score(a);
        if (ds !== 0) return ds;
        if (b.lateRate !== a.lateRate) return b.lateRate - a.lateRate;
        return (b.maxDelayDays || 0) - (a.maxDelayDays || 0);
      });

      // 3) pendientes del mes en equipos con riesgo
      const pendingInMonth = await prisma.execution.findMany({
        where: {
          plantId,
          scheduledAt: { gte: from, lte: to },
          status: { not: "COMPLETED" },
        },
        select: {
          id: true,
          scheduledAt: true,
          status: true,
          technicianId: true,
          route: { select: { equipmentId: true, name: true } },
        },
      });

      const pendingSafe = (pendingInMonth || []).filter(
        (ex) => ex?.route?.equipmentId != null && ex?.scheduledAt
      );

      const riskMap = new Map(riskEquipments.map((x) => [x.equipmentId, x.risk]));

      let riskPendingCount = 0;
      let riskOverdueCount = 0;
      const topRiskPending = [];

      for (const ex of pendingSafe) {
        const equipmentId = ex.route.equipmentId;
        const risk = riskMap.get(equipmentId) || "LOW";
        if (risk === "LOW") continue;

        riskPendingCount += 1;

        const scheduledKey = dateKeyInTimezone(ex?.scheduledAt, plantTimezone);
        const isOverdue = Boolean(scheduledKey) && Boolean(todayKey) && scheduledKey < todayKey;
        if (isOverdue) riskOverdueCount += 1;

        if (topRiskPending.length < 10) {
          topRiskPending.push({
            executionId: ex.id,
            equipmentId,
            routeName: ex?.route?.name || "—",
            scheduledAt: ex.scheduledAt,
            risk,
            overdue: isOverdue,
            technicianId: ex.technicianId ?? null,
          });
        }
      }

      const alerts = {
        riskEquipmentsTop: riskEquipments.slice(0, 10),
        riskPendingCount,
        riskOverdueCount,
        topRiskPending,
      };

      // 4) reincidencia
      const badEvents = await prisma.execution.findMany({
        where: {
          plantId,
          status: "COMPLETED",
          executedAt: { gte: from, lte: to },
          condition: { in: ["MALO", "CRITICO"] },
        },
        select: {
          executedAt: true,
          condition: true,
          route: { select: { equipmentId: true } },
        },
      });

      const badByEq = new Map();
      for (const ex of badEvents || []) {
        const eqId = ex?.route?.equipmentId;
        if (eqId == null) continue;

        const t = new Date(ex.executedAt).getTime();
        if (!Number.isFinite(t)) continue;

        if (!badByEq.has(eqId)) badByEq.set(eqId, { total: 0, crit: 0, lastAt: null });
        const s = badByEq.get(eqId);

        s.total += 1;
        if (String(ex.condition).toUpperCase() === "CRITICO") s.crit += 1;
        if (!s.lastAt || t > new Date(s.lastAt).getTime()) s.lastAt = ex.executedAt;
      }

      const repeatedFailures = [];
      for (const [equipmentId, s] of badByEq.entries()) {
        const score = s.total + s.crit * 1.5;

        let risk = "LOW";
        if (s.total >= 3 || s.crit >= 2) risk = "HIGH";
        else if (s.total >= 2 || s.crit >= 1) risk = "MED";

        repeatedFailures.push({
          equipmentId,
          badTotal: s.total,
          critTotal: s.crit,
          lastBadAt: s.lastAt,
          score: Number(score.toFixed(2)),
          risk,
        });
      }

      repeatedFailures.sort((a, b) => (b.score - a.score) || (b.badTotal - a.badTotal));
      const repeatedFailuresCount = repeatedFailures.filter((x) => x.risk !== "LOW").length;

      alerts.repeatedFailuresCount = repeatedFailuresCount;
      alerts.repeatedFailuresTop = repeatedFailures.slice(0, 10);
      alerts.repeatedFailures = repeatedFailuresCount;

      // 5) critico + sin tecnico
      const criticalUnassigned = await prisma.execution.findMany({
        where: {
          plantId,
          scheduledAt: { gte: from, lte: to },
          status: { not: "COMPLETED" },
          technicianId: null,
          route: {
            equipment: {
              criticality: { in: ["ALTA", "CRITICA", "CRITICA"] },
            },
          },
        },
        select: {
          id: true,
          scheduledAt: true,
          status: true,
          route: {
            select: {
              name: true,
              equipment: {
                select: { id: true, name: true, code: true, location: true, criticality: true },
              },
            },
          },
        },
        orderBy: { scheduledAt: "asc" },
      });

      const criticalUnassignedCount = Array.isArray(criticalUnassigned) ? criticalUnassigned.length : 0;

      const criticalUnassignedTop = (criticalUnassigned || []).slice(0, 10).map((ex) => ({
        executionId: ex.id,
        scheduledAt: ex.scheduledAt,
        status: ex.status,
        routeName: ex?.route?.name || "—",
        equipment: {
          id: ex?.route?.equipment?.id ?? null,
          name: ex?.route?.equipment?.name || "—",
          code: ex?.route?.equipment?.code || "",
          location: ex?.route?.equipment?.location || "",
          criticality: ex?.route?.equipment?.criticality || "—",
        },
      }));

      alerts.criticalUnassignedCount = criticalUnassignedCount;
      alerts.criticalUnassignedTop = criticalUnassignedTop;

      // 6) predictivo fisico
      const ym = `${year}-${String(monthNum).padStart(2, "0")}`;

      const metrics = await getPredictiveMetrics({
        prisma,
        toStartOfDaySafe,
        plantId,
        month: ym,
        histDays: 90,
        shortWindowDays: 14,
        now,
      });

      alerts.lubricantDaysToEmptyTop = metrics?.lubricantDaysToEmptyTop || [];
      alerts.equipmentConsumptionAnomaliesTop = metrics?.equipmentConsumptionAnomaliesTop || [];
      alerts.consumptionSignalsCount = Number(metrics?.consumptionSignalsCount || 0);

      alerts.lubricantDaysToEmptyCount = alerts.lubricantDaysToEmptyTop.length;
      alerts.equipmentConsumptionAnomaliesCount = alerts.equipmentConsumptionAnomaliesTop.length;
      alerts.criticalRiskOverdueCount = Number(alerts.riskOverdueCount || 0);

      const historyRange = metrics?.ranges?.historyRange;

      const total =
        Number(alerts?.riskPendingCount || 0) +
        Number(alerts?.criticalRiskOverdueCount || 0) +
        Number(alerts?.repeatedFailuresCount || 0) +
        Number(alerts?.criticalUnassignedCount || 0) +
        Number(alerts?.lubricantDaysToEmptyCount || 0) +
        Number(alerts?.equipmentConsumptionAnomaliesCount || 0);

      return res.json({
        ok: true,
        updatedAt: new Date().toISOString(),
        role,
        month: ym,
        range: { from: from.toISOString(), to: to.toISOString() },
        historyRange,
        alerts,
        total,
      });
    } catch (e) {
      console.error("Error dashboard predictive alerts:", e);
      res.status(500).json({ error: "Error dashboard predictive alerts" });
    }
  }
);

// GET /api/dashboard/alerts/predictive-physical?days=90
app.get(
  "/api/dashboard/alerts/predictive-physical",
  requireAuth,
  requireRole(["ADMIN", "SUPERVISOR"]),
  async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const now = new Date();
      const days = Math.max(30, Math.min(365, Number(req.query.days || 90) || 90));

      const today = toStartOfDaySafe(new Date());
      const from = new Date(today);
      from.setDate(from.getDate() - days);

      // 1) Movimientos OUT ligados a ejecuciones/rutas/equipos de la planta actual
      const outMoves = await prisma.lubricantMovement.findMany({
        where: {
          type: "OUT",
          createdAt: { gte: from, lte: now },
          executionId: { not: null },
          execution: {
            is: {
              plantId,
              route: { isNot: null },
            },
          },
        },
        select: {
          quantity: true,
          createdAt: true,
          lubricantId: true,
          execution: {
            select: {
              route: {
                select: {
                  equipmentId: true,
                },
              },
            },
          },
        },
      });

      // 2) Agregacion por lubricante
      const byLub = new Map();
      // 3) Agregacion por equipo
      const byEq = new Map();

      for (const mv of outMoves || []) {
        const qty = Number(mv.quantity || 0) || 0;
        if (qty <= 0) continue;

        const lubId = mv.lubricantId;
        const eqId = mv?.execution?.route?.equipmentId;
        if (eqId == null) continue;

        if (!byLub.has(lubId)) byLub.set(lubId, { totalOut: 0 });
        byLub.get(lubId).totalOut += qty;

        const dayKey = toStartOfDaySafe(new Date(mv.createdAt)).toISOString().slice(0, 10);

        if (!byEq.has(eqId)) byEq.set(eqId, { totalOut: 0, byDay: new Map() });
        const s = byEq.get(eqId);
        s.totalOut += qty;
        s.byDay.set(dayKey, (s.byDay.get(dayKey) || 0) + qty);
      }

      // 4) Enriquecer lubricantes con stock actual (solo planta actual)
      const lubIds = [...byLub.keys()];
      const lubs = lubIds.length
        ? await prisma.lubricant.findMany({
            where: {
              plantId,
              id: { in: lubIds },
            },
            select: {
              id: true,
              name: true,
              stock: true,
              unit: true,
              minStock: true,
            },
          })
        : [];

      const lubMeta = new Map(lubs.map((l) => [l.id, l]));

      const lubricantDaysToEmpty = lubIds
        .map((id) => {
          const meta = lubMeta.get(id);
          const totalOut = byLub.get(id)?.totalOut || 0;
          const avgDailyOut = totalOut / days;
          const stock = Number(meta?.stock || 0) || 0;
          const minStock = meta?.minStock != null ? Number(meta.minStock) : null;
          const dte = avgDailyOut > 0 ? stock / avgDailyOut : null;

          let risk = "LOW";
          if (dte != null && dte <= 7) risk = "HIGH";
          else if (dte != null && dte <= 14) risk = "MED";

          return {
            lubricantId: id,
            name: meta?.name || `Lubricant ${id}`,
            unit: meta?.unit || "ml",
            stock,
            minStock,
            underMin: minStock != null ? stock <= minStock : false,
            avgDailyOut: Number.isFinite(avgDailyOut) ? Number(avgDailyOut.toFixed(2)) : 0,
            daysToEmpty: dte == null ? null : Number(dte.toFixed(1)),
            risk,
          };
        })
        .sort((a, b) => {
          const av = a.daysToEmpty ?? 1e9;
          const bv = b.daysToEmpty ?? 1e9;
          return av - bv;
        });

      // 5) Tendencia por equipo (last14 vs baseline)
      const eqIds = [...byEq.keys()];
      const eqs = eqIds.length
        ? await prisma.equipment.findMany({
            where: {
              plantId,
              id: { in: eqIds },
            },
            select: {
              id: true,
              name: true,
              code: true,
              location: true,
              criticality: true,
              area: { select: { name: true } },
            },
          })
        : [];

      const eqMeta = new Map(eqs.map((e) => [e.id, e]));

      const last14From = new Date(today);
      last14From.setDate(last14From.getDate() - 14);

      const equipmentConsumptionTrend = eqIds
        .map((id) => {
          const s = byEq.get(id);
          const meta = eqMeta.get(id);

          const baselineAvgDaily = (s.totalOut || 0) / days;

          let last14Total = 0;
          for (const [dayKey, qty] of s.byDay.entries()) {
            const d = new Date(`${dayKey}T12:00:00`);
            if (d.getTime() >= last14From.getTime()) last14Total += qty;
          }

          const last14Avg = last14Total / 14;
          const ratio = baselineAvgDaily > 0 ? last14Avg / baselineAvgDaily : null;

          let risk = "LOW";
          if (ratio != null && ratio >= 1.5) risk = "HIGH";
          else if (ratio != null && ratio >= 1.25) risk = "MED";

          return {
            equipmentId: id,
            name: meta?.name || `Equipment ${id}`,
            code: meta?.code || "",
            area: meta?.area?.name || "—",
            location: meta?.location || "",
            criticality: meta?.criticality || null,
            baselineAvgDaily: Number.isFinite(baselineAvgDaily)
              ? Number(baselineAvgDaily.toFixed(2))
              : 0,
            last14AvgDaily: Number.isFinite(last14Avg) ? Number(last14Avg.toFixed(2)) : 0,
            ratio: ratio == null ? null : Number(ratio.toFixed(2)),
            risk,
          };
        })
        .sort((a, b) => {
          const score = (x) => (x.risk === "HIGH" ? 3 : x.risk === "MED" ? 2 : 1);
          const ds = score(b) - score(a);
          if (ds !== 0) return ds;
          return (b.ratio || 0) - (a.ratio || 0);
        });

      return res.json({
        ok: true,
        updatedAt: new Date().toISOString(),
        range: { from: from.toISOString(), to: now.toISOString() },
        days,
        alerts: {
          lubricantDaysToEmptyTop: lubricantDaysToEmpty.slice(0, 10),
          equipmentConsumptionTrendTop: equipmentConsumptionTrend.slice(0, 10),
        },
      });
    } catch (e) {
      console.error("Error predictive physical alerts:", e);
      res.status(500).json({ error: "Error predictive physical alerts" });
    }
  }
);

 // -------------------------
// GET /api/dashboard/admin/counts
// - SOLO ADMIN
// - KPIs: total rutas, total equipos
// - MULTI-PLANTA
// -------------------------
app.get(
  "/api/dashboard/admin/counts",
  requireAuth,
  requireRole(["ADMIN"]),
  async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) {
        return res.status(400).json({ error: "PLANT_REQUIRED" });
      }

      const [routesCount, equipmentsCount] = await Promise.all([
        prisma.route.count({
          where: { plantId },
        }),
        prisma.equipment.count({
          where: { plantId },
        }),
      ]);

      return res.json({
        ok: true,
        updatedAt: new Date().toISOString(),
        plantId,
        routesCount,
        equipmentsCount,
      });
    } catch (e) {
      console.error("dashboard admin counts error:", e);
      return res.status(500).json({ error: "Error dashboard admin counts" });
    }
  }
);

 // -------------------------
// GET /api/dashboard/activities/monthly?month=YYYY-MM
// - ADMIN y SUPERVISOR
// - TECHNICIAN: 403
// - MULTI-PLANTA
// -------------------------
app.get(
  "/api/dashboard/activities/monthly",
  requireAuth,
  requireRole(["ADMIN", "SUPERVISOR"]),
  async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) {
        return res.status(400).json({ error: "PLANT_REQUIRED" });
      }

      const role = String(req.user?.role || "").toUpperCase();
      const plant = await prisma.plant.findUnique({
        where: { id: plantId },
        select: { timezone: true },
      });
      const plantTimezone = String(plant?.timezone || "America/Mexico_City");

      const month = String(req.query.month || "").trim();
      const now = new Date();
      const monthOk = /^\d{4}-\d{2}$/.test(month);

      const from = monthOk
        ? new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1, 0, 0, 0, 0)
        : new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);

      const to = monthOk
        ? new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0, 23, 59, 59, 999)
        : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

      const todayKey = dateKeyInTimezone(new Date(), plantTimezone);

      const executions = await prisma.execution.findMany({
        where: {
          plantId,
          scheduledAt: { gte: from, lte: to },
        },
        select: {
          status: true,
          scheduledAt: true,
          executedAt: true,
        },
      });

      let completed = 0;
      let overdue = 0;
      let pending = 0;

      for (const e of executions) {
        const schedKey = dateKeyInTimezone(e.scheduledAt, plantTimezone);

        if (e.status === "COMPLETED" && e.executedAt) {
          completed++;
        } else if (schedKey && schedKey < todayKey) {
          overdue++;
        } else {
          pending++;
        }
      }

      const total = completed + overdue + pending;

      return res.json({
        ok: true,
        role,
        plantId,
        month: monthOk ? month : null,
        range: { from: from.toISOString(), to: to.toISOString() },
        data: {
          total,
          completed,
          overdue,
          pending,
          completedPct: total ? Number(((completed / total) * 100).toFixed(1)) : 0,
          overduePct: total ? Number(((overdue / total) * 100).toFixed(1)) : 0,
        },
      });
    } catch (e) {
      console.error("Error monthly activities:", e);
      res.status(500).json({ error: "Error monthly activities" });
    }
  }
);

 // -------------------------
// GET /api/dashboard/activities/monthly/me?month=YYYY-MM
// - TECHNICIAN: solo sus actividades
// - MULTI-PLANTA
// -------------------------
app.get(
  "/api/dashboard/activities/monthly/me",
  requireAuth,
  requireRole(["TECHNICIAN"]),
  async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) {
        return res.status(400).json({ error: "PLANT_REQUIRED" });
      }

      const role = String(req.user?.role || "").toUpperCase();
      const plant = await prisma.plant.findUnique({
        where: { id: plantId },
        select: { timezone: true },
      });
      const plantTimezone = String(plant?.timezone || "America/Mexico_City");

      const month = String(req.query.month || "").trim();
      const now = new Date();
      const monthOk = /^\d{4}-\d{2}$/.test(month);

      const from = monthOk
        ? new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1, 0, 0, 0, 0)
        : new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);

      const to = monthOk
        ? new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0, 23, 59, 59, 999)
        : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

      const todayKey = dateKeyInTimezone(new Date(), plantTimezone);

      const myTechnicianId = req.user?.technicianId != null ? Number(req.user.technicianId) : null;

      if (!Number.isFinite(myTechnicianId)) {
        return res.status(400).json({ error: "Falta technicianId en el usuario autenticado" });
      }

      const technician = await prisma.technician.findFirst({
        where: {
          id: myTechnicianId,
          plantId,
          deletedAt: null,
        },
        select: { id: true },
      });

      if (!technician) {
        return res.status(404).json({ error: "Técnico no encontrado en la planta actual" });
      }

      const executions = await prisma.execution.findMany({
        where: {
          plantId,
          scheduledAt: { gte: from, lte: to },
          technicianId: myTechnicianId,
        },
        select: {
          status: true,
          scheduledAt: true,
          executedAt: true,
        },
      });

      let completed = 0;
      let overdue = 0;
      let pending = 0;

      for (const e of executions) {
        const schedKey = dateKeyInTimezone(e.scheduledAt, plantTimezone);

        if (e.status === "COMPLETED" && e.executedAt) {
          completed++;
        } else if (schedKey && schedKey < todayKey) {
          overdue++;
        } else {
          pending++;
        }
      }

      const total = completed + overdue + pending;

      return res.json({
        ok: true,
        role,
        plantId,
        month: monthOk ? month : null,
        range: { from: from.toISOString(), to: to.toISOString() },
        data: {
          total,
          completed,
          overdue,
          pending,
          completedPct: total ? Number(((completed / total) * 100).toFixed(1)) : 0,
          overduePct: total ? Number(((overdue / total) * 100).toFixed(1)) : 0,
        },
      });
    } catch (e) {
      console.error("Error monthly activities me:", e);
      res.status(500).json({ error: "Error monthly activities me" });
    }
  }
);

 // =========================
// GET /api/alerts/repeated-failures
// - ADMIN
// - MULTI-PLANTA
// =========================
app.get(
  "/api/alerts/repeated-failures",
  requireAuth,
  requireRole(["ADMIN"]),
  async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) {
        return res.status(400).json({ error: "PLANT_REQUIRED" });
      }

      const month = String(req.query.month || "").trim();
      const lookbackDaysRaw = Number(req.query.lookbackDays ?? 90);
      const minEventsRaw = Number(req.query.minEvents ?? 2);

      const lookbackDays = Number.isFinite(lookbackDaysRaw)
        ? Math.min(Math.max(lookbackDaysRaw, 7), 365)
        : 90;

      const minEvents = Number.isFinite(minEventsRaw)
        ? Math.min(Math.max(minEventsRaw, 2), 10)
        : 2;

      const monthOk = /^\d{4}-\d{2}$/.test(month);
      const now = new Date();

      const monthFrom = monthOk
        ? new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1, 0, 0, 0, 0)
        : null;

      const monthTo = monthOk
        ? new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0, 23, 59, 59, 999)
        : null;

      const toDate = monthOk && monthTo ? monthTo : now;

      const fromDate = new Date(toDate);
      fromDate.setDate(fromDate.getDate() - lookbackDays);

      const badEvents = await prisma.execution.findMany({
        where: {
          plantId,
          status: "COMPLETED",
          executedAt: { not: null, gte: fromDate, lte: toDate },
          condition: { in: ["MALO", "CRITICO"] },
        },
        select: {
          id: true,
          executedAt: true,
          condition: true,
          observations: true,
          route: {
            select: {
              id: true,
              name: true,
              equipment: {
                select: {
                  id: true,
                  name: true,
                  code: true,
                  location: true,
                  criticality: true,
                },
              },
            },
          },
        },
        orderBy: { executedAt: "desc" },
      });

      const byEq = new Map();

      for (const ev of badEvents) {
        const eq = ev.route?.equipment;
        if (!eq?.id) continue;

        if (!byEq.has(eq.id)) {
          byEq.set(eq.id, {
            equipment: eq,
            badCount: 0,
            criticalCount: 0,
            lastBadAt: null,
            lastCondition: null,
            lastNotes: null,
            samples: [],
          });
        }

        const r = byEq.get(eq.id);

        r.badCount += 1;
        if (ev.condition === "CRITICO") r.criticalCount += 1;

        if (!r.lastBadAt) {
          r.lastBadAt = ev.executedAt;
          r.lastCondition = ev.condition;
          r.lastNotes = ev.observations || null;
        }

        if (r.samples.length < 3) {
          r.samples.push({
            executionId: ev.id,
            executedAt: ev.executedAt,
            condition: ev.condition,
            routeName: ev.route?.name || "—",
            notes: ev.observations || null,
          });
        }
      }

      let items = [...byEq.values()].filter((x) => x.badCount >= minEvents);

      if (monthOk && monthFrom && monthTo) {
        const today = toStartOfDaySafe(new Date());

        const inMonth = await prisma.execution.findMany({
          where: {
            plantId,
            scheduledAt: { gte: monthFrom, lte: monthTo },
            status: { not: "COMPLETED" },
          },
          select: {
            route: {
              select: { equipmentId: true },
            },
          },
        });

        const monthEqSet = new Set(
          inMonth.map((x) => x.route?.equipmentId).filter(Boolean)
        );

        items = items.sort(
          (a, b) =>
            Number(monthEqSet.has(b.equipment.id)) - Number(monthEqSet.has(a.equipment.id))
        );
      }

      items.sort((a, b) => (b.criticalCount - a.criticalCount) || (b.badCount - a.badCount));

      return res.json({
        ok: true,
        plantId,
        meta: {
          month: monthOk ? month : null,
          lookbackDays,
          minEvents,
          from: fromDate.toISOString(),
          to: toDate.toISOString(),
          totalEquipments: items.length,
        },
        items,
      });
    } catch (e) {
      console.error("Error repeated-failures:", e);
      return res.status(500).json({ error: "Error repeated-failures" });
    }
  }
);

// -------------------------
// GET /api/dashboard/technicians/efficiency-monthly?month=YYYY-MM
// - ADMIN y SUPERVISOR
// - MULTI-PLANTA
// - Eficiencia por tecnico del mes
// -------------------------
app.get(
  "/api/dashboard/technicians/efficiency-monthly",
  requireAuth,
  requireRole(["ADMIN", "SUPERVISOR"]),
  async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) {
        return res.status(400).json({ error: "PLANT_REQUIRED" });
      }

      const role = String(req.user?.role || "").toUpperCase();

      const month = String(req.query.month || "").trim();
      const now = new Date();
      const monthOk = /^\d{4}-\d{2}$/.test(month);

      const from = monthOk
        ? new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1, 0, 0, 0, 0)
        : new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);

      const to = monthOk
        ? new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0, 23, 59, 59, 999)
        : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

      const today = toStartOfDaySafe(new Date());

      const execs = await prisma.execution.findMany({
        where: {
          plantId,
          scheduledAt: { gte: from, lte: to },
          technicianId: { not: null },
        },
        select: {
          technicianId: true,
          status: true,
          scheduledAt: true,
          executedAt: true,
        },
      });

      const byTech = new Map();

      for (const e of execs || []) {
        const techId = e.technicianId;
        if (!techId) continue;

        if (!byTech.has(techId)) {
          byTech.set(techId, {
            technicianId: techId,
            totalProgramadas: 0,
            completadas: 0,
            aTiempo: 0,
            tarde: 0,
            vencidas: 0,
            pendientes: 0,
          });
        }

        const s = byTech.get(techId);
        s.totalProgramadas += 1;

        const schedDay = toStartOfDaySafe(e.scheduledAt);

        const isCompleted = e.status === "COMPLETED" && !!e.executedAt;
        if (isCompleted) {
          s.completadas += 1;

          const execDay = toStartOfDaySafe(e.executedAt);
          if (execDay.getTime() <= schedDay.getTime()) s.aTiempo += 1;
          else s.tarde += 1;
        } else {
          if (schedDay.getTime() < today.getTime()) s.vencidas += 1;
          else s.pendientes += 1;
        }
      }

      const techIds = Array.from(byTech.keys());

      if (techIds.length === 0) {
        return res.json({
          ok: true,
          role,
          plantId,
          month: monthOk ? month : null,
          range: { from: from.toISOString(), to: to.toISOString() },
          formula: { onTime: 1.0, late: 0.6, overdue: 0.2 },
          items: [],
        });
      }

      const techs = await prisma.technician.findMany({
        where: {
          plantId,
          deletedAt: null,
          id: { in: techIds },
        },
        select: {
          id: true,
          name: true,
          code: true,
          status: true,
          specialty: true,
        },
      });

      const techMap = new Map(techs.map((t) => [t.id, t]));

      const scorePct = (s) => {
        const total = Math.max(1, Number(s?.totalProgramadas || 0));
        const score =
          (Number(s?.aTiempo || 0) * 1.0 +
            Number(s?.tarde || 0) * 0.6 +
            Number(s?.vencidas || 0) * 0.2) / total;
        return Math.round(score * 100);
      };

      const items = techIds.map((id) => {
        const t = techMap.get(id) || {
          id,
          name: "—",
          code: "",
          status: "—",
          specialty: "",
        };

        const s = byTech.get(id) || {
          totalProgramadas: 0,
          completadas: 0,
          aTiempo: 0,
          tarde: 0,
          vencidas: 0,
          pendientes: 0,
        };

        return {
          technician: {
            id: t.id,
            name: t.name,
            code: t.code,
            status: t.status,
            specialty: t.specialty,
          },
          totalProgramadas: Number(s.totalProgramadas || 0),
          completadas: Number(s.completadas || 0),
          aTiempo: Number(s.aTiempo || 0),
          tarde: Number(s.tarde || 0),
          vencidas: Number(s.vencidas || 0),
          pendientes: Number(s.pendientes || 0),
          scorePct: scorePct(s),
        };
      });

      items.sort((a, b) => b.scorePct - a.scorePct || b.completadas - a.completadas);

      return res.json({
        ok: true,
        role,
        plantId,
        month: monthOk ? month : null,
        range: { from: from.toISOString(), to: to.toISOString() },
        formula: { onTime: 1.0, late: 0.6, overdue: 0.2 },
        items,
      });
    } catch (e) {
      console.error("dashboard technicians efficiency-monthly error:", e);
      res.status(500).json({ error: "Error dashboard technicians efficiency-monthly" });
    }
  }
);
  
 // =========================
// GET /api/alerts/technician-overload
// - ADMIN / SUPERVISOR
// - MULTI-PLANTA
// Query:
// windowDays=7
// overdueLookbackDays=30
// capacityPerDay=6
// warnRatio=1.1
// criticalRatio=1.4
// =========================
app.get(
  "/api/alerts/technician-overload",
  requireAuth,
  requireRole(["ADMIN", "SUPERVISOR"]),
  async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) {
        return res.status(400).json({ error: "PLANT_REQUIRED" });
      }

      const windowDays = Number(req.query.windowDays ?? 7);
      const overdueLookbackDays = Number(req.query.overdueLookbackDays ?? 30);
      const capacityPerDay = Number(req.query.capacityPerDay ?? 6);
      const warnRatio = Number(req.query.warnRatio ?? 1.1);
      const criticalRatio = Number(req.query.criticalRatio ?? 1.4);

      const now = new Date();
      const today = toStartOfDaySafe(now);

      const windowDaysSafe = Math.max(1, Number(windowDays || 7));
      const overdueLookbackDaysSafe = Math.max(1, Number(overdueLookbackDays || 30));

      const fromOverdue = new Date(today);
      fromOverdue.setDate(fromOverdue.getDate() - overdueLookbackDaysSafe);

      const toWindow = new Date(today);
      toWindow.setDate(toWindow.getDate() + windowDaysSafe);

      const pendingExecs = await prisma.execution.findMany({
        where: {
          plantId,
          status: { not: "COMPLETED" },
          scheduledAt: { gte: today, lt: toWindow },
          technicianId: { not: null },
        },
        select: { technicianId: true },
      });

      const overdueExecs = await prisma.execution.findMany({
        where: {
          plantId,
          status: { not: "COMPLETED" },
          scheduledAt: { gte: fromOverdue, lt: today },
          technicianId: { not: null },
        },
        select: { technicianId: true },
      });

      const techs = await prisma.technician.findMany({
        where: {
          plantId,
          deletedAt: null,
        },
        select: {
          id: true,
          name: true,
          code: true,
          status: true,
          specialty: true,
        },
      });

      const techMap = new Map(techs.map((t) => [t.id, t]));
      const techIds = techs.map((t) => t.id);

      const byTech = new Map();

      for (const e of pendingExecs) {
        const id = e.technicianId;
        if (id == null) continue;
        if (!byTech.has(id)) byTech.set(id, { pending: 0, overdue: 0 });
        byTech.get(id).pending += 1;
      }

      for (const e of overdueExecs) {
        const id = e.technicianId;
        if (id == null) continue;
        if (!byTech.has(id)) byTech.set(id, { pending: 0, overdue: 0 });
        byTech.get(id).overdue += 1;
      }

      const capacity = Math.max(1, Number(capacityPerDay || 6)) * windowDaysSafe;

      const items = techIds.map((id) => {
        const t = techMap.get(id) || {
          id,
          name: "—",
          code: "",
          status: "—",
          specialty: "",
        };

        const s = byTech.get(id) || { pending: 0, overdue: 0 };

        const load = (s.pending || 0) + (s.overdue || 0);
        const ratio = capacity ? load / capacity : 0;

        let level = "OK";
        if (ratio >= criticalRatio) level = "CRITICAL";
        else if (ratio >= warnRatio) level = "WARN";

        return {
          technicianId: id,
          name: t.name,
          code: t.code,
          status: t.status,
          specialty: t.specialty,
          windowDays: windowDaysSafe,
          capacityPerDay,
          capacity,
          pending: s.pending || 0,
          overdue: s.overdue || 0,
          load,
          ratio: Number(ratio.toFixed(3)),
          level,
        };
      });

      items.sort((a, b) => b.ratio - a.ratio || b.overdue - a.overdue);

      res.json({
        ok: true,
        plantId,
        items,
      });
    } catch (e) {
      console.error("alerts technician-overload error:", e);
      res.status(500).json({ error: "Error technician-overload" });
    }
  }
);
 // OK Asignar tecnico a una ejecucion (quick assign)
// - MULTI-PLANTA
app.patch(
  "/api/executions/:id/assign-technician",
  requireAuth,
  requireRole(["ADMIN", "SUPERVISOR"]),
  async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) {
        return res.status(400).json({ error: "PLANT_REQUIRED" });
      }

      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id invalido" });
      }

      const technicianIdRaw = req.body?.technicianId;
      const technicianId =
        technicianIdRaw === null || technicianIdRaw === undefined || technicianIdRaw === ""
          ? null
          : Number(technicianIdRaw);

      const exec = await prisma.execution.findFirst({
        where: {
          id,
          plantId,
        },
        select: {
          id: true,
          status: true,
        },
      });

      if (!exec) {
        return res.status(404).json({ error: "Ejecucion no encontrada" });
      }

      if (exec.status === "COMPLETED") {
        return res.status(400).json({ error: "No se puede asignar a una ejecucion COMPLETED" });
      }

      if (technicianId === null) {
        const updated = await prisma.execution.update({
          where: { id },
          data: { technicianId: null },
          select: {
            id: true,
            plantId: true,
            status: true,
            scheduledAt: true,
            technicianId: true,
            technician: {
              select: { id: true, name: true, code: true },
            },
          },
        });

        return res.json({ ok: true, item: updated });
      }

      if (!Number.isFinite(technicianId)) {
        return res.status(400).json({ error: "technicianId invalido" });
      }

      const tech = await prisma.technician.findFirst({
        where: {
          id: technicianId,
          plantId,
          deletedAt: null,
        },
        select: {
          id: true,
          name: true,
          code: true,
          status: true,
        },
      });

      if (!tech) {
        return res.status(404).json({ error: "Técnico no encontrado en la planta actual" });
      }

      const updated = await prisma.execution.update({
        where: { id },
        data: { technicianId: tech.id },
        select: {
          id: true,
          plantId: true,
          status: true,
          scheduledAt: true,
          technicianId: true,
          technician: {
            select: { id: true, name: true, code: true },
          },
        },
      });

      res.json({ ok: true, item: updated });
    } catch (e) {
      console.error("Error assign-technician:", e);
      res.status(500).json({ error: "Error assign-technician" });
    }
  }
);

  // OK Asignar tecnico a una ejecucion
// - MULTI-PLANTA
app.patch(
  "/api/executions/:id/assign",
  requireAuth,
  requireRole(["ADMIN", "SUPERVISOR"]),
  async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) {
        return res.status(400).json({ error: "PLANT_REQUIRED" });
      }

      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "Invalid execution id" });
      }

      const technicianIdRaw = req.body?.technicianId;
      const technicianId =
        technicianIdRaw === null || technicianIdRaw === undefined || technicianIdRaw === ""
          ? null
          : Number(technicianIdRaw);

      const exec = await prisma.execution.findFirst({
        where: {
          id,
          plantId,
        },
        select: {
          id: true,
          status: true,
        },
      });

      if (!exec) {
        return res.status(404).json({ error: "Execution not found" });
      }

      if (exec.status === "COMPLETED") {
        return res.status(400).json({ error: "No se puede asignar a una ejecucion COMPLETED" });
      }

      if (technicianId !== null && !Number.isFinite(technicianId)) {
        return res.status(400).json({ error: "Invalid technicianId" });
      }

      if (technicianId !== null) {
        const tech = await prisma.technician.findFirst({
          where: {
            id: technicianId,
            plantId,
            deletedAt: null,
          },
          select: {
            id: true,
            status: true,
          },
        });

        if (!tech) {
          return res.status(404).json({ error: "Technician not found in current plant" });
        }
      }

      const updated = await prisma.execution.update({
        where: { id },
        data: {
          technicianId: technicianId === null ? null : technicianId,
        },
        select: {
          id: true,
          plantId: true,
          status: true,
          scheduledAt: true,
          technicianId: true,
          technician: {
            select: {
              id: true,
              name: true,
              code: true,
              specialty: true,
              status: true,
            },
          },
        },
      });

      res.json({ ok: true, item: updated });
    } catch (e) {
      console.error("assign technician error:", e);
      res.status(500).json({ error: "Error assigning technician" });
    }
  }
);

// ===== AUTH HELPERS =====
const getRole = (req) => String(req?.user?.role || "TECHNICIAN").toUpperCase();
const isManager = (req) => ["ADMIN", "SUPERVISOR"].includes(getRole(req));



  /* =========================
   EQUIPMENT
========================= */

// CREATE EQUIPMENT
app.post("/api/equipment", requireAuth, requireManager, async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

    const {
      name,
      location,
      status,
      description,
      code,
      areaId,
      criticality,
    } = req.body;

    if (!name || !location || !status) {
      return res.status(400).json({ error: "name, location y status son obligatorios" });
    }

    const parsedAreaId =
      areaId != null && String(areaId).trim() !== "" ? Number(areaId) : null;

    if (parsedAreaId != null && !Number.isFinite(parsedAreaId)) {
      return res.status(400).json({ error: "areaId invalido" });
    }

    // OK validar que el area pertenezca a la misma planta
    if (parsedAreaId != null) {
      const areaExists = await prisma.equipmentArea.findFirst({
        where: { id: parsedAreaId, plantId },
        select: { id: true },
      });

      if (!areaExists) {
        return res.status(404).json({ error: "Area no encontrada en la planta actual" });
      }
    }

    const equipment = await prisma.equipment.create({
      data: {
        plantId,
        name: String(name).trim(),
        location: String(location).trim(),
        status: String(status).trim().toUpperCase(),
        description: description?.trim() ? String(description).trim() : null,
        code: code?.trim() ? String(code).trim().toUpperCase() : null,
        areaId: parsedAreaId,
        criticality: criticality?.trim()
          ? String(criticality).trim().toUpperCase()
          : null,
      },
      include: {
        area: true,
      },
    });

    res.status(201).json(equipment);
  } catch (error) {
    console.error("Error creando equipo:", error);

    if (error?.code === "P2002") {
      return res.status(409).json({ error: "Codigo/Tag ya existe" });
    }

    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// GET EQUIPMENT BY ID
app.get("/api/equipment/:id", requireAuth, async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "id invalido" });

    const eq = await prisma.equipment.findFirst({
      where: { id, plantId },
      include: {
        area: true,
        routes: {
          select: {
            id: true,
            technicianId: true,
            technician: {
              select: { id: true, name: true, code: true },
            },
          },
        },
      },
    });

    if (!eq) return res.status(404).json({ error: "No encontrado" });

    const assignedTechnician = summarizeEquipmentAssignedTechnician(eq?.routes || []);

    res.json({
      ...eq,
      assignedTechnician,
      technicianId: assignedTechnician?.id ?? null,
      technician: assignedTechnician || null,
    });
  } catch (error) {
    console.error("Error obteniendo equipo:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// GET EQUIPMENT (con filtros + flags, compatible: regresa ARRAY)
app.get("/api/equipment", requireAuth, async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

    const filter = String(req.query.filter || "").trim();
    const month = String(req.query.month || "").trim();
    const daysRaw = Number(req.query.days ?? 30);
    const days = Number.isFinite(daysRaw) ? Math.min(Math.max(daysRaw, 1), 3650) : 30;

    const now = new Date();

    const fromDays = new Date(now);
    fromDays.setDate(fromDays.getDate() - days);

    let monthFrom = null;
    let monthTo = null;

    if (/^\d{4}-\d{2}$/.test(month)) {
      const [y, m] = month.split("-").map(Number);
      if (Number.isFinite(y) && Number.isFinite(m)) {
        monthFrom = new Date(y, m - 1, 1, 0, 0, 0, 0);
        monthTo = new Date(y, m, 0, 23, 59, 59, 999);
      }
    }

    let where = { plantId };

    if (filter === "without-routes") {
      where = {
        plantId,
        routes: { none: {} },
      };
    }

    if (filter === "with-routes") {
      where = {
        plantId,
        routes: { some: {} },
      };
    }

    if (filter === "no-activities") {
      where = {
        plantId,
        routes: { some: {} },
        NOT: {
          routes: {
            some: {
              executions: {
                some: {
                  OR: [
                    { scheduledAt: { gte: fromDays, lte: now } },
                    { executedAt: { gte: fromDays, lte: now } },
                  ],
                },
              },
            },
          },
        },
      };
    }

    if (filter === "repeated-failures") {
      const histTo = monthTo || now;
      const histFrom = new Date(histTo);
      histFrom.setDate(histFrom.getDate() - 90);

      const badEvents = await prisma.execution.findMany({
        where: {
          plantId,
          status: "COMPLETED",
          executedAt: { gte: histFrom, lte: histTo },
          condition: { in: ["MALO", "CRITICO"] },
        },
        select: {
          executedAt: true,
          condition: true,
          route: { select: { equipmentId: true } },
        },
      });

      const byEq = new Map();
      for (const ex of badEvents || []) {
        const eqId = ex?.route?.equipmentId;
        if (eqId == null) continue;

        const t = new Date(ex.executedAt).getTime();
        if (!Number.isFinite(t)) continue;

        if (!byEq.has(eqId)) {
          byEq.set(eqId, { total: 0, crit: 0, lastAt: null, score: 0, risk: "LOW" });
        }

        const s = byEq.get(eqId);
        s.total += 1;
        if (String(ex.condition).toUpperCase() === "CRITICO") s.crit += 1;
        if (!s.lastAt || t > new Date(s.lastAt).getTime()) s.lastAt = ex.executedAt;
      }

      const ids = [];
      for (const [eqId, s] of byEq.entries()) {
        const score = s.total + s.crit * 1.5;

        let risk = "LOW";
        if (s.total >= 3 || s.crit >= 2) risk = "HIGH";
        else if (s.total >= 2 || s.crit >= 1) risk = "MED";

        s.score = Number(score.toFixed(2));
        s.risk = risk;

        if (risk !== "LOW") ids.push(eqId);
      }

      if (!ids.length) return res.json([]);

      where = {
        plantId,
        id: { in: ids },
      };
    }

    const equipment = await prisma.equipment.findMany({
      where,
      include: {
        area: true,
        routes: {
          select: {
            id: true,
            technicianId: true,
            technician: {
              select: { id: true, name: true, code: true },
            },
          },
        },
        _count: { select: { routes: true } },
      },
      orderBy: [{ area: { name: "asc" } }, { name: "asc" }],
    });

    const ids = equipment.map((e) => e.id);
    const hadExecInRangeByEqId = new Set();

    if (filter !== "no-activities" && filter !== "repeated-failures" && ids.length) {
      const execs = await prisma.execution.findMany({
        where: {
          plantId,
          route: { equipmentId: { in: ids } },
          OR: [
            { scheduledAt: { gte: fromDays, lte: now } },
            { executedAt: { gte: fromDays, lte: now } },
          ],
        },
        select: { route: { select: { equipmentId: true } } },
      });

      for (const e of execs) {
        const eqId = e?.route?.equipmentId;
        if (eqId != null) hadExecInRangeByEqId.add(eqId);
      }
    }

    let repeatedMap = null;

    if (filter === "repeated-failures" && ids.length) {
      const histTo = monthTo || now;
      const histFrom = new Date(histTo);
      histFrom.setDate(histFrom.getDate() - 90);

      const badEvents = await prisma.execution.findMany({
        where: {
          plantId,
          status: "COMPLETED",
          executedAt: { gte: histFrom, lte: histTo },
          condition: { in: ["MALO", "CRITICO"] },
          route: { equipmentId: { in: ids } },
        },
        select: {
          executedAt: true,
          condition: true,
          route: { select: { equipmentId: true } },
        },
      });

      repeatedMap = new Map();
      for (const ex of badEvents || []) {
        const eqId = ex?.route?.equipmentId;
        if (eqId == null) continue;

        const t = new Date(ex.executedAt).getTime();
        if (!Number.isFinite(t)) continue;

        if (!repeatedMap.has(eqId)) {
          repeatedMap.set(eqId, {
            badTotal: 0,
            critTotal: 0,
            lastBadAt: null,
            risk: "LOW",
          });
        }

        const s = repeatedMap.get(eqId);
        s.badTotal += 1;
        if (String(ex.condition).toUpperCase() === "CRITICO") s.critTotal += 1;
        if (!s.lastBadAt || t > new Date(s.lastBadAt).getTime()) s.lastBadAt = ex.executedAt;
      }

      for (const [, s] of repeatedMap.entries()) {
        if (s.badTotal >= 3 || s.critTotal >= 2) s.risk = "HIGH";
        else if (s.badTotal >= 2 || s.critTotal >= 1) s.risk = "MED";
      }
    }

    const out = equipment.map((eq) => {
      const routesCount = Number(eq?._count?.routes || 0);
      const hasRoutes = routesCount > 0;
      const assignedTechnician = summarizeEquipmentAssignedTechnician(eq?.routes || []);

      const noActivitiesInRange =
        filter === "no-activities" ? true : hasRoutes ? !hadExecInRangeByEqId.has(eq.id) : false;

      const extra =
        filter === "repeated-failures" && repeatedMap
          ? repeatedMap.get(eq.id) || { badTotal: 0, critTotal: 0, lastBadAt: null, risk: "LOW" }
          : null;

      return {
        ...eq,
        routesCount,
        hasRoutes,
        noActivitiesInRange,
        assignedTechnician,
        technicianId: assignedTechnician?.id ?? null,
        technician: assignedTechnician || null,
        ...(extra ? { repeatedFailures: extra } : {}),
      };
    });

    return res.json(out);
  } catch (error) {
    console.error("Error obteniendo equipos:", error);
    return res.status(500).json({ error: "Error obteniendo equipos" });
  }
});

// GET EQUIPMENT DETAIL
app.get("/api/equipment/:id/detail", requireAuth, async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: "id invalido" });
    }

    const equipment = await prisma.equipment.findFirst({
      where: { id, plantId },
      include: {
        area: true,
        routes: {
          include: {
            lubricant: true,
            technician: {
              select: { id: true, name: true, code: true },
            },
          },
          orderBy: [{ nextDate: "asc" }, { id: "desc" }],
        },
        executions: {
          where: {
            OR: [
              { equipmentId: id },
              { route: { equipmentId: id } },
            ],
          },
          include: {
            technician: true,
            route: {
              select: {
                id: true,
                name: true,
                lubricantType: true,
                nextDate: true,
              },
            },
          },
          orderBy: [{ scheduledAt: "desc" }, { executedAt: "desc" }, { id: "desc" }],
          take: 50,
        },
        conditionReports: {
          orderBy: [{ detectedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
          take: 50,
          include: {
            reportedBy: {
              select: { id: true, name: true, email: true },
            },
          },
        },
        _count: {
          select: {
            routes: true,
            executions: true,
            conditionReports: true,
          },
        },
      },
    });

    if (!equipment) {
      return res.status(404).json({ error: "No encontrado" });
    }

    // tecnico mas usado
    const techUsageMap = new Map();

    for (const ex of equipment.executions || []) {
      if (!ex?.technician?.id) continue;

      const techId = ex.technician.id;
      if (!techUsageMap.has(techId)) {
        techUsageMap.set(techId, {
          technician: ex.technician,
          count: 0,
          lastExecutionAt: ex.executedAt || ex.scheduledAt || null,
        });
      }

      const row = techUsageMap.get(techId);
      row.count += 1;

      const currentTs = row.lastExecutionAt ? new Date(row.lastExecutionAt).getTime() : 0;
      const nextTs = ex.executedAt || ex.scheduledAt ? new Date(ex.executedAt || ex.scheduledAt).getTime() : 0;

      if (nextTs > currentTs) {
        row.lastExecutionAt = ex.executedAt || ex.scheduledAt;
      }
    }

    const mostUsedTechnician =
      Array.from(techUsageMap.values()).sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return new Date(b.lastExecutionAt || 0).getTime() - new Date(a.lastExecutionAt || 0).getTime();
      })[0] || null;

    const payload = {
      ...equipment,
      routesCount: equipment._count?.routes || 0,
      executionsCount: equipment._count?.executions || 0,
      conditionReportsCount: equipment._count?.conditionReports || 0,
      mostUsedTechnician,
      assignedTechnician: summarizeEquipmentAssignedTechnician(equipment?.routes || []),
    };

    return res.json(payload);
  } catch (error) {
    console.error("Error obteniendo detalle de equipo:", error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

// UPDATE EQUIPMENT
app.put("/api/equipment/:id", requireAuth, requireManager, async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

    const id = Number(req.params.id);
    const {
      name,
      location,
      status,
      description,
      code,
      areaId,
      criticality,
    } = req.body;

    if (!Number.isFinite(id)) return res.status(400).json({ error: "id invalido" });
    if (!name || !location || !status) {
      return res.status(400).json({ error: "name, location y status son obligatorios" });
    }

    const parsedAreaId =
      areaId != null && String(areaId).trim() !== "" ? Number(areaId) : null;

    if (parsedAreaId != null && !Number.isFinite(parsedAreaId)) {
      return res.status(400).json({ error: "areaId invalido" });
    }

    if (parsedAreaId != null) {
      const areaExists = await prisma.equipmentArea.findFirst({
        where: { id: parsedAreaId, plantId },
        select: { id: true },
      });

      if (!areaExists) {
        return res.status(404).json({ error: "Area no encontrada en la planta actual" });
      }
    }

    const updatedCount = await prisma.equipment.updateMany({
      where: { id, plantId },
      data: {
        name: String(name).trim(),
        location: String(location).trim(),
        status: String(status).trim().toUpperCase(),
        description: description?.trim() ? String(description).trim() : null,
        code: code?.trim() ? String(code).trim().toUpperCase() : null,
        areaId: parsedAreaId,
        criticality: criticality?.trim()
          ? String(criticality).trim().toUpperCase()
          : null,
      },
    });

    if (!updatedCount.count) {
      return res.status(404).json({ error: "Equipo no encontrado" });
    }

    const updated = await prisma.equipment.findFirst({
      where: { id, plantId },
      include: { area: true },
    });

    return res.json(updated);
  } catch (error) {
    console.error("Error actualizando equipo:", error);
    if (error?.code === "P2002") {
      return res.status(409).json({ error: "Codigo/Tag ya existe" });
    }
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// DELETE EQUIPMENT
app.delete("/api/equipment/:id", requireAuth, requireManager, async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "id invalido" });

    const deleted = await prisma.equipment.deleteMany({
      where: { id, plantId },
    });

    if (!deleted.count) {
      return res.status(404).json({ error: "Equipo no encontrado" });
    }

    res.json({ ok: true });
  } catch (error) {
    console.error("Error eliminando equipo:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ===== AREAS DE EQUIPO =====

// LISTAR AREAS
app.get("/api/equipment-areas", requireAuth, async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    if (!plantId) return res.status(400).json({ ok: false, error: "PLANT_REQUIRED" });

    const areas = await prisma.equipmentArea.findMany({
      where: { plantId },
      orderBy: { name: "asc" },
    });

    res.json({ ok: true, result: areas });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Error obteniendo areas" });
  }
});

// CREAR AREA
app.post("/api/equipment-areas", requireAuth, requireManager, async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    if (!plantId) return res.status(400).json({ ok: false, error: "PLANT_REQUIRED" });

    const name = String(req.body?.name ?? "").trim();
    const description = req.body?.description ? String(req.body.description).trim() : null;

    if (!name) return res.status(400).json({ ok: false, error: "name es obligatorio" });

    const area = await prisma.equipmentArea.create({
      data: { plantId, name, description },
    });

    res.json({ ok: true, area });
  } catch (e) {
    console.error(e);

    if (e?.code === "P2002") {
      return res.status(409).json({ ok: false, error: "Ya existe un area con ese nombre en esta planta" });
    }

    res.status(500).json({ ok: false, error: "Error creando area" });
  }
});

// EDITAR AREA
app.put("/api/equipment-areas/:id", requireAuth, requireManager, async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    if (!plantId) return res.status(400).json({ ok: false, error: "PLANT_REQUIRED" });

    const id = Number(req.params.id);
    const name = String(req.body?.name ?? "").trim();
    const description =
      req.body?.description != null && String(req.body.description).trim() !== ""
        ? String(req.body.description).trim()
        : null;

    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "id invalido" });
    }

    if (!name) {
      return res.status(400).json({ ok: false, error: "name es obligatorio" });
    }

    const updated = await prisma.equipmentArea.updateMany({
      where: { id, plantId },
      data: { name, description },
    });

    if (!updated.count) {
      return res.status(404).json({ ok: false, error: "Area no encontrada" });
    }

    const area = await prisma.equipmentArea.findFirst({
      where: { id, plantId },
    });

    return res.json({ ok: true, area });
  } catch (e) {
    console.error("PUT /api/equipment-areas/:id ERROR", {
      message: e?.message,
      code: e?.code,
      meta: e?.meta,
    });

    if (e?.code === "P2002") {
      return res.status(409).json({ ok: false, error: "Ya existe un area con ese nombre" });
    }

    return res.status(500).json({ ok: false, error: "Error actualizando area" });
  }
});

// BORRAR AREA
app.delete("/api/equipment-areas/:id", requireAuth, requireManager, async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    if (!plantId) return res.status(400).json({ ok: false, error: "PLANT_REQUIRED" });

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "id invalido" });

    const count = await prisma.equipment.count({
      where: { areaId: id, plantId },
    });

    if (count > 0) {
      return res.status(409).json({
        ok: false,
        error: "No se puede borrar: hay equipos asignados a esta area",
      });
    }

    const deleted = await prisma.equipmentArea.deleteMany({
      where: { id, plantId },
    });

    if (!deleted.count) {
      return res.status(404).json({ ok: false, error: "Area no encontrada" });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "Error eliminando area" });
  }
});

 /* =========================
   TECHNICIANS (soft delete)
========================= */

app.get("/api/technicians", requireAuth, async (req, res) => {
  try {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("Surrogate-Control", "no-store");

    const plantId = req.currentPlantId;
    if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

    const technicians = await prisma.technician.findMany({
      where: {
        plantId,
        deletedAt: null,
      },
      orderBy: { id: "desc" },
      include: {
        executions: {
          where: { plantId },
          orderBy: [{ executedAt: "desc" }, { scheduledAt: "desc" }],
          take: 1,
          select: { executedAt: true, scheduledAt: true },
        },
        user: {
          select: {
            id: true,
            conditionReports: {
              where: { plantId },
              orderBy: [{ detectedAt: "desc" }, { createdAt: "desc" }],
              take: 1,
              select: { detectedAt: true, createdAt: true },
            },
          },
        },
      },
    });

    const result = (technicians || []).map((t) => {
      const lastExec = t.executions?.[0] ?? null;
      const execDate = lastExec?.executedAt ?? lastExec?.scheduledAt ?? null;

      const lastReport = t.user?.conditionReports?.[0] ?? null;
      const reportDate = lastReport?.detectedAt ?? lastReport?.createdAt ?? null;

      const lastActivityAt =
        [execDate, reportDate]
          .filter(Boolean)
          .map((d) => new Date(d))
          .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

      const { executions, user, ...rest } = t;
      return { ...rest, lastActivityAt };
    });

    console.log("ðŸ”¥ðŸ”¥ðŸ”¥ TECH ROUTE NUEVA", new Date().toISOString());

    console.log(
      "TECHNICIANS RESULT",
      result.map((t) => ({
        id: t.id,
        name: t.name,
        code: t.code,
        userId: t.userId,
        lastActivityAt: t.lastActivityAt,
      }))
    );

    return res.json(result);
  } catch (error) {
    console.error("Error obteniendo técnicos:", error);
    return res.status(500).json({ error: "Error obteniendo técnicos" });
  }
});

app.post("/api/technicians", requireAuth, requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

    const { name, code, specialty, status } = req.body;

    if (!name || !code || !specialty) {
      return res.status(400).json({
        error: "Nombre, código y especialidad son obligatorios",
      });
    }

    const technician = await prisma.technician.create({
      data: {
        plantId,
        name: String(name).trim(),
        code: String(code).trim().toUpperCase(),
        specialty: String(specialty).trim(),
        status: status || "Activo",
        deletedAt: null,
      },
    });

    res.status(201).json({ ...technician, lastActivityAt: null });
  } catch (error) {
    console.error("Error creando técnico:", error);

    if (error?.code === "P2002") {
      return res.status(409).json({ error: "Ya existe un tecnico con ese codigo en esta planta" });
    }

    res.status(500).json({ error: "Error creando técnico" });
  }
});

app.put("/api/technicians/:id", requireAuth, requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

    const id = Number(req.params.id);
    const { name, code, specialty, status } = req.body;

    if (!Number.isFinite(id)) return res.status(400).json({ error: "id invalido" });
    if (!name || !code || !specialty) {
      return res.status(400).json({
        error: "Nombre, codigo y especialidad son obligatorios",
      });
    }

    const existing = await prisma.technician.findFirst({
      where: { id, plantId },
      select: { id: true, deletedAt: true },
    });

    if (!existing || existing.deletedAt) {
      return res.status(404).json({ error: "Técnico no encontrado" });
    }

    const result = await prisma.technician.updateMany({
      where: { id, plantId },
      data: {
        name: String(name).trim(),
        code: String(code).trim().toUpperCase(),
        specialty: String(specialty).trim(),
        status,
      },
    });

    if (!result.count) {
      return res.status(404).json({ error: "Técnico no encontrado" });
    }

    const technician = await prisma.technician.findFirst({
      where: { id, plantId },
    });

    res.json({ ...technician, lastActivityAt: null });
  } catch (error) {
    console.error("Error actualizando técnico:", error);

    if (error?.code === "P2002") {
      return res.status(409).json({ error: "Ya existe un tecnico con ese codigo en esta planta" });
    }

    res.status(500).json({ error: "Error actualizando técnico" });
  }
});

app.delete("/api/technicians/:id", requireAuth, requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "id invalido" });

    const existing = await prisma.technician.findFirst({
      where: { id, plantId },
      select: { id: true, deletedAt: true },
    });

    if (!existing || existing.deletedAt) {
      return res.status(404).json({ error: "Técnico no encontrado" });
    }

    const result = await prisma.technician.updateMany({
      where: { id, plantId },
      data: { deletedAt: new Date() },
    });

    if (!result.count) {
      return res.status(404).json({ error: "Técnico no encontrado" });
    }

    res.json({ ok: true });
  } catch (error) {
    console.error("Error eliminando tecnico:", error);
    res.status(500).json({ error: "Error eliminando técnico" });
  }
});


 /* =========================
   ROUTES
========================= */

app.get("/api/routes/:id", requireAuth, async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "id invalido" });

    const route = await prisma.route.findFirst({
      where: { id, plantId },
      include: {
        equipment: true,
        lubricant: true,
        technician: true,
        executions: {
          where: {
            plantId,
            status: { in: ["PENDING", "OVERDUE"] },
          },
          include: {
            technician: true,
          },
          orderBy: [
            { scheduledAt: "asc" },
            { id: "asc" },
          ],
          take: 10,
        },
      },
    });

    if (!route) return res.status(404).json({ error: "Ruta no encontrada" });

    const routeLastTs =
      route?.lastDate != null ? new Date(route.lastDate).getTime() : 0;
    const nextExecution = Array.isArray(route.executions)
      ? route.executions.find((ex) => {
          const schedTs = ex?.scheduledAt ? new Date(ex.scheduledAt).getTime() : 0;
          return !routeLastTs || schedTs > routeLastTs;
        }) || null
      : null;

    res.json({
      ...route,
      assignedExecutionId: nextExecution?.id ?? null,
      technicianId: route?.technicianId ?? nextExecution?.technicianId ?? null,
      technician: route?.technician ?? nextExecution?.technician ?? null,
      nextExecutionTechnicianId: nextExecution?.technicianId ?? null,
      nextExecutionTechnician: nextExecution?.technician ?? null,
      nextExecutionAt: nextExecution?.scheduledAt ?? route.nextDate ?? null,
    });
  } catch (e) {
    console.error("Error obteniendo ruta:", e);
    res.status(500).json({ error: "Error obteniendo ruta" });
  }
});


// CREATE ROUTE
app.post(
  "/api/routes",
  requireAuth,
  requireRole(["ADMIN", "SUPERVISOR"]),
  async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const {
        name,
        equipmentId,
        lubricantType,
        quantity,
        frequencyDays,
        frequencyType,
        weeklyDays,
        monthlyAnchorDay,
        lubricantId,
        lubricantName,
        technicianId,
        unit,
        pumpStrokeValue,
        pumpStrokeUnit,
        method,
        points,
        instructions,
        nextDate,
        lastDate,
        imageUrl,
        imagePublicId,
      } = req.body;

      if (
        !name ||
        !equipmentId ||
        !lubricantType ||
        quantity === undefined ||
        frequencyDays === undefined
      ) {
        return res.status(400).json({
          error: "name, equipmentId, lubricantType, quantity y frequencyDays son obligatorios",
        });
      }

      const q = Number(quantity);
      const f = Number(frequencyDays);
      const eqId = Number(equipmentId);

      if (!Number.isFinite(q) || q < 0) {
        return res.status(400).json({ error: "quantity invalida" });
      }

      if (!Number.isFinite(f) || f <= 0) {
        return res.status(400).json({ error: "frequencyDays invalida" });
      }

      if (!Number.isFinite(eqId) || eqId <= 0) {
        return res.status(400).json({ error: "equipmentId invalido" });
      }

      const unitNorm = String(unit || "ml").trim().toUpperCase();
      const allowedUnits = ["ML", "L", "G", "KG", "BOMBAZOS"];

      if (!allowedUnits.includes(unitNorm)) {
        return res.status(400).json({ error: "unit invalida" });
      }

      const pumpStrokeValueNum =
        pumpStrokeValue === "" || pumpStrokeValue == null ? null : Number(pumpStrokeValue);

      const pumpStrokeUnitNorm =
        pumpStrokeUnit == null || String(pumpStrokeUnit).trim() === ""
          ? null
          : String(pumpStrokeUnit).trim().toLowerCase();

      if (unitNorm === "BOMBAZOS") {
        if (!Number.isFinite(pumpStrokeValueNum) || pumpStrokeValueNum <= 0) {
          return res.status(400).json({ error: "pumpStrokeValue invalido para bombazos" });
        }

        if (!["g", "kg", "ml", "l"].includes(String(pumpStrokeUnitNorm || ""))) {
          return res.status(400).json({ error: "pumpStrokeUnit invalida para bombazos" });
        }
      }

      const pointsInt =
        points === "" || points === undefined || points === null ? null : Number(points);

      if (pointsInt !== null && !Number.isFinite(pointsInt)) {
        return res.status(400).json({ error: "points debe ser numerico" });
      }

      const lubIdNum =
        lubricantId === "" || lubricantId == null ? null : Number(lubricantId);

      if (lubIdNum !== null && !Number.isFinite(lubIdNum)) {
        return res.status(400).json({ error: "lubricantId invalido" });
      }

      const normalizedFrequencyType =
        String(frequencyType || "").trim().toUpperCase() || null;

      const weeklyDaysNorm = Array.isArray(weeklyDays)
        ? Array.from(new Set(weeklyDays.map(Number)))
            .filter((n) => n >= 1 && n <= 7)
            .sort((a, b) => a - b)
        : [];

      const monthlyAnchorDayNorm =
        monthlyAnchorDay == null || monthlyAnchorDay === ""
          ? null
          : Number(monthlyAnchorDay);

      if (
        monthlyAnchorDayNorm !== null &&
        (!Number.isFinite(monthlyAnchorDayNorm) ||
          monthlyAnchorDayNorm < 1 ||
          monthlyAnchorDayNorm > 31)
      ) {
        return res.status(400).json({ error: "monthlyAnchorDay invalido" });
      }

      if (normalizedFrequencyType === "WEEKLY" && weeklyDaysNorm.length === 0) {
        return res.status(400).json({
          error: "weeklyDays es obligatorio para frecuencia semanal multiple",
        });
      }

      const equipmentExists = await prisma.equipment.findFirst({
        where: {
          id: eqId,
          plantId,
        },
        select: {
          id: true,
          routes: {
            where: {
              technicianId: { not: null },
            },
            orderBy: [{ id: "desc" }],
            take: 1,
            select: { technicianId: true },
          },
        },
      });

      if (!equipmentExists) {
        return res.status(404).json({ error: "Equipo no encontrado en la planta actual" });
      }

      if (lubIdNum !== null) {
        const lubricantExists = await prisma.lubricant.findFirst({
          where: {
            id: lubIdNum,
            plantId,
          },
          select: { id: true },
        });

        if (!lubricantExists) {
          return res.status(404).json({ error: "Lubricante no encontrado en la planta actual" });
        }
      }

      const requestedTechnicianId =
        technicianId === "" || technicianId == null ? null : Number(technicianId);

      const inheritedEquipmentTechnicianId =
        equipmentExists?.routes?.[0]?.technicianId != null
          ? Number(equipmentExists.routes[0].technicianId)
          : null;

      const assignedTechnicianId =
        requestedTechnicianId != null ? requestedTechnicianId : inheritedEquipmentTechnicianId;

      if (assignedTechnicianId !== null && !Number.isFinite(assignedTechnicianId)) {
        return res.status(400).json({ error: "technicianId invalido" });
      }

      if (assignedTechnicianId !== null) {
        const technicianExists = await prisma.technician.findFirst({
          where: {
            id: assignedTechnicianId,
            plantId,
            deletedAt: null,
          },
          select: { id: true },
        });

        if (!technicianExists) {
          return res.status(404).json({ error: "Técnico no encontrado en la planta actual" });
        }
      }

      const parsedLastDate = parseDateOrNull(lastDate);
      const parsedNextDate = resolveNextRouteDate({
        lastDate: parsedLastDate,
        nextDate,
        frequencyDays: f,
        frequencyType: normalizedFrequencyType,
        weeklyDays: weeklyDaysNorm,
        monthlyAnchorDay: monthlyAnchorDayNorm,
      });

      const normalizedName = normalizeRouteName(name);
      const normalizedMethod = normalizeRouteMethod(method);

      const duplicatedRoute = await prisma.route.findFirst({
        where: {
          plantId,
          equipmentId: eqId,
          normalizedName,
          lubricantId: lubIdNum,
          method: normalizedMethod,
        },
        select: {
          id: true,
          name: true,
        },
      });

      if (duplicatedRoute) {
        return res.status(409).json({
          error: "Ya existe una ruta activa con el mismo equipo, nombre, lubricante y metodo.",
          code: "ROUTE_DUPLICATE",
          duplicatedRouteId: duplicatedRoute.id,
        });
      }

      const routeData = {
        plant: { connect: { id: plantId } },

        name: String(name).trim().replace(/\s+/g, " "),
        normalizedName,
        lubricantType,
        quantity: q,
        frequencyDays: f,
        frequencyType: normalizedFrequencyType,
        weeklyDays: weeklyDaysNorm,
        monthlyAnchorDay:
          monthlyAnchorDayNorm ?? (parsedLastDate ? parsedLastDate.getDate() : null),
        customIntervalDays: null,

        equipment: { connect: { id: eqId } },
        technician: assignedTechnicianId
          ? { connect: { id: assignedTechnicianId } }
          : undefined,

        lubricantName: lubIdNum ? null : lubricantName?.trim?.() || lubricantName || null,
        unit: unitNorm === "BOMBAZOS" ? "BOMBAZOS" : String(unit || "ml").trim().toLowerCase(),
        pumpStrokeValue: unitNorm === "BOMBAZOS" ? pumpStrokeValueNum : null,
        pumpStrokeUnit: unitNorm === "BOMBAZOS" ? pumpStrokeUnitNorm : null,
        method: normalizedMethod,
        points: pointsInt,
        instructions: instructions?.trim?.() || instructions || null,

        lastDate: parsedLastDate,
        nextDate: parsedNextDate,

        imageUrl: imageUrl?.trim?.() || imageUrl || null,
        imagePublicId: imagePublicId?.trim?.() || imagePublicId || null,

        ...(lubIdNum ? { lubricant: { connect: { id: lubIdNum } } } : {}),
      };

      console.log(">>> routeData real =", JSON.stringify(routeData, null, 2));

      const route = await prisma.route.create({
        data: routeData,
        include: { equipment: true, lubricant: true, technician: true },
      });

      console.log(">>> route creada", route.id);

      const scheduledAt = parsedNextDate ? toSafeNoon(parsedNextDate) : toSafeNoon(new Date());

      const start = new Date(scheduledAt);
      start.setHours(0, 0, 0, 0);

      const end = new Date(scheduledAt);
      end.setHours(23, 59, 59, 999);

      const existing = await prisma.execution.findFirst({
        where: {
          plant: { id: plantId },
          routeId: route.id,
          status: "PENDING",
          scheduledAt: { gte: start, lte: end },
        },
        select: { id: true },
      });

      if (!existing) {
        await prisma.execution.create({
          data: {
            plant: { connect: { id: plantId } },
            route: { connect: { id: route.id } },
            equipment: { connect: { id: eqId } },
            status: "PENDING",
            scheduledAt,
            ...(assignedTechnicianId
              ? { technician: { connect: { id: assignedTechnicianId } } }
              : {}),
          },
        });
      }

      return res.status(201).json(route);
    } catch (error) {
      console.error("### ERROR POST ROUTES NUEVO ###", error);
      return res.status(500).json({ error: "Error creando ruta NUEVO" });
    }
  }
);

// GET ROUTES
app.get("/api/routes", requireAuth, async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

    const routes = await prisma.route.findMany({
      where: { plantId },
      include: {
        equipment: true,
        lubricant: true,
        technician: true,
        executions: {
          where: {
            plantId,
            status: { in: ["PENDING", "OVERDUE"] },
          },
          include: {
            technician: true,
          },
          orderBy: [
            { scheduledAt: "asc" },
            { id: "asc" },
          ],
          take: 10,
        },
      },
      orderBy: { id: "desc" },
    });

    const out = routes.map((route) => {
      const routeLastTs =
        route?.lastDate != null ? new Date(route.lastDate).getTime() : 0;
      const nextExecution = Array.isArray(route.executions)
        ? route.executions.find((ex) => {
            const schedTs = ex?.scheduledAt ? new Date(ex.scheduledAt).getTime() : 0;
            return !routeLastTs || schedTs > routeLastTs;
          }) || null
        : null;

      return {
        ...route,
        assignedExecutionId: nextExecution?.id ?? null,
        technicianId: route?.technicianId ?? nextExecution?.technicianId ?? null,
        technician: route?.technician ?? nextExecution?.technician ?? null,
        nextExecutionTechnicianId: nextExecution?.technicianId ?? null,
        nextExecutionTechnician: nextExecution?.technician ?? null,
        nextExecutionAt: nextExecution?.scheduledAt ?? route.nextDate ?? null,
      };
    });

    res.json(out);
  } catch (error) {
    console.error("Error obteniendo rutas:", error);
    res.status(500).json({ error: "Error obteniendo rutas" });
  }
});

// UPDATE ROUTE
app.put(
  "/api/routes/:id",
  requireAuth,
  requireRole(["ADMIN", "SUPERVISOR"]),
  async (req, res) => {
    const t0 = Date.now();
    const stamp = () => `(+${Date.now() - t0}ms)`;

    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const id = Number(req.params.id);

      console.log(
        "[PUT /api/routes/:id] start",
        {
          id,
          plantId,
          userId: req.user?.id,
          role: req.user?.role,
        },
        stamp()
      );

      const {
        name,
        lubricantType,
        lubricantName,
        quantity,
        frequencyDays,
        frequencyType,
        weeklyDays,
        monthlyAnchorDay,
        equipmentId,
        unit,
        pumpStrokeValue,
        pumpStrokeUnit,
        method,
        points,
        instructions,
        lastDate,
        nextDate,
        technicianId,
        lubricantId,
        imageUrl,
        imagePublicId,
      } = req.body;

      const normalizedName = normalizeRouteName(name);
      const normalizedMethod = normalizeRouteMethod(method);

      console.log(
        "[PUT route] body",
        {
          id,
          plantId,
          name,
          normalizedName,
          normalizedMethod,
          equipmentId,
          lubricantType,
          quantity,
          frequencyDays,
          frequencyType,
          weeklyDays,
          monthlyAnchorDay,
          lubricantId,
          nextDate,
          unit,
          pumpStrokeValue,
          pumpStrokeUnit,
        },
        stamp()
      );

      if (!Number.isFinite(id)) return res.status(400).json({ error: "id invalido" });

      const existingRoute = await prisma.route.findFirst({
        where: { id, plantId },
        select: {
          id: true,
          imageUrl: true,
          imagePublicId: true,
        },
      });

      if (!existingRoute) {
        return res.status(404).json({ error: "Ruta no encontrada" });
      }

      if (!name || !lubricantType || !equipmentId) {
        return res.status(400).json({
          error: "name, lubricantType y equipmentId son obligatorios",
        });
      }

      const q = Number(quantity);
      const f = Number(frequencyDays);
      const eqId = Number(equipmentId);

      if (!Number.isFinite(q) || q < 0) {
        return res.status(400).json({ error: "quantity invalida" });
      }
      if (!Number.isFinite(f) || f <= 0) {
        return res.status(400).json({ error: "frequencyDays invalida" });
      }
      if (!Number.isFinite(eqId) || eqId <= 0) {
        return res.status(400).json({ error: "equipmentId invalido" });
      }

      const toNullIfEmpty = (v) => (v === "" || v === undefined ? null : v);

      const unitNorm = String(unit || "ml").trim().toUpperCase();
      const allowedUnits = ["ML", "L", "G", "KG", "BOMBAZOS"];

      if (!allowedUnits.includes(unitNorm)) {
        return res.status(400).json({ error: "unit invalida" });
      }

      const pumpStrokeValueNum =
        pumpStrokeValue === "" || pumpStrokeValue == null
          ? null
          : Number(pumpStrokeValue);

      const pumpStrokeUnitNorm =
        pumpStrokeUnit == null || String(pumpStrokeUnit).trim() === ""
          ? null
          : String(pumpStrokeUnit).trim().toLowerCase();

      if (unitNorm === "BOMBAZOS") {
        if (!Number.isFinite(pumpStrokeValueNum) || pumpStrokeValueNum <= 0) {
          return res.status(400).json({
            error: "pumpStrokeValue invalido para bombazos",
          });
        }

        if (!["g", "kg", "ml", "l"].includes(String(pumpStrokeUnitNorm || ""))) {
          return res.status(400).json({
            error: "pumpStrokeUnit invalida para bombazos",
          });
        }
      }

      const pointsInt =
        points === "" || points === undefined || points === null
          ? null
          : Number(points);

      if (pointsInt !== null && !Number.isFinite(pointsInt)) {
        return res.status(400).json({ error: "points debe ser numerico" });
      }

      const lubIdNum =
        lubricantId === "" || lubricantId == null ? null : Number(lubricantId);

      if (lubIdNum !== null && !Number.isFinite(lubIdNum)) {
        return res.status(400).json({ error: "lubricantId invalido" });
      }

      const techIdNum =
        technicianId === "" || technicianId == null ? null : Number(technicianId);

      if (techIdNum !== null && !Number.isFinite(techIdNum)) {
        return res.status(400).json({ error: "technicianId invalido" });
      }

      if (techIdNum !== null) {
        const technicianExists = await prisma.technician.findFirst({
          where: {
            id: techIdNum,
            plantId,
            deletedAt: null,
          },
          select: { id: true },
        });

        if (!technicianExists) {
          return res.status(404).json({
            error: "Técnico no encontrado en la planta actual",
          });
        }
      }

      const finalLubricantName = lubIdNum
        ? null
        : String(lubricantName || "").trim() || null;

      const equipmentExists = await prisma.equipment.findFirst({
        where: { id: eqId, plantId },
        select: { id: true },
      });

      if (!equipmentExists) {
        return res.status(404).json({
          error: "Equipo no encontrado en la planta actual",
        });
      }

      if (lubIdNum !== null) {
        const lubricantExists = await prisma.lubricant.findFirst({
          where: { id: lubIdNum, plantId },
          select: { id: true },
        });

        if (!lubricantExists) {
          return res.status(404).json({
            error: "Lubricante no encontrado en la planta actual",
          });
        }
      }

      const duplicatedRoute = await prisma.route.findFirst({
        where: {
          plantId,
          equipmentId: eqId,
          normalizedName,
          lubricantId: lubIdNum,
          method: normalizedMethod,
          id: { not: id },
        },
        select: {
          id: true,
          name: true,
        },
      });

      if (duplicatedRoute) {
        return res.status(409).json({
          error:
            "Ya existe una ruta activa con el mismo equipo, nombre, lubricante y metodo.",
          code: "ROUTE_DUPLICATE",
          duplicatedRouteId: duplicatedRoute.id,
        });
      }

      const normalizedFrequencyType =
        String(frequencyType || "").trim().toUpperCase() || null;

      const weeklyDaysNorm = Array.isArray(weeklyDays)
        ? Array.from(new Set(weeklyDays.map(Number)))
            .filter((n) => n >= 1 && n <= 7)
            .sort((a, b) => a - b)
        : [];

      const monthlyAnchorDayNorm =
        monthlyAnchorDay == null || monthlyAnchorDay === ""
          ? null
          : Number(monthlyAnchorDay);

      if (
        monthlyAnchorDayNorm !== null &&
        (!Number.isFinite(monthlyAnchorDayNorm) ||
          monthlyAnchorDayNorm < 1 ||
          monthlyAnchorDayNorm > 31)
      ) {
        return res.status(400).json({ error: "monthlyAnchorDay invalido" });
      }

      if (normalizedFrequencyType === "WEEKLY" && weeklyDaysNorm.length === 0) {
        return res.status(400).json({
          error: "weeklyDays es obligatorio para frecuencia semanal multiple",
        });
      }

      const parsedLast = parseDateOrNull(lastDate);
      const parsedNext = resolveNextRouteDate({
        lastDate: parsedLast,
        nextDate,
        frequencyDays: f,
        frequencyType: normalizedFrequencyType,
        weeklyDays: weeklyDaysNorm,
        monthlyAnchorDay: monthlyAnchorDayNorm,
      });

      console.log(
        "[PUT route] parsed dates",
        {
          lastDate,
          parsedLast: parsedLast ? parsedLast.toISOString() : null,
          nextDate,
          parsedNext: parsedNext ? parsedNext.toISOString() : null,
        },
        stamp()
      );

      const nextImageUrl =
        imageUrl == null || String(imageUrl).trim() === ""
          ? existingRoute.imageUrl
          : toNullIfEmpty(imageUrl)?.trim?.() || toNullIfEmpty(imageUrl);

      const nextImagePublicId =
        imageUrl == null || String(imageUrl).trim() === ""
          ? existingRoute.imagePublicId
          : imagePublicId == null || String(imagePublicId).trim() === ""
          ? nextImageUrl === existingRoute.imageUrl
            ? existingRoute.imagePublicId
            : null
          : toNullIfEmpty(imagePublicId)?.trim?.() || toNullIfEmpty(imagePublicId);

      const updatedCount = await prisma.route.updateMany({
        where: { id, plantId },
        data: {
          name: String(name).trim().replace(/\s+/g, " "),
          normalizedName,
          lubricantType,
          lubricantName: finalLubricantName,
          quantity: q,
          frequencyDays: f,
          frequencyType: normalizedFrequencyType,
          weeklyDays: weeklyDaysNorm,
          monthlyAnchorDay:
            monthlyAnchorDayNorm ?? (parsedLast ? parsedLast.getDate() : null),
          customIntervalDays: null,
          unit:
            unitNorm === "BOMBAZOS"
              ? "BOMBAZOS"
              : toNullIfEmpty(unit)?.trim?.().toLowerCase() || "ml",
          pumpStrokeValue: unitNorm === "BOMBAZOS" ? pumpStrokeValueNum : null,
          pumpStrokeUnit: unitNorm === "BOMBAZOS" ? pumpStrokeUnitNorm : null,
          method: normalizedMethod,
          points: pointsInt,
          instructions: toNullIfEmpty(instructions),
          lastDate: parsedLast,
          nextDate: parsedNext,
          imageUrl: nextImageUrl,
          imagePublicId: nextImagePublicId,
          equipmentId: eqId,
          lubricantId: lubIdNum,
          technicianId: techIdNum,
        },
      });

      if (!updatedCount.count) {
        return res.status(404).json({ error: "Ruta no encontrada" });
      }

      if (
        existingRoute.imagePublicId &&
        nextImagePublicId &&
        existingRoute.imagePublicId !== nextImagePublicId
      ) {
        await destroyCloudinaryImage(existingRoute.imagePublicId);
      }

      const updated = await prisma.route.findFirst({
        where: { id, plantId },
        include: { equipment: true, lubricant: true, technician: true },
      });

      console.log("[PUT route] updateMany -> OK", { id: updated?.id }, stamp());

      if (parsedNext) {
        console.log("[PUT route] align execution -> start", stamp());

        const nd = toSafeNoon(parsedNext);

        const start = startOfDay(nd);

        const end = endOfDay(nd);

        console.log(
          "[PUT route] align range",
          {
            nd: nd.toISOString(),
            start: start.toISOString(),
            end: end.toISOString(),
          },
          stamp()
        );

        const pending = await prisma.execution.findFirst({
          where: {
            plantId,
            routeId: id,
            status: { in: ["PENDING", "OVERDUE"] },
          },
          orderBy: { scheduledAt: "asc" },
          select: { id: true, scheduledAt: true, status: true },
        });

        const existingSameDay = await prisma.execution.findFirst({
          where: {
            plantId,
            routeId: id,
            status: "PENDING",
            scheduledAt: { gte: start, lte: end },
            ...(pending ? { NOT: { id: pending.id } } : {}),
          },
          select: { id: true },
        });

        if (pending) {
          if (!existingSameDay) {
            await prisma.execution.updateMany({
              where: { id: pending.id, plantId },
              data: {
                scheduledAt: nd,
                status: "PENDING",
                technicianId: techIdNum,
                equipmentId: eqId,
              },
            });
          } else {
            await prisma.execution.deleteMany({
              where: { id: pending.id, plantId },
            });
          }
        } else if (!existingSameDay) {
          await prisma.execution.create({
            data: {
              plantId,
              routeId: id,
              equipmentId: eqId,
              technicianId: techIdNum,
              status: "PENDING",
              scheduledAt: nd,
            },
          });
        }

        console.log("[PUT route] align execution -> done", stamp());
      } else {
        console.log("[PUT route] no nextDate provided, skipping align", stamp());
      }

      console.log("[PUT /api/routes/:id] done", stamp());
      return res.json(updated);
    } catch (error) {
      console.error("Error actualizando ruta:", error);
      return res.status(500).json({ error: "Error interno del servidor" });
    }
  }
);

// DELETE ROUTE
app.delete(
  "/api/routes/:id",
  requireAuth,
  requireRole(["ADMIN", "SUPERVISOR"]),
  async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "id invalido" });

      const deleted = await prisma.route.deleteMany({
        where: { id, plantId },
      });

      if (!deleted.count) {
        return res.status(404).json({ error: "Ruta no encontrada" });
      }

      res.json({ ok: true });
    } catch (error) {
      console.error("Error eliminando ruta:", error);
      res.status(500).json({ error: "Error interno del servidor" });
    }
  }
);

// ROUTE HISTORY: GET EXECUTIONS BY ROUTE
app.get("/api/routes/:id/executions", requireAuth, async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

    const routeId = Number(req.params.id);
    if (!Number.isFinite(routeId)) return res.status(400).json({ error: "routeId invalido" });

    const routeExists = await prisma.route.findFirst({
      where: { id: routeId, plantId },
      select: { id: true },
    });
    if (!routeExists) return res.status(404).json({ error: "Ruta no encontrada" });

    const role = String(req.user?.role || "").toUpperCase();
    const myTechId = req.user?.technicianId != null ? Number(req.user.technicianId) : null;

    const where =
      role === "TECHNICIAN"
        ? Number.isFinite(myTechId)
          ? { plantId, routeId, OR: [{ technicianId: null }, { technicianId: myTechId }] }
          : { plantId, routeId, technicianId: null }
        : { plantId, routeId };

    const executions = await prisma.execution.findMany({
      where,
      include: {
        technician: true,
        route: { include: { equipment: true, lubricant: true } },
      },
      orderBy: [{ scheduledAt: "desc" }, { executedAt: "desc" }, { id: "desc" }],
    });

    res.json(executions);
  } catch (error) {
    console.error("Error obteniendo historial de ruta:", error);
    res.status(500).json({ error: "Error obteniendo historial de ruta" });
  }
});

app.patch(
  "/api/executions/:id/assign",
  requireAuth,
  requireRole(["ADMIN", "SUPERVISOR"]),
  async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const id = Number(req.params.id);
      const technicianIdRaw = req.body?.technicianId;

      const technicianId =
        technicianIdRaw === null || technicianIdRaw === "" || technicianIdRaw === undefined
          ? null
          : Number(technicianIdRaw);

      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid execution id" });
      if (technicianId !== null && !Number.isFinite(technicianId)) {
        return res.status(400).json({ error: "Invalid technicianId" });
      }

      if (technicianId !== null) {
        const tech = await prisma.technician.findFirst({
          where: { id: technicianId, plantId, deletedAt: null },
          select: { id: true },
        });
        if (!tech) return res.status(400).json({ error: "Técnico inválido" });
      }

      const updated = await prisma.execution.updateMany({
        where: { id, plantId },
        data: { technicianId },
      });

      if (!updated.count) {
        return res.status(404).json({ error: "Ejecución no encontrada" });
      }

      const item = await prisma.execution.findFirst({
        where: { id, plantId },
        select: { id: true, technicianId: true },
      });

      res.json({ ok: true, item });
    } catch (e) {
      console.error("assign technician error:", e);
      res.status(500).json({ error: "Error assigning technician" });
    }
  }
);

app.patch(
  "/api/equipments/:id/assign-technician",
  requireAuth,
  requireRole(["ADMIN", "SUPERVISOR"]),
  async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const equipmentId = Number(req.params.id);
      const technicianId = Number(req.body?.technicianId);

      if (!Number.isFinite(equipmentId)) return res.status(400).json({ error: "equipmentId invalido" });
      if (!Number.isFinite(technicianId)) return res.status(400).json({ error: "technicianId invalido" });

      const force = String(req.query.force || "") === "1";

      const fromStr = String(req.query.from || "").trim();
      const from = fromStr ? parseDateOnlyLocal(fromStr) : new Date();

      if (!from) return res.status(400).json({ error: "from invalido, usa YYYY-MM-DD" });
      from.setHours(0, 0, 0, 0);

      const eq = await prisma.equipment.findFirst({
        where: { id: equipmentId, plantId },
        select: { id: true, name: true, code: true },
      });
      if (!eq) return res.status(404).json({ error: "Equipo no encontrado" });

      const tech = await prisma.technician.findFirst({
        where: { id: technicianId, plantId, deletedAt: null },
        select: { id: true, name: true, code: true, status: true },
      });
      if (!tech) return res.status(404).json({ error: "Técnico no encontrado" });

      const where = {
        plantId,
        status: { in: ["PENDING", "OVERDUE"] },
        scheduledAt: { gte: from },
        route: { equipmentId },
        ...(force ? {} : { technicianId: null }),
      };

      const updated = await prisma.execution.updateMany({
        where,
        data: { technicianId },
      });

      const routesUpdated = await prisma.route.updateMany({
        where: { plantId, equipmentId },
        data: { technicianId },
      });

      return res.json({
        ok: true,
        equipment: eq,
        technician: tech,
        updatedCount: updated.count,
        routesUpdatedCount: routesUpdated.count,
        scope: { from: from.toISOString(), force },
      });
    } catch (e) {
      console.error("assign-technician-by-equipment:", e);
      res.status(500).json({ error: "Error asignando técnico por equipo" });
    }
  }
);

app.patch(
  "/api/routes/:id/assign-technician",
  requireAuth,
  requireRole(["ADMIN", "SUPERVISOR"]),
  async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id invalido" });
      }

      const technicianIdRaw = req.body?.technicianId;
      const techId =
        technicianIdRaw === "" || technicianIdRaw == null
          ? null
          : Number(technicianIdRaw);

      if (techId !== null && !Number.isFinite(techId)) {
        return res.status(400).json({ error: "technicianId invalido" });
      }

      if (techId !== null) {
        const tech = await prisma.technician.findFirst({
          where: {
            id: techId,
            plantId,
            deletedAt: null,
          },
          select: { id: true, name: true, code: true },
        });

        if (!tech) {
          return res.status(404).json({ error: "Técnico no encontrado en la planta actual" });
        }
      }

      const exists = await prisma.route.findFirst({
        where: { id, plantId },
        select: { id: true },
      });

      if (!exists) {
        return res.status(404).json({ error: "Ruta no encontrada" });
      }

      await prisma.route.update({
        where: { id },
        data: { technicianId: techId },
      });

      await prisma.execution.updateMany({
        where: {
          plantId,
          routeId: id,
          status: { in: ["PENDING", "OVERDUE"] },
        },
        data: { technicianId: techId },
      });

      const updated = await prisma.route.findFirst({
        where: { id, plantId },
        include: {
          equipment: true,
          lubricant: true,
          technician: true,
        },
      });

      return res.json({ ok: true, item: updated });
    } catch (e) {
      console.error("assign route technician error:", e);
      return res.status(500).json({ error: "Error asignando técnico a ruta" });
    }
  }
);

  /* =========================
    LUBRICANTS (inventory)
  ========================= */

  // GET AVAILABLE FOR EXECUTION (ADMIN / SUP / TECH) - filtrado por planta
app.get(
  "/api/lubricants/available-for-execution",
  requireAuth,
  requireRole(["ADMIN", "SUPERVISOR", "TECHNICIAN"]),
  async (req, res) => {
    try {
      const plantId = req.currentPlantId;

      if (!plantId) {
        return res.status(400).json({ error: "PLANT_REQUIRED" });
      }

      const items = await prisma.lubricant.findMany({
        where: { plantId },
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          code: true,
          stock: true,
          unit: true,
        },
      });

      res.json({ items });
    } catch (error) {
      console.error("Error obteniendo lubricantes para ejecucion:", error);
      res.status(500).json({ error: "Error obteniendo lubricantes para ejecucion" });
    }
  }
);

  // GET ALL (solo ADMIN/SUP) - filtrado por planta
app.get("/api/lubricants", requireAuth, requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
  try {
    const plantId = req.currentPlantId;

    if (!plantId) {
      return res.status(400).json({ error: "PLANT_REQUIRED" });
    }

    const items = await prisma.lubricant.findMany({
      where: { plantId },
      orderBy: { id: "desc" },
    });

    res.json(items);
  } catch (error) {
    console.error("Error obteniendo lubricantes:", error);
    res.status(500).json({ error: "Error obteniendo lubricantes" });
  }
});

  // GET BY ID (solo ADMIN/SUP)
  app.get("/api/lubricants/:id", requireAuth, requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "id invalido" });

      const item = await prisma.lubricant.findFirst({ where: { id, plantId } });
      if (!item) return res.status(404).json({ error: "Lubricante no encontrado" });

      res.json(item);
    } catch (error) {
      console.error("Error obteniendo lubricante:", error);
      res.status(500).json({ error: "Error obteniendo lubricante" });
    }
  });

  // CREATE (solo ADMIN/SUP)
app.post("/api/lubricants", requireAuth, requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    if (!plantId) {
      return res.status(400).json({ error: "PLANT_REQUIRED" });
    }

    const { name, brand, type, viscosity, unit, stock, minStock, location, notes, code, supplier, unitCost } =
      req.body;

    if (!name) return res.status(400).json({ error: "name es obligatorio" });

    const stockNum = stock == null || stock === "" ? 0 : Number(stock);
    if (!Number.isFinite(stockNum) || stockNum < 0) return res.status(400).json({ error: "stock invalido" });

    const minNum = minStock == null || minStock === "" ? null : Number(minStock);
    if (minNum !== null && (!Number.isFinite(minNum) || minNum < 0)) {
      return res.status(400).json({ error: "minStock invalido" });
    }

    const unitCostNum = unitCost == null || unitCost === "" ? null : Number(unitCost);
    if (unitCostNum !== null && (!Number.isFinite(unitCostNum) || unitCostNum < 0)) {
      return res.status(400).json({ error: "unitCost invalido" });
    }

    const item = await prisma.lubricant.create({
      data: {
        plantId,
        name: String(name).trim(),
        brand: brand?.trim() || null,
        type: type?.trim() || null,
        viscosity: viscosity?.trim() || null,
        unit: unit?.trim() || "ml",
        stock: stockNum,
        minStock: minNum,
        location: location?.trim() || null,
        notes: notes?.trim() || null,
        code: code?.trim() || null,
        supplier: supplier?.trim() || null,
        unitCost: unitCostNum,
      },
    });

    res.status(201).json(item);
  } catch (error) {
    console.error("Error creando lubricante:", error);
    if (error?.code === "P2002") return res.status(400).json({ error: "Codigo ya existe" });
    res.status(500).json({ error: "Error creando lubricante" });
  }
});

  // UPDATE
  app.put("/api/lubricants/:id", requireAuth, requireRole(["ADMIN","SUPERVISOR"]), async (req,res)=>{
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "id invalido" });

      const {
        name,
        brand,
        type,
        viscosity,
        unit,
        stock,
        minStock,
        location,
        notes,
        code,
        supplier,
        unitCost,
      } = req.body;

      if (!name) return res.status(400).json({ error: "name es obligatorio" });

      const stockNum = stock == null || stock === "" ? 0 : Number(stock);
      if (!Number.isFinite(stockNum) || stockNum < 0) {
        return res.status(400).json({ error: "stock invalido" });
      }

      const minNum = minStock == null || minStock === "" ? null : Number(minStock);
      if (minNum !== null && (!Number.isFinite(minNum) || minNum < 0)) {
        return res.status(400).json({ error: "minStock invalido" });
      }

      const unitCostNum = unitCost == null || unitCost === "" ? null : Number(unitCost);
      if (unitCostNum !== null && (!Number.isFinite(unitCostNum) || unitCostNum < 0)) {
        return res.status(400).json({ error: "unitCost invalido" });
      }

      const updated = await prisma.lubricant.updateMany({
        where: { id, plantId },
        data: {
          name: String(name).trim(),
          brand: brand?.trim() || null,
          type: type?.trim() || null,
          viscosity: viscosity?.trim() || null,
          unit: unit?.trim() || "ml",
          stock: stockNum,
          minStock: minNum,
          location: location?.trim() || null,
          notes: notes?.trim() || null,
          code: code?.trim() || null,
          supplier: supplier?.trim() || null,
          unitCost: unitCostNum,
        },
      });

      if (!updated.count) {
        return res.status(404).json({ error: "Lubricante no encontrado" });
      }

      const item = await prisma.lubricant.findFirst({ where: { id, plantId } });
      res.json(item);
    } catch (error) {
      console.error("Error actualizando lubricante:", error);
      if (error?.code === "P2002") return res.status(400).json({ error: "Codigo ya existe" });
      res.status(500).json({ error: "Error actualizando lubricante" });
    }
  });

  /* =========================
    MOVEMENTS (history)
  ========================= */

  // GET MOVEMENTS BY LUBRICANT
app.get("/api/lubricants/:id/movements", requireAuth, requireRole(["ADMIN","SUPERVISOR"]), async (req,res)=>{
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "id invalido" });

      const take = Number(req.query.take ?? 80);
      const safeTake = Number.isFinite(take) ? Math.min(Math.max(take, 1), 200) : 80;

      const lubricant = await prisma.lubricant.findFirst({
        where: { id, plantId },
        select: { id: true, name: true, unit: true, stock: true },
      });
      if (!lubricant) return res.status(404).json({ error: "Lubricante no encontrado" });

      const movements = await prisma.lubricantMovement.findMany({
        where: { lubricantId: id },
        orderBy: { createdAt: "desc" },
        take: safeTake,
      });

      res.json({ ok: true, lubricant, movements });
    } catch (error) {
      console.error("Error obteniendo movimientos:", error);
      res.status(500).json({ error: "Error obteniendo historial de movimientos" });
    }
  });

  // POST MOVEMENT (CREA HISTORIAL + ACTUALIZA STOCK)
  // Acepta: { type } o { movementType } y valores IN/OUT/ADJUST o ENTRADA/SALIDA/AJUSTE
  app.post("/api/lubricants/:id/movements", requireAuth, requireRole(["ADMIN","SUPERVISOR"]), async (req,res)=>{
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "id invalido" });

      const rawType = req.body.movementType ?? req.body.type;
      const movementType = normalizeMovementType(rawType);

      if (!movementType) {
        return res.status(400).json({ error: "movementType invalido (IN/OUT/ADJUST)" });
      }

      const qty = Number(req.body.quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        return res.status(400).json({ error: "quantity inv??lida (>0)" });
      }

      const reason = req.body.reason;
      const reference = req.body.reference;

      const item = await prisma.lubricant.findFirst({
        where: { id, plantId },
        select: { id: true, stock: true, unit: true, name: true },
      });
      if (!item) return res.status(404).json({ error: "Lubricante no encontrado" });

      const settings = await prisma.appSettings.findUnique({
        where: { id: 1 },
        select: { preventNegativeStock: true },
      });

      const stockBefore = Number(item.stock || 0);

      let stockAfter = stockBefore;
      if (movementType === "IN") stockAfter = stockBefore + qty;
      if (movementType === "OUT") stockAfter = stockBefore - qty;
      if (movementType === "ADJUST") stockAfter = qty;

      const preventNegativeStock = settings?.preventNegativeStock ?? true;
      if (preventNegativeStock && stockAfter < 0) {
        return res.status(400).json({ error: "Stock insuficiente" });
      }

      const [updated, movement] = await prisma.$transaction([
        prisma.lubricant.update({
          where: { id: item.id },
          data: { stock: stockAfter },
        }),
        prisma.lubricantMovement.create({
          data: {
            lubricantId: id,
            type: movementType,
            quantity: qty,
            reason: reason?.trim?.() || reason || null,
            note: reference?.trim?.() || reference || null,
            stockBefore,
            stockAfter,
          },
        }),
      ]);

      res.status(201).json({ ok: true, updated, movement });
    } catch (error) {
      console.error("Error registrando movimiento:", error);
      res.status(500).json({ error: "Error registrando movimiento" });
    }
  });

  // DELETE
  app.delete("/api/lubricants/:id", requireAuth, requireRole(["ADMIN","SUPERVISOR"]), async (req,res)=>{ 
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "id invalido" });

      const deleted = await prisma.lubricant.deleteMany({ where: { id, plantId } });
      if (!deleted.count) return res.status(404).json({ error: "Lubricante no encontrado" });
      res.json({ ok: true });
    } catch (error) {
      console.error("Error eliminando lubricante:", error);
      res.status(500).json({ error: "Error eliminando lubricante" });
    }
  });

  /* =========================================================
    ANALYTICS: SUMMARY
    GET /analytics/summary?days=180&kind=ACEITE|GRASA|ALL&lubricantId=123
  ========================================================= */
  app.get("/api/analytics/summary", requireAuth, async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

    const daysRaw = Number(req.query.days ?? 90);
    const days = Number.isFinite(daysRaw) ? Math.min(Math.max(daysRaw, 1), 3650) : 90;

    const kind = normalizeKind(req.query.kind || "");
    const lubricantIdRaw = req.query.lubricantId;
    const lubricantId =
      lubricantIdRaw == null || String(lubricantIdRaw).trim() === ""
        ? null
        : Number(lubricantIdRaw);

    if (lubricantId != null && !Number.isFinite(lubricantId)) {
      return res.status(400).json({ error: "lubricantId invalido" });
    }

    const from = new Date();
    from.setDate(from.getDate() - days);

    const executions = await prisma.execution.findMany({
      where: {
        plantId,
        status: "COMPLETED",
        executedAt: { not: null, gte: from },
      },
      select: {
        id: true,
        executedAt: true,
        equipmentId: true,
        usedQuantity: true,
        usedInputQuantity: true,
        usedInputUnit: true,
        usedConvertedQuantity: true,
        usedConvertedUnit: true,
        equipment: {
          select: { id: true, name: true, code: true, location: true },
        },
        lubricantMovements: {
          where: { type: "OUT" },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            lubricantId: true,
            inputUnit: true,
            convertedUnit: true,
            lubricant: {
              select: { id: true, name: true, unit: true, code: true, type: true },
            },
          },
        },
        route: {
          select: {
            equipmentId: true,
            lubricantId: true,
            lubricantType: true,
            unit: true,
            equipment: {
              select: { id: true, name: true, code: true, location: true },
            },
            lubricant: {
              select: { id: true, name: true, unit: true, code: true, type: true },
            },
          },
        },
      },
      orderBy: { executedAt: "desc" },
    });

    const byEquipment = new Map();
    const byLubricant = new Map();
    const byMonth = new Map();

    for (const ex of executions) {
      try {
        if (!executionMatchesAnalyticsFilters(ex, { kind, lubricantId })) continue;

        const cons = resolveExecutionConsumptionForAnalytics(ex);
        const comparable = Number(cons.comparableBaseQuantity || 0);
        if (!(comparable > 0)) continue;

        const eq = ex?.route?.equipment || ex?.equipment || null;
        const eqId = eq?.id ?? ex?.equipmentId ?? ex?.route?.equipmentId ?? null;

        const movement = Array.isArray(ex?.lubricantMovements)
          ? ex.lubricantMovements[0] || null
          : null;
        const lub = ex?.route?.lubricant || movement?.lubricant || null;
        const lubId =
          lub?.id ?? ex?.route?.lubricantId ?? movement?.lubricantId ?? null;

        if (eqId) {
          if (!byEquipment.has(eqId)) {
            byEquipment.set(eqId, {
              id: eqId,
              name: eq?.name || "—",
              code: eq?.code || "",
              location: eq?.location || null,
              total: 0,
              totalBaseQuantity: 0,
              totalBaseUnit: cons.comparableBaseUnit || "",
              totalInputQuantity: 0,
              totalInputUnit: "",
              totalConvertedQuantity: 0,
              totalConvertedUnit: "",
              _inputUnits: new Set(),
              _convertedUnits: new Set(),
            });
          }

          const row = byEquipment.get(eqId);
          row.total += comparable;
          row.totalBaseQuantity += comparable;
          row.totalBaseUnit = row.totalBaseUnit || cons.comparableBaseUnit || "";

          if (cons.inputQuantity != null && cons.inputUnit) {
            row.totalInputQuantity += Number(cons.inputQuantity);
            row._inputUnits.add(cons.inputUnit);
          }

          if (cons.convertedQuantity != null && cons.convertedUnit) {
            row.totalConvertedQuantity += Number(cons.convertedQuantity);
            row._convertedUnits.add(cons.convertedUnit);
          }
        }

        if (lubId) {
          if (!byLubricant.has(lubId)) {
            byLubricant.set(lubId, {
              id: lubId,
              name: lub?.name || "—",
              code: lub?.code || "",
              total: 0,
              totalBaseQuantity: 0,
              totalBaseUnit: cons.comparableBaseUnit || "",
              totalInputQuantity: 0,
              totalInputUnit: "",
              totalConvertedQuantity: 0,
              totalConvertedUnit: "",
              _inputUnits: new Set(),
              _convertedUnits: new Set(),
            });
          }

          const row = byLubricant.get(lubId);
          row.total += comparable;
          row.totalBaseQuantity += comparable;
          row.totalBaseUnit = row.totalBaseUnit || cons.comparableBaseUnit || "";

          if (cons.inputQuantity != null && cons.inputUnit) {
            row.totalInputQuantity += Number(cons.inputQuantity);
            row._inputUnits.add(cons.inputUnit);
          }

          if (cons.convertedQuantity != null && cons.convertedUnit) {
            row.totalConvertedQuantity += Number(cons.convertedQuantity);
            row._convertedUnits.add(cons.convertedUnit);
          }
        }

        if (ex.executedAt) {
          const mk = monthKey(ex.executedAt);
          if (!byMonth.has(mk)) byMonth.set(mk, 0);
          byMonth.set(mk, Number(byMonth.get(mk) || 0) + comparable);
        }
      } catch (loopError) {
        console.warn("Skipping malformed execution in analytics summary:", ex?.id, loopError);
      }
    }

    const normalizeAggRow = (row) => {
      if (!row) return null;

      const inputUnits = [...(row._inputUnits || [])];
      const convertedUnits = [...(row._convertedUnits || [])];

      const inputUnit = inputUnits.length === 1 ? inputUnits[0] : null;
      const convertedUnit = convertedUnits.length === 1 ? convertedUnits[0] : row.totalBaseUnit || null;

      const rowKind = inferKindFromUnits(
        row.totalBaseUnit,
        convertedUnit,
        inputUnit
      );
      const displayTotalLabel = formatAnalyticsDisplayLabel(
        row.totalBaseQuantity,
        row.totalBaseUnit || convertedUnit || "",
        rowKind
      );

      return {
        ...row,
        total: round2(row.totalBaseQuantity),
        totalBaseQuantity: round2(row.totalBaseQuantity),
        totalBaseUnit: row.totalBaseUnit || "",
        totalInputQuantity: inputUnit ? round2(row.totalInputQuantity) : null,
        totalInputUnit: inputUnit,
        totalConvertedQuantity: convertedUnit
          ? round2(row.totalConvertedQuantity || row.totalBaseQuantity)
          : round2(row.totalBaseQuantity),
        totalConvertedUnit: convertedUnit,
        displayTotalLabel,
        displayTotal: row.totalBaseUnit
          ? `${round2(row.totalBaseQuantity)} ${row.totalBaseUnit}`
          : `${round2(row.totalBaseQuantity)}`,
        displayInput: inputUnit ? `${round2(row.totalInputQuantity)} ${inputUnit}` : null,
      };
    };

    const topEquipment = normalizeAggRow(
      [...byEquipment.values()].sort((a, b) => Number(b.totalBaseQuantity || 0) - Number(a.totalBaseQuantity || 0))[0] || null
    );

    const topLubricant = normalizeAggRow(
      [...byLubricant.values()].sort((a, b) => Number(b.totalBaseQuantity || 0) - Number(a.totalBaseQuantity || 0))[0] || null
    );

    const monthsSorted = [...byMonth.entries()]
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      .map(([month, total]) => ({ month, total: round2(total) }));

    const last = monthsSorted[monthsSorted.length - 1]?.total ?? 0;
    const prev = monthsSorted[monthsSorted.length - 2]?.total ?? null;

    const delta = prev == null ? last : last - prev;
    const deltaPct = prev == null || prev === 0 ? null : (delta / prev) * 100;

    return res.json({
      ok: true,
      days,
      kind,
      lubricantId,
      topEquipment,
      topLubricant,
      trend: {
        delta: round2(delta),
        deltaPct: deltaPct == null ? null : round2(deltaPct),
      },
      months: monthsSorted,
    });
  } catch (e) {
    console.error("Error analytics summary:", e);
    return res.status(500).json({ error: "Error analytics summary" });
  }
});

  /* =========================================================
    ANALYTICS: TOP EQUIPMENT
    GET /analytics/top-equipment?take=10&days=180&kind=ACEITE|GRASA|ALL&lubricantId=123
  ========================================================= */
 app.get("/api/analytics/top-equipment", requireAuth, async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

    const takeRaw = Number(req.query.take ?? 25);
    const take = Number.isFinite(takeRaw) ? Math.min(Math.max(takeRaw, 1), 200) : 25;

    const daysRaw = Number(req.query.days ?? 90);
    const days = Number.isFinite(daysRaw) ? Math.min(Math.max(daysRaw, 1), 3650) : 90;

    const kind = normalizeKind(req.query.kind || "");
    const lubricantIdRaw = req.query.lubricantId;
    const lubricantId =
      lubricantIdRaw == null || String(lubricantIdRaw).trim() === ""
        ? null
        : Number(lubricantIdRaw);

    if (lubricantId != null && !Number.isFinite(lubricantId)) {
      return res.status(400).json({ error: "lubricantId invalido" });
    }

    const from = new Date();
    from.setDate(from.getDate() - days);

    const executions = await prisma.execution.findMany({
      where: {
        plantId,
        status: "COMPLETED",
        executedAt: { not: null, gte: from },
      },
      select: {
        id: true,
        equipmentId: true,
        usedQuantity: true,
        usedInputQuantity: true,
        usedInputUnit: true,
        usedConvertedQuantity: true,
        usedConvertedUnit: true,
        equipment: {
          select: {
            id: true,
            name: true,
            code: true,
            location: true,
          },
        },
        lubricantMovements: {
          where: { type: "OUT" },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            lubricantId: true,
            inputUnit: true,
            convertedUnit: true,
            lubricant: {
              select: {
                id: true,
                name: true,
                unit: true,
                code: true,
                type: true,
              },
            },
          },
        },
        route: {
          select: {
            equipmentId: true,
            lubricantType: true,
            unit: true,
            lubricantId: true,
            equipment: {
              select: {
                id: true,
                name: true,
                code: true,
                location: true,
              },
            },
          },
        },
      },
      orderBy: { executedAt: "desc" },
    });

    const grouped = new Map();

    for (const ex of executions) {
      try {
        if (!executionMatchesAnalyticsFilters(ex, { kind, lubricantId })) continue;

        const eq = ex?.route?.equipment || ex?.equipment || null;
        const equipmentId = eq?.id ?? ex?.equipmentId ?? ex?.route?.equipmentId ?? null;
        if (!equipmentId) continue;

        const consumption = resolveExecutionConsumptionForAnalytics(ex);

        const comparable = Number(consumption.comparableBaseQuantity || 0);
        if (!(comparable > 0)) continue;

        if (!grouped.has(equipmentId)) {
          grouped.set(equipmentId, {
            id: equipmentId,
            name: eq?.name || "—",
            code: eq?.code || "",
            location: eq?.location || null,

            total: 0,
            totalBaseQuantity: 0,
            totalBaseUnit: consumption.comparableBaseUnit || "",

            totalInputQuantity: 0,
            totalInputUnit: "",

            totalConvertedQuantity: 0,
            totalConvertedUnit: "",

            _inputUnits: new Set(),
            _convertedUnits: new Set(),
            _hasInput: false,
            _hasConverted: false,
          });
        }

        const row = grouped.get(equipmentId);

        row.total += comparable;
        row.totalBaseQuantity += comparable;
        row.totalBaseUnit = row.totalBaseUnit || consumption.comparableBaseUnit || "";

        if (consumption.inputQuantity != null && consumption.inputUnit) {
          row.totalInputQuantity += Number(consumption.inputQuantity);
          row._inputUnits.add(consumption.inputUnit);
          row._hasInput = true;
        }

        if (consumption.convertedQuantity != null && consumption.convertedUnit) {
          row.totalConvertedQuantity += Number(consumption.convertedQuantity);
          row._convertedUnits.add(consumption.convertedUnit);
          row._hasConverted = true;
        }
      } catch (loopError) {
        console.warn("Skipping malformed execution in analytics top-equipment:", ex?.id, loopError);
      }
    }

    const result = [...grouped.values()]
      .map((row) => {
        const inputUnits = [...row._inputUnits];
        const convertedUnits = [...row._convertedUnits];

        const singleInputUnit = inputUnits.length === 1 ? inputUnits[0] : "";
        const singleConvertedUnit = convertedUnits.length === 1 ? convertedUnits[0] : "";

        return {
          id: row.id,
          name: row.name,
          code: row.code,
          location: row.location,

          // legado para no romper frontend anterior
          total: round2(row.totalBaseQuantity),

          // nuevos
          totalBaseQuantity: round2(row.totalBaseQuantity),
          totalBaseUnit: row.totalBaseUnit || "",

          totalInputQuantity:
            row._hasInput && singleInputUnit ? round2(row.totalInputQuantity) : null,
          totalInputUnit:
            row._hasInput && singleInputUnit ? singleInputUnit : null,

          totalConvertedQuantity:
            row._hasConverted && singleConvertedUnit ? round2(row.totalConvertedQuantity) : round2(row.totalBaseQuantity),
          totalConvertedUnit:
            row._hasConverted && singleConvertedUnit ? singleConvertedUnit : row.totalBaseUnit || "",

          displayTotalLabel: formatAnalyticsDisplayLabel(
            row.totalBaseQuantity,
            row.totalBaseUnit || "",
            inferKindFromUnits(row.totalBaseUnit, singleConvertedUnit, singleInputUnit)
          ),

          // strings opcionales para UI
          displayTotal: row.totalBaseUnit
            ? `${round2(row.totalBaseQuantity)} ${row.totalBaseUnit}`
            : `${round2(row.totalBaseQuantity)}`,

          displayInput:
            row._hasInput && singleInputUnit
              ? `${round2(row.totalInputQuantity)} ${singleInputUnit}`
              : null,
        };
      })
      .sort((a, b) => Number(b.totalBaseQuantity || 0) - Number(a.totalBaseQuantity || 0))
      .slice(0, take);

    return res.json({
      ok: true,
      days,
      kind,
      lubricantId,
      result,
    });
  } catch (e) {
    console.error("Error analytics top-equipment:", e);
    return res.status(500).json({ error: "Error analytics top-equipment" });
  }
});

  /* =========================================================
    ANALYTICS: MONTHLY TOTAL
    GET /analytics/monthly-total?days=365&kind=ACEITE|GRASA|ALL&lubricantId=123
  ========================================================= */
 app.get("/api/analytics/monthly-total", requireAuth, async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    if (!plantId) {
      return res.status(400).json({ error: "PLANT_REQUIRED" });
    }

    const fromDays = Number(req.query.days ?? 365);
    const days = Number.isFinite(fromDays)
      ? Math.min(Math.max(fromDays, 1), 3650)
      : 365;

    const kindRaw = String(req.query.kind ?? "ALL").toUpperCase();
    const kind = ["ALL", "GRASA", "ACEITE"].includes(kindRaw) ? kindRaw : "ALL";

    const lubricantIdRaw = req.query.lubricantId;
    const lubricantId =
      lubricantIdRaw == null || String(lubricantIdRaw).trim() === ""
        ? null
        : Number(lubricantIdRaw);

    if (lubricantId != null && !Number.isFinite(lubricantId)) {
      return res.status(400).json({ error: "lubricantId invalido" });
    }

    const from = new Date();
    from.setDate(from.getDate() - days);

    const where = {
      type: { in: ["SALIDA", "OUT"] },
      OR: [
        { createdAt: { gte: from } },
        { execution: { is: { executedAt: { gte: from } } } },
      ],
      ...(lubricantId != null ? { lubricantId } : {}),
      lubricant: {
        plantId,
        ...(kind === "GRASA"
          ? { type: { contains: "grasa", mode: "insensitive" } }
          : kind === "ACEITE"
          ? { type: { contains: "aceite", mode: "insensitive" } }
          : {}),
      },
    };

    const mvs = await prisma.lubricantMovement.findMany({
      where,
      select: {
        createdAt: true,
        quantity: true,
        execution: {
          select: {
            executedAt: true,
          },
        },
        lubricant: {
          select: {
            id: true,
            name: true,
            unit: true,
            type: true,
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    const byMonth = {};

    for (const mv of mvs) {
      const d = new Date(mv.execution?.executedAt || mv.createdAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const qBase = toBaseQuantity(mv.quantity, mv?.lubricant?.unit);
      byMonth[key] = (byMonth[key] || 0) + qBase;
    }

    const series = Object.keys(byMonth)
      .sort()
      .map((k) => ({
        month: k,
        total: byMonth[k],
      }));

    return res.json({
      ok: true,
      plantId,
      from: from.toISOString(),
      days,
      kind,
      lubricantId,
      series,
    });
  } catch (e) {
    console.error("Error analytics monthly-total:", e);
    return res.status(500).json({ error: "Error analytics monthly-total" });
  }
});

  /* =========================================================
    ANALYTICS: LUBRICANTS (para selector)
    GET /analytics/lubricants?days=3650&kind=ACEITE|GRASA|ALL
  ========================================================= */
  app.get("/api/analytics/lubricants", requireAuth, async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    if (!plantId) {
      return res.status(400).json({ error: "PLANT_REQUIRED" });
    }

    const kindRaw = String(req.query.kind ?? "ALL").toUpperCase();
    const kind = ["ALL", "GRASA", "ACEITE"].includes(kindRaw) ? kindRaw : "ALL";

    const where = {
      plantId,
      ...(kind === "GRASA"
        ? {
            type: { contains: "grasa", mode: "insensitive" },
          }
        : kind === "ACEITE"
        ? {
            type: { contains: "aceite", mode: "insensitive" },
          }
        : {}),
    };

    const lubs = await prisma.lubricant.findMany({
      where,
      select: {
        id: true,
        name: true,
        unit: true,
        type: true,
      },
      orderBy: { name: "asc" },
    });

    return res.json({
      ok: true,
      plantId,
      result: lubs,
    });
  } catch (e) {
    console.error("Error analytics lubricants:", e);
    return res.status(500).json({ error: "Error analytics lubricants" });
  }
});

  app.get("/api/analytics/failures-by-equipment", requireAuth, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const daysRaw = Number(req.query.days ?? 90);
      const days = Number.isFinite(daysRaw) ? Math.min(Math.max(daysRaw, 1), 3650) : 90;
      const from = new Date();
      from.setDate(from.getDate() - days);

      const badExecs = await prisma.execution.findMany({
        where: {
          plantId,
          status: "COMPLETED",
          executedAt: { gte: from },
          condition: { in: ["MALO", "CRITICO"] },
        },
        select: {
          executedAt: true,
          condition: true,
          route: {
            select: {
              equipmentId: true,
              equipment: {
                select: { id: true, name: true, code: true, location: true },
              },
            },
          },
          equipment: {
            select: { id: true, name: true, code: true, location: true },
          },
        },
      });

      const byEquipment = new Map();
      for (const ex of badExecs) {
        const eq = ex.route?.equipment || ex.equipment;
        const eqId = ex.route?.equipmentId ?? ex.equipment?.id;
        if (!eq || !eqId) continue;

        if (!byEquipment.has(eqId)) {
          byEquipment.set(eqId, {
            equipmentId: eq.id,
            equipmentName: eq.name,
            equipmentCode: eq.code || null,
            location: eq.location || null,
            badCount: 0,
            criticalCount: 0,
            total: 0,
            lastFailureAt: null,
          });
        }

        const row = byEquipment.get(eqId);
        row.total += 1;
        if (String(ex.condition).toUpperCase() === "CRITICO") row.criticalCount += 1;
        else row.badCount += 1;

        const ts = ex.executedAt ? new Date(ex.executedAt).getTime() : 0;
        const currentTs = row.lastFailureAt ? new Date(row.lastFailureAt).getTime() : 0;
        if (ts > currentTs) row.lastFailureAt = ex.executedAt;
      }

      const items = Array.from(byEquipment.values()).sort((a, b) => {
        if (b.total !== a.total) return b.total - a.total;
        return new Date(b.lastFailureAt || 0).getTime() - new Date(a.lastFailureAt || 0).getTime();
      });

      return res.json({ ok: true, plantId, days, items });
    } catch (e) {
      console.error("Error analytics failures-by-equipment:", e);
      return res.status(500).json({ error: "Error analytics failures-by-equipment" });
    }
  });

  app.get("/api/analytics/executions/monthly", requireAuth, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const monthsRaw = Number(req.query.months ?? 6);
      const months = Number.isFinite(monthsRaw) ? Math.min(Math.max(monthsRaw, 1), 24) : 6;
      const start = new Date();
      start.setMonth(start.getMonth() - (months - 1), 1);
      start.setHours(0, 0, 0, 0);

      const execs = await prisma.execution.findMany({
        where: {
          plantId,
          OR: [{ scheduledAt: { gte: start } }, { executedAt: { gte: start } }],
        },
        select: {
          status: true,
          scheduledAt: true,
          executedAt: true,
        },
      });

      const buckets = new Map();
      const keyFor = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

      for (let i = 0; i < months; i += 1) {
        const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
        buckets.set(keyFor(d), {
          month: keyFor(d),
          scheduled: 0,
          completed: 0,
          overdue: 0,
        });
      }

      for (const ex of execs) {
        if (ex.scheduledAt) {
          const k = keyFor(new Date(ex.scheduledAt));
          const row = buckets.get(k);
          if (row) row.scheduled += 1;
          if (row && String(ex.status).toUpperCase() === "OVERDUE") row.overdue += 1;
        }

        if (ex.executedAt && String(ex.status).toUpperCase() === "COMPLETED") {
          const k = keyFor(new Date(ex.executedAt));
          const row = buckets.get(k);
          if (row) row.completed += 1;
        }
      }

      return res.json({ ok: true, plantId, items: Array.from(buckets.values()) });
    } catch (e) {
      console.error("Error analytics executions/monthly:", e);
      return res.status(500).json({ error: "Error analytics executions/monthly" });
    }
  });

  app.get("/api/analytics/executions/summary", requireAuth, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      const last30 = new Date(now);
      last30.setDate(last30.getDate() - 30);

      const [pending, overdue, completedMonth, completed30d] = await Promise.all([
        prisma.execution.count({ where: { plantId, status: "PENDING" } }),
        prisma.execution.count({
          where: {
            plantId,
            status: { in: ["PENDING", "OVERDUE"] },
            scheduledAt: { lt: today },
          },
        }),
        prisma.execution.count({
          where: {
            plantId,
            status: "COMPLETED",
            executedAt: { gte: monthStart },
          },
        }),
        prisma.execution.count({
          where: {
            plantId,
            status: "COMPLETED",
            executedAt: { gte: last30 },
          },
        }),
      ]);

      return res.json({
        ok: true,
        plantId,
        summary: {
          pending,
          overdue,
          completedMonth,
          completed30d,
        },
      });
    } catch (e) {
      console.error("Error analytics executions/summary:", e);
      return res.status(500).json({ error: "Error analytics executions/summary" });
    }
  });

  app.get("/api/analytics/technicians/performance", requireAuth, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const daysRaw = Number(req.query.days ?? 30);
      const days = Number.isFinite(daysRaw) ? Math.min(Math.max(daysRaw, 1), 3650) : 30;
      const from = new Date();
      from.setDate(from.getDate() - days);

      const [techs, execs] = await Promise.all([
        prisma.technician.findMany({
          where: { plantId, deletedAt: null },
          select: { id: true, name: true, code: true, specialty: true, status: true },
          orderBy: { name: "asc" },
        }),
        prisma.execution.findMany({
          where: {
            plantId,
            technicianId: { not: null },
            status: "COMPLETED",
            executedAt: { gte: from },
          },
          select: {
            technicianId: true,
            executedAt: true,
            condition: true,
          },
        }),
      ]);

      const stats = new Map(
        techs.map((t) => [
          t.id,
          {
            technician: t,
            completedCount: 0,
            criticalCount: 0,
            badCount: 0,
            lastExecutionAt: null,
          },
        ])
      );

      for (const ex of execs) {
        const techId = ex.technicianId;
        if (!stats.has(techId)) continue;
        const row = stats.get(techId);
        row.completedCount += 1;
        if (String(ex.condition || "").toUpperCase() === "CRITICO") row.criticalCount += 1;
        if (String(ex.condition || "").toUpperCase() === "MALO") row.badCount += 1;

        const ts = ex.executedAt ? new Date(ex.executedAt).getTime() : 0;
        const lastTs = row.lastExecutionAt ? new Date(row.lastExecutionAt).getTime() : 0;
        if (ts > lastTs) row.lastExecutionAt = ex.executedAt;
      }

      const items = Array.from(stats.values()).sort((a, b) => {
        if (b.completedCount !== a.completedCount) return b.completedCount - a.completedCount;
        return new Date(b.lastExecutionAt || 0).getTime() - new Date(a.lastExecutionAt || 0).getTime();
      });

      return res.json({ ok: true, plantId, days, items });
    } catch (e) {
      console.error("Error analytics technicians/performance:", e);
      return res.status(500).json({ error: "Error analytics technicians/performance" });
    }
  });

const executionBaseSelect = {
  id: true,
  origin: true,
  routeId: true,
  equipmentId: true,
  manualTitle: true,
  manualInstructions: true,
  technicianId: true,
  status: true,
  scheduledAt: true,
  executedAt: true,
  usedQuantity: true,
  usedInputQuantity: true,
  usedInputUnit: true,
  usedConvertedQuantity: true,
  usedConvertedUnit: true,
  condition: true,
  observations: true,
  evidenceImage: true,
  evidenceNote: true,
  route: {
    select: {
      id: true,
      name: true,
      instructions: true,
      quantity: true,
      unit: true,
      pumpStrokeValue: true,
      pumpStrokeUnit: true,
      method: true,
      points: true,
      lubricantType: true,
      lubricantName: true,
      lubricantId: true,
      imageUrl: true,
      equipmentId: true,
      equipment: {
        select: {
          id: true,
          name: true,
          code: true,
          location: true,
          criticality: true,
        },
      },
      lubricant: {
        select: {
          id: true,
          name: true,
          code: true,
          unit: true,
        },
      },
    },
  },
  equipment: {
    select: {
      id: true,
      name: true,
      code: true,
      location: true,
      criticality: true,
    },
  },
  technician: {
    select: {
      id: true,
      name: true,
      code: true,
    },
  },
  lubricantMovements: {
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      type: true,
      quantity: true,
      inputQuantity: true,
      inputUnit: true,
      convertedQuantity: true,
      convertedUnit: true,
      createdAt: true,
      reason: true,
      note: true,
      lubricant: {
        select: {
          id: true,
          name: true,
          code: true,
          unit: true,
        },
      },
    },
  },
  correctiveReports: {
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      condition: true,
      description: true,
      detectedAt: true,
      correctiveScheduledAt: true,
    },
  },
};

function resolveExecutionStatusForUi(execution, todayStart = toStartOfDaySafe(new Date())) {
  const rawStatus = String(execution?.status || "").trim().toUpperCase();
  if (rawStatus === "COMPLETED" && execution?.executedAt) return "COMPLETED";

  const scheduledDay = execution?.scheduledAt
    ? toStartOfDaySafe(new Date(execution.scheduledAt))
    : null;

  if (scheduledDay && scheduledDay.getTime() < todayStart.getTime()) return "OVERDUE";
  if (rawStatus === "OVERDUE") return "OVERDUE";

  return "PENDING";
}

function serializeExecutionForUi(execution, todayStart = toStartOfDaySafe(new Date())) {
  if (!execution) return null;

  const correctiveReport = Array.isArray(execution.correctiveReports)
    ? execution.correctiveReports[0] || null
    : null;

  return {
    ...execution,
    status: resolveExecutionStatusForUi(execution, todayStart),
    conditionReportId: correctiveReport?.id ?? null,
    conditionReport: correctiveReport,
  };
}

app.put(
  "/api/executions/check-overdue",
  requireAuth,
  requireRole(["ADMIN", "SUPERVISOR"]),
  async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const today = toStartOfDaySafe(new Date());

      const updated = await prisma.execution.updateMany({
        where: {
          plantId,
          status: "PENDING",
          scheduledAt: { lt: today },
        },
        data: { status: "OVERDUE" },
      });

      return res.json({ ok: true, updatedCount: Number(updated?.count || 0) });
    } catch (e) {
      console.error("Error executions check-overdue:", e);
      return res.status(500).json({ error: "Error revisando actividades vencidas" });
    }
  }
);

app.get("/api/executions", requireAuth, async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

    const today = new Date();
    const todayStart = toStartOfDaySafe(today);

    const monthRaw = String(req.query.month || "").trim();
    const monthMatch = /^(\d{4})-(\d{2})$/.exec(monthRaw);
    const monthYear = monthMatch ? Number(monthMatch[1]) : today.getFullYear();
    const monthIndex = monthMatch ? Number(monthMatch[2]) - 1 : today.getMonth();

    const monthStart = new Date(monthYear, monthIndex, 1, 0, 0, 0, 0);
    const monthEnd = new Date(monthYear, monthIndex + 1, 0, 23, 59, 59, 999);

    const completedRange = String(req.query.completedRange || "MONTH")
      .trim()
      .toUpperCase();

    const completedFrom =
      completedRange === "90D"
        ? new Date(today.getFullYear(), today.getMonth(), today.getDate() - 90, 0, 0, 0, 0)
        : completedRange === "30D"
        ? new Date(today.getFullYear(), today.getMonth(), today.getDate() - 30, 0, 0, 0, 0)
        : new Date(monthStart);

    const completedTo = completedRange === "MONTH" ? new Date(monthEnd) : new Date(today);

    const technicianIdRaw = req.query.technicianId;
    const technicianId =
      technicianIdRaw == null || String(technicianIdRaw).trim() === ""
        ? null
        : Number(technicianIdRaw);
    if (technicianId != null && !Number.isFinite(technicianId)) {
      return res.status(400).json({ error: "technicianId invalido" });
    }

    const role = String(req.user?.role || "").toUpperCase();
    const myTechnicianId =
      req.user?.technicianId != null ? Number(req.user.technicianId) : null;

    const statusFilter = String(req.query.status || "")
      .trim()
      .toUpperCase();

    const limitRaw = Number(req.query.limit ?? req.query.pageSize ?? 50);
    const pageSize = Number.isFinite(limitRaw)
      ? Math.min(Math.max(limitRaw, 1), 200)
      : 50;

    const pageRaw = Number(req.query.page ?? 1);
    const page = Number.isFinite(pageRaw) ? Math.max(pageRaw, 1) : 1;

    const executions = await prisma.execution.findMany({
      where: {
        plantId,
        OR: [
          { scheduledAt: { gte: monthStart, lte: monthEnd } },
          { executedAt: { not: null, gte: completedFrom, lte: completedTo } },
        ],
      },
      select: executionBaseSelect,
      orderBy: [{ scheduledAt: "asc" }, { executedAt: "desc" }, { id: "desc" }],
    });

    let items = executions.map((execution) =>
      serializeExecutionForUi(execution, todayStart)
    );

    if (role === "TECHNICIAN" && Number.isFinite(myTechnicianId)) {
      items = items.filter((execution) => {
        const assignedId =
          execution?.technicianId != null ? Number(execution.technicianId) : null;
        return assignedId == null || assignedId === myTechnicianId;
      });
    }

    if (technicianId != null) {
      items = items.filter(
        (execution) =>
          execution?.technicianId != null &&
          Number(execution.technicianId) === technicianId
      );
    }

    if (statusFilter && ["PENDING", "OVERDUE", "COMPLETED"].includes(statusFilter)) {
      items = items.filter(
        (execution) => String(execution?.status || "").toUpperCase() === statusFilter
      );
    }

    items.sort((a, b) => {
      const aStatus = String(a?.status || "").toUpperCase();
      const bStatus = String(b?.status || "").toUpperCase();

      if (aStatus === "COMPLETED" && bStatus === "COMPLETED") {
        return new Date(b?.executedAt || 0).getTime() - new Date(a?.executedAt || 0).getTime();
      }

      if (aStatus === "COMPLETED") return 1;
      if (bStatus === "COMPLETED") return -1;

      return new Date(a?.scheduledAt || 0).getTime() - new Date(b?.scheduledAt || 0).getTime();
    });

    const total = items.length;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const start = (page - 1) * pageSize;
    const pagedItems = items.slice(start, start + pageSize);

    return res.json({
      ok: true,
      items: pagedItems,
      meta: {
        page,
        pageSize,
        total,
        pages,
      },
    });
  } catch (e) {
    console.error("Error executions list:", e);
    return res.status(500).json({ error: "Error cargando actividades" });
  }
});

app.get("/api/executions/:id", requireAuth, async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "id invalido" });

    const execution = await prisma.execution.findFirst({
      where: { id, plantId },
      select: executionBaseSelect,
    });

    if (!execution) {
      return res.status(404).json({ error: "Actividad no encontrada" });
    }

    const role = String(req.user?.role || "").toUpperCase();
    const myTechnicianId =
      req.user?.technicianId != null ? Number(req.user.technicianId) : null;

    if (role === "TECHNICIAN" && Number.isFinite(myTechnicianId)) {
      const assignedId =
        execution?.technicianId != null ? Number(execution.technicianId) : null;
      if (assignedId != null && assignedId !== myTechnicianId) {
        return res.status(403).json({ error: "No puedes ver esta actividad" });
      }
    }

    return res.json(serializeExecutionForUi(execution));
  } catch (e) {
    console.error("Error execution detail:", e);
    return res.status(500).json({ error: "Error cargando actividad" });
  }
});

app.post(
  "/api/executions",
  requireAuth,
  requireRole(["ADMIN", "SUPERVISOR"]),
  async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const equipmentId = Number(req.body?.equipmentId);
      if (!Number.isFinite(equipmentId)) {
        return res.status(400).json({ error: "equipmentId invalido" });
      }

      const equipment = await prisma.equipment.findFirst({
        where: { id: equipmentId, plantId },
        select: { id: true },
      });
      if (!equipment) {
        return res.status(404).json({ error: "Equipo no encontrado" });
      }

      const manualTitle = String(req.body?.manualTitle || "").trim();
      if (!manualTitle) {
        return res.status(400).json({ error: "manualTitle es obligatorio" });
      }

      const scheduledAt = parseDateOrNull(req.body?.scheduledAt);
      if (!scheduledAt) {
        return res.status(400).json({ error: "scheduledAt invalido" });
      }

      const evidenceImage =
        req.body?.evidenceImage != null ? String(req.body.evidenceImage).trim() : null;
      const evidenceNote =
        req.body?.evidenceNote != null ? String(req.body.evidenceNote).trim() : null;
      const uploadedEvidence = await normalizeImageInput(evidenceImage, {
        folder: "lubriplan/execution-evidence",
        publicId: `manual_execution_${equipmentId}_${Date.now()}_${Math.random()
          .toString(16)
          .slice(2)}`,
      });

      const technicianIdRaw = req.body?.technicianId;
      const technicianId =
        technicianIdRaw === null || technicianIdRaw === undefined || technicianIdRaw === ""
          ? null
          : Number(technicianIdRaw);

      if (technicianId != null && !Number.isFinite(technicianId)) {
        return res.status(400).json({ error: "technicianId invalido" });
      }

      if (technicianId != null) {
        const technician = await prisma.technician.findFirst({
          where: { id: technicianId, plantId, deletedAt: null },
          select: { id: true },
        });
        if (!technician) {
          return res.status(400).json({ error: "Tecnico invalido" });
        }
      }

      const scheduledDay = startOfDay(scheduledAt);
      const todayStart = toStartOfDaySafe(new Date());
      const initialStatus =
        scheduledDay && scheduledDay.getTime() < todayStart.getTime()
          ? "OVERDUE"
          : "PENDING";

      const created = await prisma.execution.create({
        data: {
          plantId,
          origin: "MANUAL",
          equipmentId,
          manualTitle,
          manualInstructions:
            String(req.body?.manualInstructions || "").trim() || null,
          scheduledAt,
          technicianId,
          status: initialStatus,
          evidenceImage: uploadedEvidence?.imageUrl || null,
          evidenceImagePublicId: uploadedEvidence?.imagePublicId || null,
          evidenceNote: evidenceNote || null,
        },
        select: executionBaseSelect,
      });

      if (technicianId != null) {
        try {
          await notifyTechnicianAssignee(prisma, {
            plantId,
            technicianId,
            type: "TECH_ACTIVITY_ASSIGNED",
            title: "Actividad manual asignada",
            message: `${manualTitle} programada para ${String(req.body?.scheduledAt || "").slice(0, 10)}`,
            link: "/activities",
          });
        } catch (notifyErr) {
          console.error("No se pudo notificar actividad manual al tecnico:", notifyErr);
        }
      }

      return res.status(201).json(serializeExecutionForUi(created, todayStart));
    } catch (e) {
      console.error("Error creating manual execution:", e);
      return res.status(500).json({ error: "Error programando actividad" });
    }
  }
);

app.patch(
  "/api/executions/:id/complete",
  requireAuth,
  requireRole(["ADMIN", "SUPERVISOR", "TECHNICIAN"]),
  async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) {
        return res.status(400).json({ error: "PLANT_REQUIRED" });
      }

      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "id invalido" });
      }

      const role = String(req.user?.role || "").toUpperCase();
      const myTechnicianId =
        req.user?.technicianId != null ? Number(req.user.technicianId) : null;

      const execution = await prisma.execution.findFirst({
        where: { id, plantId },
        include: {
          route: true,
          equipment: true,
        },
      });

      if (!execution) {
        return res.status(404).json({ error: "Actividad no encontrada" });
      }

      if (String(execution.status || "").toUpperCase() === "COMPLETED") {
        return res.status(400).json({ error: "La actividad ya fue completada" });
      }

      const scheduledAt = execution?.scheduledAt ? new Date(execution.scheduledAt) : null;
      if (scheduledAt && !Number.isNaN(scheduledAt.getTime())) {
        const scheduledDay = new Date(
          scheduledAt.getFullYear(),
          scheduledAt.getMonth(),
          scheduledAt.getDate(),
          0,
          0,
          0,
          0
        );
        const today = new Date();
        const todayStart = new Date(
          today.getFullYear(),
          today.getMonth(),
          today.getDate(),
          0,
          0,
          0,
          0
        );

        if (scheduledDay > todayStart) {
          return res.status(400).json({
            error: "Esta actividad esta programada para una fecha futura y no se puede completar aun.",
          });
        }
      }

      if (role === "TECHNICIAN") {
        if (!Number.isFinite(myTechnicianId)) {
          return res.status(403).json({ error: "Tu usuario no tiene técnico asociado" });
        }

        const assignedId =
          execution.technicianId != null ? Number(execution.technicianId) : null;

        const canExecute =
          assignedId === null || assignedId === myTechnicianId;

        if (!canExecute) {
          return res.status(403).json({ error: "No puedes ejecutar esta actividad" });
        }
      }

      const condition =
        req.body?.condition != null ? String(req.body.condition).trim().toUpperCase() : null;

      const observations =
        req.body?.observations != null ? String(req.body.observations).trim() : null;

      const evidenceImage =
        req.body?.evidenceImage != null ? String(req.body.evidenceImage).trim() : null;

      const evidenceNote =
        req.body?.evidenceNote != null ? String(req.body.evidenceNote).trim() : null;
      const uploadedEvidence = await normalizeImageInput(evidenceImage, {
        folder: "lubriplan/execution-evidence",
        publicId: `execution_complete_${id}_${Date.now()}_${Math.random()
          .toString(16)
          .slice(2)}`,
      });

      const settings = await prisma.appSettings.upsert({
        where: { id: 1 },
        update: {},
        create: { id: 1 },
      });

      if (settings.executionEvidenceRequired && !evidenceImage && !evidenceNote) {
        return res.status(400).json({
          error: "Evidencia obligatoria: agrega al menos una evidencia (foto o nota).",
        });
      }

      const validConditions = new Set(["BUENO", "REGULAR", "MALO", "CRITICO"]);
      if (condition && !validConditions.has(condition)) {
        return res.status(400).json({ error: "condition invalida" });
      }

      const executedAt =
        req.body?.executedAt != null
          ? parseDateOnlyLocal(String(req.body.executedAt).slice(0, 10))
          : new Date();

      if (!executedAt || Number.isNaN(executedAt.getTime())) {
        return res.status(400).json({ error: "executedAt invalida" });
      }

      const requestedTechnicianIdRaw = req.body?.technicianId;
      const requestedTechnicianId =
        requestedTechnicianIdRaw === null ||
        requestedTechnicianIdRaw === undefined ||
        requestedTechnicianIdRaw === ""
          ? null
          : Number(requestedTechnicianIdRaw);

      if (requestedTechnicianId != null && !Number.isFinite(requestedTechnicianId)) {
        return res.status(400).json({ error: "technicianId invalido" });
      }

      const finalTechnicianId =
        role === "TECHNICIAN"
          ? myTechnicianId
          : requestedTechnicianId != null
          ? requestedTechnicianId
          : execution.technicianId != null
          ? Number(execution.technicianId)
          : null;

      if (finalTechnicianId != null) {
        const technician = await prisma.technician.findFirst({
          where: { id: finalTechnicianId, plantId, deletedAt: null },
          select: { id: true },
        });
        if (!technician) {
          return res.status(400).json({ error: "Tecnico invalido" });
        }
      }

      const route = execution?.route || null;
      const isManual = String(execution?.origin || "").toUpperCase() === "MANUAL";
      const routeLubricantId =
        route?.lubricantId != null ? Number(route.lubricantId) : null;
      const routeQty = Number(route?.quantity || 0);
      const usesOptionalConsumption = isManual || !routeLubricantId || !(routeQty > 0);

      const usedQuantityRaw = req.body?.usedQuantity;
      const usedQuantity =
        usedQuantityRaw === null || usedQuantityRaw === undefined || usedQuantityRaw === ""
          ? null
          : Number(usedQuantityRaw);

      if (usedQuantity != null && (!Number.isFinite(usedQuantity) || usedQuantity <= 0)) {
        return res.status(400).json({ error: "usedQuantity invalida" });
      }

      const requestedUnit = normalizeUnit(req.body?.usedUnit || "");
      const requestedLubricantIdRaw = req.body?.usedLubricantId;
      const requestedLubricantId =
        requestedLubricantIdRaw === null ||
        requestedLubricantIdRaw === undefined ||
        requestedLubricantIdRaw === ""
          ? null
          : Number(requestedLubricantIdRaw);

      if (requestedLubricantId != null && !Number.isFinite(requestedLubricantId)) {
        return res.status(400).json({ error: "usedLubricantId invalido" });
      }

      let usedInputQuantity = null;
      let usedInputUnit = null;
      let usedConvertedQuantity = null;
      let usedConvertedUnit = null;
      let inventoryDeductedAt = null;
      let movementData = null;

      if (!usesOptionalConsumption && usedQuantity == null) {
        return res.status(400).json({
          error:
            String(route?.unit || "").trim().toUpperCase() === "BOMBAZOS"
              ? "Captura los bombazos utilizados."
              : "Captura la cantidad utilizada.",
        });
      }

      if (usedQuantity != null) {
        const lubricantId = usesOptionalConsumption ? requestedLubricantId : routeLubricantId;
        if (!Number.isFinite(lubricantId)) {
          return res.status(400).json({ error: "usedLubricantId requerido" });
        }

        const lubricant = await prisma.lubricant.findFirst({
          where: { id: lubricantId, plantId },
          select: {
            id: true,
            name: true,
            code: true,
            unit: true,
            stock: true,
          },
        });

        if (!lubricant) {
          return res.status(400).json({ error: "Lubricante invalido" });
        }

        const settingsStock = await prisma.appSettings.findUnique({
          where: { id: 1 },
          select: { preventNegativeStock: true },
        });

        const routePoints = Math.max(1, Number(route?.points || 1));
        const routeInstructions = String(route?.instructions || "");
        const isAdvancedPoints = routeInstructions.includes("PUNTOS (AVANZADO)");
        const multiplier = usesOptionalConsumption ? 1 : isAdvancedPoints ? 1 : routePoints;

        if (usesOptionalConsumption) {
          usedInputUnit = requestedUnit || normalizeUnit(lubricant.unit || "");
          if (!usedInputUnit || usedInputUnit === "BOMBAZOS") {
            return res.status(400).json({ error: "usedUnit invalida" });
          }

          const inventoryQty = convertUnits(
            usedQuantity,
            usedInputUnit,
            normalizeUnit(lubricant.unit || "")
          );

          if (inventoryQty == null) {
            return res.status(400).json({
              error: "No se pudo convertir la unidad capturada a la unidad del lubricante",
            });
          }

          usedInputQuantity = round2(usedQuantity);
          usedConvertedQuantity = round2(inventoryQty);
          usedConvertedUnit = normalizeUnit(lubricant.unit || "");
        } else {
          const routeUnit = normalizeUnit(route?.unit || "");
          if (!routeUnit) {
            return res.status(400).json({ error: "La ruta no tiene unidad configurada" });
          }

          usedInputQuantity = round2(usedQuantity);
          usedInputUnit = routeUnit;

          if (routeUnit === "BOMBAZOS") {
            const pumpStrokeValue = Number(route?.pumpStrokeValue || 0);
            const pumpStrokeUnit = normalizeUnit(route?.pumpStrokeUnit || "");
            if (!(pumpStrokeValue > 0) || !pumpStrokeUnit || pumpStrokeUnit === "BOMBAZOS") {
              return res.status(400).json({
                error: "La ruta por bombazos no tiene conversion de embolada configurada",
              });
            }

            usedConvertedQuantity = round2(usedQuantity * multiplier * pumpStrokeValue);
            usedConvertedUnit = pumpStrokeUnit;
          } else {
            usedConvertedQuantity = round2(usedQuantity * multiplier);
            usedConvertedUnit = routeUnit;
          }
        }

        const inventoryUnit = normalizeUnit(lubricant.unit || "");
        const inventoryQty = convertUnits(
          usedConvertedQuantity,
          usedConvertedUnit,
          inventoryUnit
        );

        if (inventoryQty == null) {
          return res.status(400).json({
            error: "No se pudo convertir el consumo final a la unidad de inventario",
          });
        }

        const stockBefore = Number(lubricant.stock || 0);
        const stockAfter = stockBefore - Number(inventoryQty);
        const preventNegativeStock = settingsStock?.preventNegativeStock ?? true;

        if (preventNegativeStock && stockAfter < 0) {
          return res.status(400).json({ error: "Stock insuficiente" });
        }

        inventoryDeductedAt = new Date(executedAt);
        movementData = {
          lubricantId: lubricant.id,
          quantity: round2(inventoryQty),
          inputQuantity: usedInputQuantity,
          inputUnit: usedInputUnit,
          convertedQuantity: usedConvertedQuantity,
          convertedUnit: usedConvertedUnit,
          stockBefore: round2(stockBefore),
          stockAfter: round2(stockAfter),
          occurredAt: new Date(executedAt),
          note: [
            `Ejecucion #${execution.id}`,
            route?.name ? `Ruta: ${route.name}` : null,
            execution?.equipment?.code || route?.equipment?.code
              ? `Equipo: ${execution?.equipment?.code || route?.equipment?.code}`
              : execution?.equipment?.name || route?.equipment?.name
              ? `Equipo: ${execution?.equipment?.name || route?.equipment?.name}`
              : null,
            usedInputQuantity != null && usedInputUnit
              ? `Captura: ${round2(usedInputQuantity)} ${usedInputUnit}`
              : null,
            usedConvertedQuantity != null && usedConvertedUnit
              ? `Final: ${round2(usedConvertedQuantity)} ${usedConvertedUnit}`
              : null,
          ]
            .filter(Boolean)
            .join(" | "),
        };
      }

      const data = {
        status: "COMPLETED",
        executedAt,
        technicianId: finalTechnicianId,
        condition,
        observations,
        evidenceImage: uploadedEvidence?.imageUrl || null,
        evidenceImagePublicId: uploadedEvidence?.imagePublicId || null,
        evidenceNote,
        usedQuantity,
        usedInputQuantity,
        usedInputUnit,
        usedConvertedQuantity,
        usedConvertedUnit,
        inventoryDeductedAt,
      };

      const updated = await prisma.$transaction(async (tx) => {
        const saved = await tx.execution.update({
          where: { id },
          data,
        });

        if (movementData) {
          await tx.lubricantMovement.create({
            data: {
              executionId: saved.id,
              lubricantId: movementData.lubricantId,
              type: "OUT",
              quantity: movementData.quantity,
              inputQuantity: movementData.inputQuantity,
              inputUnit: movementData.inputUnit,
              convertedQuantity: movementData.convertedQuantity,
              convertedUnit: movementData.convertedUnit,
              reason: "EXECUTION",
              note: movementData.note,
              stockBefore: movementData.stockBefore,
              stockAfter: movementData.stockAfter,
              createdAt: movementData.occurredAt,
            },
          });

          await tx.lubricant.updateMany({
            where: { id: movementData.lubricantId, plantId },
            data: { stock: movementData.stockAfter },
          });
        }

        if (route?.id) {
          const executedDay = startOfDay(executedAt);
          const nextRouteDate = resolveNextRouteDate({
            lastDate: executedDay,
            nextDate: null,
            frequencyDays: route.frequencyDays,
            frequencyType: route.frequencyType,
            weeklyDays: Array.isArray(route.weeklyDays) ? route.weeklyDays : [],
            monthlyAnchorDay: route.monthlyAnchorDay,
          });

          await tx.route.updateMany({
            where: { id: route.id, plantId },
            data: {
              lastDate: executedDay,
              nextDate: nextRouteDate,
              technicianId: finalTechnicianId,
            },
          });

          if (nextRouteDate) {
            const nd = toSafeNoon(nextRouteDate);
            const start = startOfDay(nd);
            const end = endOfDay(nd);

            const pending = await tx.execution.findFirst({
              where: {
                plantId,
                routeId: route.id,
                status: { in: ["PENDING", "OVERDUE"] },
              },
              orderBy: { scheduledAt: "asc" },
              select: { id: true, scheduledAt: true, status: true },
            });

            const existingSameDay = await tx.execution.findFirst({
              where: {
                plantId,
                routeId: route.id,
                status: "PENDING",
                scheduledAt: { gte: start, lte: end },
                ...(pending ? { NOT: { id: pending.id } } : {}),
              },
              select: { id: true },
            });

            if (pending) {
              if (!existingSameDay) {
                await tx.execution.updateMany({
                  where: { id: pending.id, plantId },
                  data: {
                    scheduledAt: nd,
                    status: "PENDING",
                    technicianId: finalTechnicianId,
                    equipmentId: execution.equipmentId ?? route.equipmentId ?? null,
                  },
                });
              } else {
                await tx.execution.deleteMany({
                  where: { id: pending.id, plantId },
                });
              }
            } else if (!existingSameDay) {
              await tx.execution.create({
                data: {
                  plantId,
                  routeId: route.id,
                  equipmentId: execution.equipmentId ?? route.equipmentId ?? null,
                  technicianId: finalTechnicianId,
                  status: "PENDING",
                  scheduledAt: nd,
                },
              });
            }
          }
        }

        return tx.execution.findFirst({
          where: { id: saved.id, plantId },
          select: executionBaseSelect,
        });
      });

      if (!updated) {
        return res.status(500).json({ error: "No se pudo refrescar la actividad completada" });
      }

      if (condition === "CRITICO") {
        try {
          await notifyManagers(prisma, {
            plantId,
            type: "EXEC_CONDITION_CRITICAL",
            title: "Actividad crítica completada",
            message: `${updated.route?.equipment?.name || updated.equipment?.name || "Equipo"}${
              updated.route?.equipment?.code || updated.equipment?.code
                ? ` (${updated.route?.equipment?.code || updated.equipment?.code})`
                : ""
            } · Ejecución #${updated.id}`,
            link: `/activities?filter=critical-risk&executionId=${updated.id}&focus=critical`,
          });

          await sendCriticalActivityEmail({
            prisma,
            payload: {
              plantId,
              plantName: null,
              equipmentName:
                updated.route?.equipment?.name ||
                updated.equipment?.name ||
                updated.manualTitle ||
                "Equipo",
              equipmentCode:
                updated.route?.equipment?.code ||
                updated.equipment?.code ||
                "",
              riskLevel: "CRÍTICO",
              reason: "Actividad completada con condición crítica",
              observation:
                updated.observations ||
                updated.evidenceNote ||
                "",
              evidenceImage: updated.evidenceImage || null,
              occurredAt: updated.executedAt || new Date(),
              suggestedAction: "Revisar la actividad y definir seguimiento inmediato.",
              link: `${process.env.APP_BASE_URL || "http://localhost:5173"}/activities?filter=critical-risk&executionId=${updated.id}&focus=critical`,
            },
          });

          sseHub.broadcast("execution.critical", {
            plantId,
            executionId: updated.id,
            equipmentId: updated.route?.equipment?.id ?? updated.equipment?.id ?? null,
            equipmentName: updated.route?.equipment?.name ?? updated.equipment?.name ?? null,
            equipmentCode: updated.route?.equipment?.code ?? updated.equipment?.code ?? null,
            routeName: updated.route?.name ?? null,
            executedAt: updated.executedAt,
          });
        } catch (notifyErr) {
          console.error("No se pudo notificar ejecucion critica:", notifyErr);
        }
      }

      return res.json({ ok: true, item: updated });
    } catch (e) {
      console.error("complete execution error:", e);
      return res.status(500).json({ error: "Error completando actividad" });
    }
  }
);



  // =========================
  // HISTORY (COMPLETED EXECUTIONS)
  // GET /history/executions?from=YYYY-MM-DD&to=YYYY-MM-DD&page=1&pageSize=20&condition=CRITICO&q=texto
  // + NUEVO: /history/executions?filter=bad-condition&month=YYYY-MM
  // =========================
  app.get("/api/history/executions", requireAuth, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });
      const fromStr = String(req.query.from || "");
      const toStr = String(req.query.to || "");
      const monthStr = String(req.query.month || "").trim(); // nuevo
      const filter = String(req.query.filter || "").trim().toLowerCase(); // nuevo

      const conditionRaw = String(req.query.condition || "").toUpperCase().trim(); // ALL | BUENO | ...
      const q = String(req.query.q || "").trim();

      const pageRaw = Number(req.query.page || 1);
      const pageSizeRaw = Number(req.query.pageSize || 20);

      const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
      const pageSize = Number.isFinite(pageSizeRaw) ? Math.min(Math.max(1, pageSizeRaw), 200) : 20;

      // =========================
      // Rangos: from/to o month
      // =========================
      const parseMonthRangeLocal = (ym) => {
        if (!/^\d{4}-\d{2}$/.test(String(ym || ""))) return null;
        const [y, m] = String(ym).split("-").map(Number);
        if (!Number.isFinite(y) || !Number.isFinite(m)) return null;

        const from = new Date(y, m - 1, 1, 0, 0, 0, 0);
        const to = new Date(y, m, 0, 23, 59, 59, 999);
        return { from, to };
      };

      const parseQueryDateLocal = (value, endOfDay = false) => {
        if (!value) return null;
        const local = parseDateOnlyLocal(String(value).slice(0, 10));
        if (local && !Number.isNaN(local.getTime())) {
          if (endOfDay) local.setHours(23, 59, 59, 999);
          else local.setHours(0, 0, 0, 0);
          return local;
        }

        const dt = new Date(value);
        if (Number.isNaN(dt.getTime())) return null;
        if (endOfDay) dt.setHours(23, 59, 59, 999);
        else dt.setHours(0, 0, 0, 0);
        return dt;
      };

      let from = parseQueryDateLocal(fromStr, false);
      let to = parseQueryDateLocal(toStr, true);

      // Validacion minima
      if (from && Number.isNaN(from.getTime())) return res.status(400).json({ error: "from invalido" });
      if (to && Number.isNaN(to.getTime())) return res.status(400).json({ error: "to invalido" });

      // Si NO mandan from/to pero si month, usamos month
      if ((!fromStr || !toStr) && monthStr && (!from || !to)) {
        const r = parseMonthRangeLocal(monthStr);
        if (r) {
          from = r.from;
          to = r.to;
        }
      }

      // =========================
  // RBAC scope (TECHNICIAN)
  // - Historial: solo COMPLETED del tecnico
  // =========================
  const role = String(req.user?.role || "").toUpperCase();
  const myTechId = req.user?.technicianId != null ? Number(req.user.technicianId) : null;

  const scopeWhereByUser = (baseWhere = {}) => {
    if (role !== "TECHNICIAN") return baseWhere;
    if (!Number.isFinite(myTechId)) {
      // si no sabemos qué técnico es, no le muestres historial (seguro)
      return { ...baseWhere, technicianId: -1 };
    }
    return { ...baseWhere, technicianId: myTechId };
  };

      // =========================
      // Condiciones: condition o filter=bad-condition
      // =========================
      const validConditions = new Set(["BUENO", "REGULAR", "MALO", "CRITICO"]);
      const condition = validConditions.has(conditionRaw) ? conditionRaw : ""; // si viene basura, ignora

      let conditionWhere = {};
      // prioridad: si el usuario manda condition explicito, usalo
      if (condition) {
        conditionWhere = { condition };
      } else if (filter === "bad-condition") {
        // nuevo: ambas
        conditionWhere = { condition: { in: ["MALO", "CRITICO"] } };
      }

      const where = scopeWhereByUser({
         plantId,
    status: "COMPLETED",
    ...(from || to
      ? {
          executedAt: {
            ...(from ? { gte: from } : {}),
            ...(to ? { lte: to } : {}),
          },
        }
      : {}),
    ...conditionWhere,
    ...(q
      ? {
          OR: [
            { observations: { contains: q, mode: "insensitive" } },
            { manualTitle: { contains: q, mode: "insensitive" } },
            { equipment: { is: { name: { contains: q, mode: "insensitive" } } } },
            { equipment: { is: { code: { contains: q, mode: "insensitive" } } } },
            { route: { is: { name: { contains: q, mode: "insensitive" } } } },
            { route: { is: { equipment: { is: { name: { contains: q, mode: "insensitive" } } } } } },
            { route: { is: { equipment: { is: { code: { contains: q, mode: "insensitive" } } } } } },
            { route: { is: { lubricant: { is: { name: { contains: q, mode: "insensitive" } } } } } },
            { route: { is: { lubricant: { is: { code: { contains: q, mode: "insensitive" } } } } } },
            { technician: { is: { name: { contains: q, mode: "insensitive" } } } },
            { technician: { is: { code: { contains: q, mode: "insensitive" } } } },
          ],
        }
      : {}),
  });

      const skip = (page - 1) * pageSize;

      const items = await prisma.execution.findMany({
        where,
        include: {
          route: { include: { equipment: true, lubricant: true } },
          technician: true,
          lubricantMovements: {
            include: {
              lubricant: { select: { id: true, name: true, unit: true, code: true } },
            },
            orderBy: { createdAt: "desc" },
          },
        },
        orderBy: { executedAt: "desc" },
        skip,
        take: pageSize,
      });

      const total = await prisma.execution.count({ where });

      const grouped = await prisma.execution.groupBy({
        by: ["condition"],
        where,
        _count: { _all: true },
      });

      const totals = { total, BUENO: 0, REGULAR: 0, MALO: 0, CRITICO: 0 };
      for (const row of grouped) {
        const k = String(row.condition || "").toUpperCase();
        if (k in totals) totals[k] = row._count._all;
      }

      const pages = Math.max(1, Math.ceil(total / pageSize));

      return res.json({
        ok: true,
        items,
        meta: {
          page,
          pageSize,
          total,
          pages,
          totals,
          query: { filter, month: monthStr, condition: conditionRaw, from: fromStr, to: toStr }, // opcional, util
        },
      });
    } catch (e) {
      console.error("Error history executions:", e);
      return res.status(500).json({ error: "Error obteniendo historial" });
    }
  });


 // POST /emergency-activities
app.post("/api/emergency-activities", requireAuth, async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

    const {
      equipmentId,
      technicianId,
      emergencyReason,
      executedAt, // "YYYY-MM-DD"
      lubricantId,
      quantity,
      unit,
      condition,
      observations,
      evidenceImage,
      evidenceNote,
    } = req.body || {};

    if (!equipmentId) return res.status(400).json({ error: "equipmentId requerido" });
    if (!technicianId) return res.status(400).json({ error: "technicianId requerido" });
    if (!emergencyReason?.trim()) return res.status(400).json({ error: "emergencyReason requerido" });
    if (!executedAt) return res.status(400).json({ error: "executedAt requerido" });
    if (!lubricantId) return res.status(400).json({ error: "lubricantId requerido" });

    const equipmentIdNum = Number(equipmentId);
    const lubricantIdNum = Number(lubricantId);

    if (!Number.isFinite(equipmentIdNum) || equipmentIdNum <= 0) {
      return res.status(400).json({ error: "equipmentId invalido" });
    }

    if (!Number.isFinite(lubricantIdNum) || lubricantIdNum <= 0) {
      return res.status(400).json({ error: "lubricantId invalido" });
    }

    const role = String(req.user?.role || "").toUpperCase();
    const myTechId = req.user?.technicianId != null ? Number(req.user.technicianId) : null;

    const finalTechnicianId =
      role === "TECHNICIAN"
        ? myTechId
        : Number(technicianId);

    if (!finalTechnicianId || !Number.isFinite(finalTechnicianId)) {
      return res.status(400).json({ error: "technicianId requerido" });
    }

    const tech = await prisma.technician.findFirst({
      where: { id: finalTechnicianId, deletedAt: null },
      select: { id: true, name: true, code: true },
    });
    if (!tech) {
      return res.status(400).json({ error: "Técnico inválido" });
    }

    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ error: "quantity invalida" });
    }

    const execDate = parseDateOnlyLocal(String(executedAt).slice(0, 10));
    if (!execDate || Number.isNaN(execDate.getTime())) {
      return res.status(400).json({ error: "executedAt invalida" });
    }

    const conditionNorm = String(condition || "BUENO").trim().toUpperCase();
    const allowedConditions = ["BUENO", "REGULAR", "MALO", "CRITICO"];
    if (!allowedConditions.includes(conditionNorm)) {
      return res.status(400).json({ error: "condition invalida" });
    }

    const uploadedEvidence = await normalizeImageInput(evidenceImage, {
      folder: "lubriplan/execution-evidence",
      publicId: `emergency_${equipmentIdNum}_${Date.now()}_${Math.random()
        .toString(16)
        .slice(2)}`,
    });

    const result = await prisma.$transaction(async (tx) => {
      // OK equipo debe ser de la planta actual
      const eq = await tx.equipment.findFirst({
        where: { id: equipmentIdNum, plantId },
        select: { id: true, name: true, code: true },
      });
      if (!eq) throw new Error("Equipo no encontrado en la planta actual");

      // OK lubricante debe ser de la planta actual
      const lub = await tx.lubricant.findFirst({
        where: { id: lubricantIdNum, plantId },
        select: {
          id: true,
          name: true,
          unit: true,
          type: true,
          stock: true,
          minStock: true,
        },
      });
      if (!lub) throw new Error("Lubricante no encontrado en la planta actual");

      const finalUnit = String(unit || lub.unit || "ml").trim().toLowerCase();
      const lubeType = lub.type || "Otro";

      // convertir a unidad de inventario
      const usedInInvUnit = convertUnits(qty, finalUnit, lub.unit || "ml");
      if (usedInInvUnit == null) {
        throw new Error("No se pudo convertir la unidad de captura a la unidad del lubricante");
      }

      const stockBefore = lub.stock != null ? Number(lub.stock) : null;
      const stockAfter =
        stockBefore != null ? Math.max(0, stockBefore - Number(usedInInvUnit)) : null;

      const manualTitle = `EMERGENTE · ${eq.name || "Equipo"} · ${String(
        emergencyReason
      )
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 80)}`.slice(0, 120);
      const manualInstructions = [
        `Motivo: ${String(emergencyReason).trim()}`,
        observations?.trim() ? `Observaciones: ${observations.trim()}` : null,
      ]
        .filter(Boolean)
        .join("\n\n");

      // 1) ejecución irrepetible completada
      const execution = await tx.execution.create({
        data: {
          plantId,
          origin: "MANUAL",
          equipmentId: eq.id,
          manualTitle,
          manualInstructions: manualInstructions || null,
          technicianId: finalTechnicianId,
          status: "COMPLETED",
          scheduledAt: execDate,
          executedAt: execDate,
          condition: conditionNorm,
          observations: manualInstructions || null,
          usedQuantity: Number(usedInInvUnit),
          usedInputQuantity: qty,
          usedInputUnit: finalUnit,
          usedConvertedQuantity: Number(usedInInvUnit),
          usedConvertedUnit: lub.unit || null,
          evidenceImage: uploadedEvidence?.imageUrl || null,
          evidenceImagePublicId: uploadedEvidence?.imagePublicId || null,
          evidenceNote:
            String(evidenceNote || "").trim() ||
            `EMERGENCY: ${String(emergencyReason).trim()}`,
          inventoryDeductedAt: execDate,
        },
        include: {
          route: { include: { equipment: true, lubricant: true } },
          technician: true,
          equipment: true,
        },
      });

      // 2) movimiento OUT
      await tx.lubricantMovement.create({
        data: {
          lubricantId: lub.id,
          executionId: execution.id,
          type: "OUT",
          quantity: Number(usedInInvUnit),
          inputQuantity: qty,
          inputUnit: finalUnit,
          convertedQuantity: Number(usedInInvUnit),
          convertedUnit: lub.unit || null,
          reason: "EMERGENCY",
          note: [
            emergencyReason.trim(),
            `Ejecución #${execution.id}`,
            `Equipo: ${eq.code || eq.name}`,
            `Captura: ${qty} ${finalUnit}`,
          ].join(" | "),
          stockBefore,
          stockAfter,
          createdAt: execDate,
        },
      });

      // 3) actualizar stock
      if (stockBefore != null && stockAfter != null) {
        await tx.lubricant.updateMany({
          where: { id: lub.id, plantId },
          data: { stock: stockAfter },
        });
      }

      return {
        execution,
        equipment: eq,
        lubricant: {
          id: lub.id,
          name: lub.name,
          unit: lub.unit,
          stockBefore,
          stockAfter,
        },
      };
    });

    // condición crítica
    if (conditionNorm === "CRITICO") {
      try {
        await notifyManagers(prisma, {
          plantId,
          type: "EXEC_CONDITION_CRITICAL",
          title: "Actividad emergente crítica",
          message: `${result.equipment?.name || "Equipo"}${
            result.equipment?.code ? ` (${result.equipment.code})` : ""
          } · Ejecución #${result.execution.id}`,
          link: `/activities?filter=critical-risk&executionId=${result.execution.id}&focus=critical`,
        });

        await sendCriticalActivityEmail({
          prisma,
          payload: {
            plantId,
            plantName: null,
            equipmentName: result.equipment?.name || "Equipo",
            equipmentCode: result.equipment?.code || "",
            riskLevel: "CRÍTICO",
            reason: "Actividad emergente completada con condición crítica",
            observation:
              result.execution?.observations ||
              result.execution?.evidenceNote ||
              "",
            evidenceImage: result.execution?.evidenceImage || null,
            occurredAt: result.execution.executedAt || new Date(),
            suggestedAction: "Revisar la actividad emergente y atender el seguimiento requerido.",
            link: `${process.env.APP_BASE_URL || "http://localhost:5173"}/activities?filter=critical-risk&executionId=${result.execution.id}&focus=critical`,
          },
        });

        sseHub.broadcast("execution.critical", {
          plantId,
          executionId: result.execution.id,
          equipmentId: result.equipment?.id ?? null,
          equipmentName: result.equipment?.name ?? null,
          equipmentCode: result.equipment?.code ?? null,
          routeName: result.execution?.route?.name ?? null,
          executedAt: result.execution.executedAt,
        });
      } catch (notifyErr) {
        console.error("No se pudo notificar ejecución crítica emergente:", notifyErr);
      }
    }

    // ðŸ”” low stock
    if (
      result.lubricant?.stockAfter != null &&
      result.lubricant?.stockBefore != null
    ) {
      const minStock = await prisma.lubricant.findFirst({
        where: { id: result.lubricant.id, plantId },
        select: { minStock: true },
      });

      if (
        minStock?.minStock != null &&
        Number(result.lubricant.stockAfter) <= Number(minStock.minStock)
      ) {
        try {
          await notifyManagers(prisma, {
            plantId,
            type: "LOW_STOCK",
            title: "Stock bajo",
            message: `${result.lubricant.name} quedo en ${result.lubricant.stockAfter} ${result.lubricant.unit || ""}`,
            link: "/inventory",
          });

          sseHub.broadcast("inventory.low-stock", {
            plantId,
            lubricantId: result.lubricant.id,
            lubricantName: result.lubricant.name,
            stockAfter: result.lubricant.stockAfter,
            unit: result.lubricant.unit || null,
          });
        } catch (notifyErr) {
          console.error("No se pudo notificar low stock:", notifyErr);
        }
      }
    }

    return res.json({ ok: true, execution: result.execution });
  } catch (e) {
    console.error("Error emergency-activities:", e);
    return res.status(500).json({ error: e?.message || "Error creando actividad emergente" });
  }
});


  // =========================
  // HISTORY: LUBRICANT MOVEMENTS (IN/OUT/ADJUST)
  // GET /history/lubricant-movements?from=YYYY-MM-DD&to=YYYY-MM-DD&page=1&pageSize=20&type=IN&q=texto
  // =========================
  // =========================
// HISTORY: LUBRICANT MOVEMENTS (IN/OUT/ADJUST)
// GET /history/lubricant-movements?from=YYYY-MM-DD&to=YYYY-MM-DD&page=1&pageSize=20&type=IN&q=texto
// MULTI-PLANTA
// =========================
app.get("/api/history/lubricant-movements", requireAuth, async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

    const fromStr = String(req.query.from || "");
    const toStr = String(req.query.to || "");
    const q = String(req.query.q || "").trim();
    const type = String(req.query.type || "").toUpperCase().trim(); // IN | OUT | ADJUST | ""

    const pageRaw = Number(req.query.page || 1);
    const pageSizeRaw = Number(req.query.pageSize || 20);

    const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
    const pageSize = Number.isFinite(pageSizeRaw)
      ? Math.min(Math.max(1, pageSizeRaw), 200)
      : 20;

    const parseQueryDateLocal = (value, endOfDay = false) => {
      if (!value) return null;
      const local = parseDateOnlyLocal(String(value).slice(0, 10));
      if (local && !Number.isNaN(local.getTime())) {
        if (endOfDay) local.setHours(23, 59, 59, 999);
        else local.setHours(0, 0, 0, 0);
        return local;
      }

      const dt = new Date(value);
      if (Number.isNaN(dt.getTime())) return null;
      if (endOfDay) dt.setHours(23, 59, 59, 999);
      else dt.setHours(0, 0, 0, 0);
      return dt;
    };

    const from = parseQueryDateLocal(fromStr, false);
    const to = parseQueryDateLocal(toStr, true);

    if (from && Number.isNaN(from.getTime())) {
      return res.status(400).json({ error: "from invalido" });
    }

    if (to && Number.isNaN(to.getTime())) {
      return res.status(400).json({ error: "to invalido" });
    }

    const role = String(req.user?.role || "").toUpperCase();
    const myTechId =
      req.user?.technicianId != null ? Number(req.user.technicianId) : null;

    // =========================
    // Base WHERE por planta
    // - manuales / ajustes sin ejecucion: se filtran por lubricant.plantId
    // - ligados a ejecucion: se filtran por execution.plantId
    // =========================
    const baseWhere = {
      AND: [
        {
          OR: [
            { lubricant: { plantId } },
            { execution: { is: { plantId } } },
          ],
        },
        ...(from || to
          ? [
              {
                OR: [
                  {
                    createdAt: {
                      ...(from ? { gte: from } : {}),
                      ...(to ? { lte: to } : {}),
                    },
                  },
                  {
                    execution: {
                      is: {
                        executedAt: {
                          ...(from ? { gte: from } : {}),
                          ...(to ? { lte: to } : {}),
                        },
                      },
                    },
                  },
                ],
              },
            ]
          : []),
        ...(type ? [{ type }] : []),
        ...(q
          ? [
              {
                OR: [
                  { reason: { contains: q, mode: "insensitive" } },
                  { note: { contains: q, mode: "insensitive" } },
                  { lubricant: { name: { contains: q, mode: "insensitive" } } },
                  { lubricant: { code: { contains: q, mode: "insensitive" } } },
                ],
              },
            ]
          : []),
      ],
    };

    // =========================
    // Scope por rol
    // =========================
    const where =
      role === "TECHNICIAN"
        ? Number.isFinite(myTechId)
          ? {
              AND: [
                baseWhere,
                {
                  execution: {
                    is: {
                      plantId,
                      technicianId: myTechId,
                    },
                  },
                },
              ],
            }
          : {
              AND: [
                baseWhere,
                { executionId: -1 },
              ],
            }
        : baseWhere;

    const skip = (page - 1) * pageSize;

    const items = await prisma.lubricantMovement.findMany({
      where,
      include: {
        lubricant: {
          select: { id: true, name: true, unit: true, code: true },
        },
        execution: {
          include: {
            route: { include: { equipment: true } },
            technician: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: pageSize,
    });

    const total = await prisma.lubricantMovement.count({ where });
    const pages = Math.max(1, Math.ceil(total / pageSize));

    const grouped = await prisma.lubricantMovement.groupBy({
      by: ["type"],
      where,
      _count: { _all: true },
    });

    const totals = { total, IN: 0, OUT: 0, ADJUST: 0 };
    for (const row of grouped) {
      const k = String(row.type || "").toUpperCase();
      if (k in totals) totals[k] = row._count._all;
    }

    return res.json({
      ok: true,
      items,
      meta: { page, pageSize, total, pages, totals },
    });
  } catch (e) {
    console.error("Error history lubricant-movements:", e);
    return res.status(500).json({
      error: "Error obteniendo movimientos",
      detail: e?.message || null,
    });
  }
});

  // =========================
  // GET /alerts/technician-overload?windowDays=7&overdueLookbackDays=30&capacityPerDay=6&warnRatio=1.1&criticalRatio=1.4
  // Devuelve tecnicos con carga vs capacidad (PENDING/OVERDUE)
  // =========================
  app.get(
    "/api/alerts/technician-overload",
    requireAuth,
    requireRole(["ADMIN", "SUPERVISOR"]),
    async (req, res) => {

    try {
      const plantId = req.currentPlantId;
      if (!plantId) return res.status(400).json({ error: "PLANT_REQUIRED" });

      const windowDaysRaw = Number(req.query.windowDays ?? 7);
      const overdueLookbackDaysRaw = Number(req.query.overdueLookbackDays ?? 30);
      const capacityPerDayRaw = Number(req.query.capacityPerDay ?? 6);

      const warnRatioRaw = Number(req.query.warnRatio ?? 1.1);
      const criticalRatioRaw = Number(req.query.criticalRatio ?? 1.4);

      const windowDays = Number.isFinite(windowDaysRaw) ? Math.min(Math.max(windowDaysRaw, 1), 60) : 7;
      const overdueLookbackDays = Number.isFinite(overdueLookbackDaysRaw)
        ? Math.min(Math.max(overdueLookbackDaysRaw, 1), 365)
        : 30;

      const capacityPerDay = Number.isFinite(capacityPerDayRaw) ? Math.min(Math.max(capacityPerDayRaw, 1), 50) : 6;

      const warnRatio = Number.isFinite(warnRatioRaw) ? Math.min(Math.max(warnRatioRaw, 0.5), 5) : 1.1;
      const criticalRatio = Number.isFinite(criticalRatioRaw) ? Math.min(Math.max(criticalRatioRaw, warnRatio), 6) : 1.4;

      const now = new Date();

      const fromDate = new Date(now);
      fromDate.setDate(fromDate.getDate() - overdueLookbackDays);
      fromDate.setHours(0, 0, 0, 0);

      const toDate = new Date(now);
      toDate.setDate(toDate.getDate() + windowDays);
      toDate.setHours(23, 59, 59, 999);

      // capacidad simple: actividades por dia * dias de ventana
      const capacity = capacityPerDay * windowDays;

      // 1) Conteo por tecnico (solo tareas con tecnico asignado)
      const grouped = await prisma.execution.groupBy({
        by: ["technicianId"],
        where: {
          plantId,
          status: { in: ["PENDING", "OVERDUE"] },
          scheduledAt: { gte: fromDate, lte: toDate },
          technicianId: { not: null },
        },
        _count: { _all: true },
      });

      const techIds = grouped.map((g) => g.technicianId).filter(Boolean);

      // 2) Traer nombres de tecnicos
      const techs = await prisma.technician.findMany({
        where: { id: { in: techIds }, plantId, deletedAt: null },
        select: { id: true, name: true }, // ajusta campos si tu modelo usa otros
      });

      const techById = new Map(techs.map((t) => [t.id, t]));

      // 3) Tambien detectamos "sin tecnico"
      const unassignedCount = await prisma.execution.count({
        where: {
          plantId,
          status: { in: ["PENDING", "OVERDUE"] },
          scheduledAt: { gte: fromDate, lte: toDate },
          technicianId: null,
        },
      });

      // 4) Armar items con severidad
      const items = grouped
        .map((g) => {
          const load = g._count._all || 0;
          const ratio = capacity > 0 ? load / capacity : 0;

          let level = "OK";
          if (ratio >= criticalRatio) level = "CRITICAL";
          else if (ratio >= warnRatio) level = "WARNING";

          const tech = techById.get(g.technicianId) || { id: g.technicianId, name: "Técnico" };

          return {
            technician: tech,
            load,            // tareas en ventana
            capacity,        // capacidad calculada
            ratio,           // load/capacity
            level,           // OK/WARNING/CRITICAL
          };
        })
        .sort((a, b) => b.ratio - a.ratio);

      res.json({
        ok: true,
        meta: { windowDays, overdueLookbackDays, capacityPerDay, capacity, warnRatio, criticalRatio, fromDate, toDate },
        unassignedCount,
        items,
      });
    } catch (e) {
      console.error("Error technician-overload:", e);
      res.status(500).json({ error: "Error technician-overload" });
    }
  });

  /* ========= SERVER ========= */
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "LubriPlan API",
    env: process.env.NODE_ENV || "development",
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/health", async (req, res) => {
  try {
    return res.status(200).json({
      ok: true,
      service: "LubriPlan API",
      status: "healthy",
      uptimeSec: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      status: "unhealthy",
      error: error?.message || "Health check failed",
    });
  }
});

  const PORT = Number(process.env.PORT || 3001);
  app.listen(process.env.PORT || 3001, "0.0.0.0", () => {
  console.log(`Server running on port ${process.env.PORT || 3001}`);
});

  /* ========= CLEANUP ========= */
  process.on("SIGINT", async () => {
    try {
      await prisma.$disconnect();
    } finally {
      process.exit(0);
    }
  });













