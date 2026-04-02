import { getPredictiveMetrics } from "./predictiveMetrics.js";

const isAdmin = (role) => role === "ADMIN";
const isTechnician = (role) => role === "TECHNICIAN";
const DEFAULT_TIMEZONE = "America/Mexico_City";

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalizeCondition(v) {
  const s = String(v || "").trim().toUpperCase();
  if (s === "CRÍTICO") return "CRITICO";
  return s;
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  const da = new Date(a);
  const db = new Date(b);
  if (!Number.isFinite(da.getTime()) || !Number.isFinite(db.getTime())) return null;

  const a0 = new Date(da.getFullYear(), da.getMonth(), da.getDate()).getTime();
  const b0 = new Date(db.getFullYear(), db.getMonth(), db.getDate()).getTime();
  return Math.floor((b0 - a0) / 86400000);
}

function dateKeyInTimezone(value, timezone = DEFAULT_TIMEZONE) {
  const dt = new Date(value);
  if (!Number.isFinite(dt.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(dt);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : "";
}

function isBeforeTodayInTimezone(value, todayKey, timezone = DEFAULT_TIMEZONE) {
  const valueKey = dateKeyInTimezone(value, timezone);
  return Boolean(valueKey) && Boolean(todayKey) && valueKey < todayKey;
}

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
  const plant = await prisma.plant.findUnique({
    where: { id: safePlantId },
    select: { timezone: true },
  });
  const plantTimezone = String(plant?.timezone || DEFAULT_TIMEZONE);
  const todayKey = dateKeyInTimezone(now, plantTimezone);

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

  const prevFrom = new Date(from);
  const prevTo = new Date(to);
  const rangeMs = to.getTime() - from.getTime();

  prevTo.setTime(from.getTime() - 1);
  prevFrom.setTime(prevTo.getTime() - rangeMs);

  const [totalRoutes, totalEquipments] = await Promise.all([
    prisma.route.count({
      where: { plantId: safePlantId },
    }),
    prisma.equipment.count({
      where: { plantId: safePlantId },
    }),
  ]);

  const completedWhere = scopeWhereByUser({
    status: "COMPLETED",
    executedAt: { gte: from, lte: to },
  });

  const completedPrevWhere = scopeWhereByUser({
    status: "COMPLETED",
    executedAt: { gte: prevFrom, lte: prevTo },
  });

  const [completed, completedPrev] = await Promise.all([
    prisma.execution.count({ where: completedWhere }),
    prisma.execution.count({ where: completedPrevWhere }),
  ]);

  const scheduledOpenExecs = await prisma.execution.findMany({
    where: scopeWhereByUser({
      scheduledAt: { gte: from, lte: to },
      status: { not: "COMPLETED" },
    }),
    select: {
      id: true,
      status: true,
      scheduledAt: true,
      technicianId: true,
      manualTitle: true,
      origin: true,
      route: {
        select: {
          id: true,
          name: true,
          equipment: {
            select: {
              id: true,
              name: true,
              code: true,
              criticality: true,
              location: true,
            },
          },
        },
      },
      equipment: {
        select: {
          id: true,
          name: true,
          code: true,
          criticality: true,
          location: true,
        },
      },
      technician: {
        select: {
          id: true,
          name: true,
          code: true,
        },
      },
    },
  });

  const scheduledOpenPrevExecs = await prisma.execution.findMany({
    where: scopeWhereByUser({
      scheduledAt: { gte: prevFrom, lte: prevTo },
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

  let overduePrev = 0;
  let pendingPrev = 0;

  for (const e of scheduledOpenExecs) {
    if (!e.technicianId) unassignedPending++;

    if (isBeforeTodayInTimezone(e?.scheduledAt, todayKey, plantTimezone)) overdue++;
    else pendingDue++;
  }

  for (const e of scheduledOpenPrevExecs) {
    if (isBeforeTodayInTimezone(e?.scheduledAt, todayKey, plantTimezone)) overduePrev++;
    else pendingPrev++;
  }

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
        equipment: true,
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

  const alerts = { overdueActivities: overdue };

  const crWhereBase = {
    plantId: safePlantId,
    detectedAt: { gte: from, lte: to },
  };

  const crWherePrevBase = {
    plantId: safePlantId,
    detectedAt: { gte: prevFrom, lte: prevTo },
  };

  const crWhere =
    role === "TECHNICIAN"
      ? { ...crWhereBase, reportedById: user.id }
      : crWhereBase;

  const crWherePrev =
    role === "TECHNICIAN"
      ? { ...crWherePrevBase, reportedById: user.id }
      : crWherePrevBase;

  const [
    conditionOpenCount,
    conditionInProgressCount,
    conditionOpenPrev,
    conditionInProgressPrev,
  ] = await Promise.all([
    prisma.conditionReport.count({ where: { ...crWhere, status: "OPEN" } }),
    prisma.conditionReport.count({ where: { ...crWhere, status: "IN_PROGRESS" } }),
    prisma.conditionReport.count({ where: { ...crWherePrev, status: "OPEN" } }),
    prisma.conditionReport.count({ where: { ...crWherePrev, status: "IN_PROGRESS" } }),
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
      select: {
        id: true,
        name: true,
        code: true,
        stock: true,
        minStock: true,
        unit: true,
      },
    });

    const lowStockItems = [];

    for (const l of lubs) {
      const min = Number(l.minStock);
      const stock = Number(l.stock);

      if (Number.isFinite(min) && Number.isFinite(stock) && stock <= min) {
        lowStockItems.push({
          id: l.id,
          name: l.name || "Lubricante",
          code: l.code || "",
          stock,
          minStock: min,
          unit: l.unit || "",
          gap: min - stock,
        });
      }
    }

    lowStockItems.sort((a, b) => toNum(b.gap) - toNum(a.gap));
    alerts.lowStockCount = lowStockItems.length;
    alerts.lowStockTop = lowStockItems.slice(0, 5);
  }

  let predictive = {
    lubricantDaysToEmptyCount: 0,
    equipmentConsumptionAnomaliesCount: 0,
    consumptionSignalsCount: 0,
    lubricantDaysToEmptyTop: [],
    equipmentConsumptionAnomaliesTop: [],
  };

  try {
    const metrics = await getPredictiveMetrics({
      prisma,
      toStartOfDaySafe,
      plantId: safePlantId,
      month: monthOk ? monthStr : "",
    });

    predictive = {
      lubricantDaysToEmptyCount: Number(metrics?.lubricantDaysToEmptyCount || 0),
      equipmentConsumptionAnomaliesCount: Number(
        metrics?.equipmentConsumptionAnomaliesCount || 0
      ),
      consumptionSignalsCount: Number(metrics?.consumptionSignalsCount || 0),
      lubricantDaysToEmptyTop: Array.isArray(metrics?.lubricantDaysToEmptyTop)
        ? metrics.lubricantDaysToEmptyTop.slice(0, 5)
        : [],
      equipmentConsumptionAnomaliesTop: Array.isArray(
        metrics?.equipmentConsumptionAnomaliesTop
      )
        ? metrics.equipmentConsumptionAnomaliesTop.slice(0, 5)
        : [],
    };
  } catch (error) {
    console.error("buildDashboardSummary predictive metrics error:", error);
  }

  alerts.daysToEmptyCount = predictive.lubricantDaysToEmptyCount;
  alerts.consumptionAnomaliesCount =
    predictive.equipmentConsumptionAnomaliesCount;
  alerts.predictiveSignalsCount = predictive.consumptionSignalsCount;

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

  const overdueTop = scheduledOpenExecs
    .map((e) => {
      const equipment = e.route?.equipment || e.equipment || null;
      const lateDays = Math.max(0, toNum(daysBetween(e.scheduledAt, today)));
      const isLate = toStartOfDaySafe(e.scheduledAt).getTime() < today.getTime();

      return {
        executionId: e.id,
        routeId: e.route?.id || null,
        activityName: e.route?.name || e.manualTitle || "Actividad",
        equipmentId: equipment?.id || null,
        equipmentName: equipment?.name || "Equipo",
        equipmentCode: equipment?.code || "",
        criticality: equipment?.criticality || null,
        location: equipment?.location || "",
        technicianId: e.technician?.id || e.technicianId || null,
        technicianName: e.technician?.name || null,
        scheduledAt: e.scheduledAt,
        overdueDays: lateDays,
        isUnassigned: !e.technicianId,
        score:
          (isLate ? 100 : 0) +
          (String(equipment?.criticality || "").toUpperCase().includes("CRIT") ? 40 : 0) +
          (lateDays * 3) +
          (!e.technicianId ? 15 : 0),
      };
    })
    .filter((x) => x.overdueDays > 0)
    .sort((a, b) => toNum(b.score) - toNum(a.score))
    .slice(0, 8);

  const unassignedPendingTop = scheduledOpenExecs
    .map((e) => {
      const equipment = e.route?.equipment || e.equipment || null;
      const sched = toStartOfDaySafe(e.scheduledAt);

      return {
        executionId: e.id,
        routeId: e.route?.id || null,
        activityName: e.route?.name || e.manualTitle || "Actividad",
        equipmentName: equipment?.name || "Equipo",
        equipmentCode: equipment?.code || "",
        criticality: equipment?.criticality || null,
        scheduledAt: e.scheduledAt,
        ageDays: Math.max(0, toNum(daysBetween(sched, today))),
      };
    })
    .filter((x) => !scheduledOpenExecs.find((e) => e.id === x.executionId)?.technicianId)
    .sort((a, b) => toNum(b.ageDays) - toNum(a.ageDays))
    .slice(0, 8);

  const conditionRows = await prisma.conditionReport.findMany({
    where: {
      ...crWhere,
      status: { in: ["OPEN", "IN_PROGRESS"] },
    },
    orderBy: [{ detectedAt: "desc" }],
    take: 40,
    include: {
      equipment: {
        select: {
          id: true,
          name: true,
          code: true,
          criticality: true,
          location: true,
        },
      },
      reportedBy: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  const conditionRiskTop = conditionRows
    .map((r) => {
      const cond = normalizeCondition(r.condition);
      const critEq = String(r.equipment?.criticality || "").toUpperCase().includes("CRIT");
      const ageDays = Math.max(0, toNum(daysBetween(r.detectedAt, today)));

      let score = 0;
      if (cond === "CRITICO") score += 100;
      else if (cond === "MALO") score += 60;
      else if (cond === "REGULAR") score += 20;

      if (r.status === "OPEN") score += 25;
      if (critEq) score += 25;
      score += ageDays * 2;

      return {
        reportId: r.id,
        status: r.status,
        condition: cond,
        equipmentId: r.equipment?.id || null,
        equipmentName: r.equipment?.name || "Equipo",
        equipmentCode: r.equipment?.code || "",
        criticality: r.equipment?.criticality || null,
        location: r.equipment?.location || "",
        detectedAt: r.detectedAt,
        ageDays,
        reportedBy: r.reportedBy?.name || null,
        description: r.description || "",
        score,
      };
    })
    .sort((a, b) => toNum(b.score) - toNum(a.score))
    .slice(0, 8);

  const equipmentRiskMap = new Map();

  for (const item of conditionRiskTop) {
    const key = String(item.equipmentId || item.equipmentCode || item.equipmentName);
    const prev = equipmentRiskMap.get(key) || {
      equipmentId: item.equipmentId,
      equipmentName: item.equipmentName,
      equipmentCode: item.equipmentCode,
      criticality: item.criticality,
      openReports: 0,
      criticalReports: 0,
      badReports: 0,
      score: 0,
    };

    prev.openReports += 1;
    if (item.condition === "CRITICO") prev.criticalReports += 1;
    if (item.condition === "MALO") prev.badReports += 1;
    prev.score += toNum(item.score);

    equipmentRiskMap.set(key, prev);
  }

  const equipmentRiskTop = [...equipmentRiskMap.values()]
    .sort((a, b) => toNum(b.score) - toNum(a.score))
    .slice(0, 6);

  const technicianLoadMap = new Map();

  for (const e of scheduledOpenExecs) {
    const key = e.technician?.id || e.technicianId || "UNASSIGNED";
    const prev = technicianLoadMap.get(key) || {
      technicianId: e.technician?.id || e.technicianId || null,
      technicianName: e.technician?.name || "Sin asignar",
      technicianCode: e.technician?.code || "",
      openAssigned: 0,
      overdueAssigned: 0,
      pendingAssigned: 0,
      score: 0,
    };

    const sched = toStartOfDaySafe(e.scheduledAt);
    const isLate = sched.getTime() < today.getTime();

    prev.openAssigned += 1;
    if (isLate) {
      prev.overdueAssigned += 1;
      prev.score += 3;
    } else {
      prev.pendingAssigned += 1;
      prev.score += 1;
    }

    technicianLoadMap.set(key, prev);
  }

  const technicianLoadTop = [...technicianLoadMap.values()]
    .sort((a, b) => toNum(b.score) - toNum(a.score))
    .slice(0, 6);

  const topLubricants = await prisma.lubricantMovement.groupBy({
    by: ["lubricantId"],
    where: {
      type: "OUT",
      createdAt: { gte: from, lte: to },
      lubricant: {
        plantId: safePlantId,
      },
      ...(role === "TECHNICIAN" && Number.isFinite(myTechId)
        ? {
            execution: {
              is: {
                technicianId: myTechId,
                plantId: safePlantId,
              },
            },
          }
        : {}),
    },
    _sum: {
      quantity: true,
    },
    orderBy: {
      _sum: {
        quantity: "desc",
      },
    },
    take: 5,
  });

  const topLubricantIds = topLubricants.map((x) => x.lubricantId).filter(Boolean);

  const topLubricantCatalog =
    topLubricantIds.length > 0
      ? await prisma.lubricant.findMany({
          where: { id: { in: topLubricantIds } },
          select: {
            id: true,
            name: true,
            code: true,
            unit: true,
            stock: true,
            minStock: true,
          },
        })
      : [];

  const topLubricantsOut = topLubricants.map((x) => {
    const ref = topLubricantCatalog.find((l) => l.id === x.lubricantId);
    return {
      lubricantId: x.lubricantId,
      name: ref?.name || "Lubricante",
      code: ref?.code || "",
      unit: ref?.unit || "",
      consumed: toNum(x?._sum?.quantity),
      stock: ref?.stock ?? null,
      minStock: ref?.minStock ?? null,
    };
  });

  const trends = {
    completedDelta: completed - completedPrev,
    pendingDelta: pendingDue - pendingPrev,
    overdueDelta: overdue - overduePrev,
    conditionOpenDelta: conditionOpenCount - conditionOpenPrev,
    conditionInProgressDelta: conditionInProgressCount - conditionInProgressPrev,
  };

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
    trends,
    alerts,
    predictive,
    priorities: {
      overdueTop,
      unassignedPendingTop,
      conditionRiskTop,
      equipmentRiskTop,
      technicianLoadTop,
      topLubricants: topLubricantsOut,
    },
    upcoming: upcomingOut,
    upcomingMeta: isAdmin(role) ? upcomingMeta : undefined,
  };
}
