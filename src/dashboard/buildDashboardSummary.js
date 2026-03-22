// src/dashboard/buildDashboardSummary.js

const isAdmin = (role) => role === "ADMIN";
const isTechnician = (role) => role === "TECHNICIAN";

export async function buildDashboardSummary({
  prisma,
  user,
  month,
  days,
  plantId,
  toStartOfDaySafe,
}) {
  const role = String(user?.role || "").toUpperCase();
  const myTechId = user?.technicianId != null ? Number(user.technicianId) : null;

  const safePlantId = Number(plantId);
  if (!Number.isFinite(safePlantId) || safePlantId <= 0) {
    throw new Error("PLANT_REQUIRED");
  }

  const scopeWhereByUser = (baseWhere = {}) => {
    const withPlant = { ...baseWhere, plantId: safePlantId };

    if (role !== "TECHNICIAN") return withPlant;

    if (!Number.isFinite(myTechId)) {
      return { ...withPlant, technicianId: null };
    }

    return {
      AND: [
        withPlant,
        {
          OR: [{ technicianId: null }, { technicianId: myTechId }],
        },
      ],
    };
  };

  const monthStr = String(month || "").trim();
  const now = new Date();
  const today = toStartOfDaySafe(new Date());

  const monthOk = /^\d{4}-\d{2}$/.test(monthStr);

  const fromDaysRaw = Number(days ?? 30);
  const safeDays = Number.isFinite(fromDaysRaw)
    ? Math.min(Math.max(fromDaysRaw, 1), 3650)
    : 30;

  let from;
  let to;

  if (monthOk) {
    const [y, m] = monthStr.split("-").map(Number);
    from = new Date(y, m - 1, 1, 0, 0, 0, 0);
    to = new Date(y, m, 0, 23, 59, 59, 999);
  } else {
    to = now;
    from = new Date(now);
    from.setDate(from.getDate() - safeDays);
  }

  const [totalRoutes, totalEquipments] = await Promise.all([
    prisma.route.count({
      where: { plantId: safePlantId },
    }),
    prisma.equipment.count({
      where: { plantId: safePlantId },
    }),
  ]);

  // =========================
  // KPIs actividades
  // =========================

  const completedWhere = scopeWhereByUser({
    status: "COMPLETED",
    executedAt: { gte: from, lte: to },
  });

  const completed = await prisma.execution.count({ where: completedWhere });

  const scheduledOpenExecs = await prisma.execution.findMany({
    where: scopeWhereByUser({
      scheduledAt: { gte: from, lte: to },
      status: { not: "COMPLETED" },
    }),
    select: {
      status: true,
      scheduledAt: true,
      technicianId: true,
    },
  });

  let overdue = 0;
  let pendingDue = 0;
  let unassignedPending = 0;

  for (const e of scheduledOpenExecs) {
    const sched = toStartOfDaySafe(e.scheduledAt);

    if (!e.technicianId) unassignedPending++;

    if (sched.getTime() < today.getTime()) overdue++;
    else pendingDue++;
  }

  // =========================
  // UPCOMING
  // =========================
  let upcoming = [];

  if (!isAdmin(role)) {
    upcoming = await prisma.execution.findMany({
      where: scopeWhereByUser({
        status: "PENDING",
        scheduledAt: { gte: today },
      }),
      include: {
        route: {
          include: {
            equipment: true,
            lubricant: true,
          },
        },
        technician: true,
      },
      orderBy: { scheduledAt: "asc" },
      take: 8,
    });
  } else {
    upcoming = await prisma.execution.findMany({
      where: {
        plantId: safePlantId,
        status: "PENDING",
        scheduledAt: { gte: today },
      },
      select: { technicianId: true },
    });
  }

  const upcomingMeta = isAdmin(role)
    ? {
        count: Array.isArray(upcoming) ? upcoming.length : 0,
        unassigned: Array.isArray(upcoming)
          ? upcoming.filter((x) => !x.technicianId).length
          : 0,
      }
    : null;

  const upcomingOut = isAdmin(role) ? [] : upcoming;

  // =========================
  // ALERTAS
  // =========================
  const alerts = { overdueActivities: overdue };

  const crWhereBase = {
    plantId: safePlantId,
    detectedAt: { gte: from, lte: to },
  };

  const crWhere =
    role === "TECHNICIAN"
      ? { ...crWhereBase, reportedById: user.id }
      : crWhereBase;

  const [conditionOpenCount, conditionInProgressCount] = await Promise.all([
    prisma.conditionReport.count({ where: { ...crWhere, status: "OPEN" } }),
    prisma.conditionReport.count({ where: { ...crWhere, status: "IN_PROGRESS" } }),
  ]);

  alerts.conditionOpenCount = conditionOpenCount;
  alerts.conditionInProgressCount = conditionInProgressCount;

  if (!isTechnician(role)) {
    alerts.unassignedPending = unassignedPending;
  }

  if (isAdmin(role)) {
    const lubs = await prisma.lubricant.findMany({
      where: {
        plantId: safePlantId,
        minStock: { not: null },
      },
      select: { stock: true, minStock: true },
    });

    let lowStockCount = 0;
    for (const l of lubs) {
      const min = Number(l.minStock);
      const stock = Number(l.stock);
      if (Number.isFinite(min) && Number.isFinite(stock) && stock <= min) {
        lowStockCount++;
      }
    }

    alerts.lowStockCount = lowStockCount;
  }

  // =========================
  // CONDITION REPORTS COUNTS
  // =========================
  const whereReports = { plantId: safePlantId };

  if (role === "TECHNICIAN") {
    whereReports.reportedById = user.id;
  }

  const reports = await prisma.conditionReport.groupBy({
    by: ["status"],
    where: whereReports,
    _count: { _all: true },
  });

  const conditionReports = {
    OPEN: 0,
    IN_PROGRESS: 0,
    RESOLVED: 0,
    DISMISSED: 0,
  };

  for (const r of reports) {
    conditionReports[r.status] = r._count._all;
  }

  const monthlyTotals = {
    completed,
    pending: pendingDue,
    overdue,
    total: completed + pendingDue + overdue,
  };

  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    role,
    plantId: safePlantId,

    range: monthOk
      ? { month: monthStr, from: from.toISOString(), to: to.toISOString() }
      : { days: safeDays, from: from.toISOString(), to: to.toISOString() },

    counts: {
      totalRoutes,
      totalEquipments,
    },

    activities: {
      completed,
      pending: pendingDue,
      overdue,
      total: completed + pendingDue + overdue,
      conditionReports,
    },

    monthlyTotals,
    alerts,
    upcoming: upcomingOut,
    upcomingMeta: isAdmin(role) ? upcomingMeta : undefined,
  };
}
