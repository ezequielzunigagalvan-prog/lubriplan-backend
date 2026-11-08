import prisma from "../../../prisma.js";
import { logger } from "../../../config/logger.js";

// ============================================================
// COST CALCULATIONS
// ============================================================

export async function calculateWorkOrderCost(workOrderId, plantId) {
  const wo = await prisma.mtWorkOrder.findUnique({
    where: { id: workOrderId },
  });

  if (!wo || wo.plantId !== plantId) {
    return null;
  }

  // Cost of spare parts (simplified - would need parts query)
  const partsCost = 0;

  // Labor cost (if downtime minutes are recorded)
  const laborCost = wo.downtimeMinutes ? (wo.downtimeMinutes / 60) * 50 : 0; // $50/hour default

  const total = partsCost + laborCost;

  return {
    workOrderId,
    partsCost,
    laborCost,
    total,
    downtimeMinutes: wo.downtimeMinutes || 0,
    downtimeHours: (wo.downtimeMinutes || 0) / 60,
  };
}

export async function getCostsByPeriod(plantId, startDate, endDate) {
  const workOrders = await prisma.mtWorkOrder.findMany({
    where: {
      plantId,
      createdAt: {
        gte: new Date(startDate),
        lte: new Date(endDate),
      },
      status: { in: ["FINISHED", "VALIDATED"] },
    },
    include: {
      asset: true,
    },
  });

  const costs = workOrders.map((wo) => {
    const partsCost = (wo.parts || []).reduce((sum, part) => {
      return sum + (part.costPerUnitAtTime * part.quantity);
    }, 0);
    const laborCost = wo.downtimeMinutes ? (wo.downtimeMinutes / 60) * 50 : 0;
    return {
      workOrderId: wo.id,
      assetId: wo.assetId,
      assetCode: wo.asset?.code,
      type: wo.type,
      partsCost,
      laborCost,
      total: partsCost + laborCost,
    };
  });

  const byType = {
    PREVENTIVE: 0,
    CORRECTIVE: 0,
  };

  const byAsset = {};
  let totalCost = 0;
  let totalParts = 0;
  let totalLabor = 0;

  costs.forEach((cost) => {
    totalCost += cost.total;
    totalParts += cost.partsCost;
    totalLabor += cost.laborCost;
    byType[cost.type] = (byType[cost.type] || 0) + cost.total;

    if (!byAsset[cost.assetCode]) {
      byAsset[cost.assetCode] = 0;
    }
    byAsset[cost.assetCode] += cost.total;
  });

  return {
    period: { start: startDate, end: endDate },
    summary: {
      total: totalCost,
      byParts: totalParts,
      byLabor: totalLabor,
      workOrders: costs.length,
    },
    byType,
    byAsset,
    details: costs,
  };
}

// ============================================================
// MTTR (Mean Time To Repair)
// ============================================================

export async function calculateMTTR(plantId, days = 30) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const workOrders = await prisma.mtWorkOrder.findMany({
    where: {
      plantId,
      finishedAt: { gte: startDate },
      status: { in: ["FINISHED", "VALIDATED"] },
    },
  });

  if (workOrders.length === 0) {
    return { mttr: 0, count: 0, avgDowntime: 0 };
  }

  const totalDowntime = workOrders.reduce((sum, wo) => {
    if (wo.startedAt && wo.finishedAt) {
      const diff = (wo.finishedAt - wo.startedAt) / (1000 * 60); // minutes
      return sum + diff;
    }
    return sum;
  }, 0);

  const mttrMinutes = totalDowntime / workOrders.length;

  return {
    mttr: parseFloat((mttrMinutes / 60).toFixed(2)), // hours
    count: workOrders.length,
    avgDowntime: workOrders.reduce((sum, wo) => sum + (wo.downtimeMinutes || 0), 0) / workOrders.length,
  };
}

// ============================================================
// MTBF (Mean Time Between Failures)
// ============================================================

export async function calculateMTBF(assetId, plantId) {
  const asset = await prisma.mtAsset.findUnique({
    where: { id: assetId },
    include: {
      counters: true,
      workOrders: {
        where: { type: "CORRECTIVE", status: { in: ["FINISHED", "VALIDATED"] } },
        orderBy: { finishedAt: "asc" },
      },
    },
  });

  if (!asset || asset.plantId !== plantId) {
    return null;
  }

  if (asset.workOrders.length < 2) {
    return {
      assetId,
      assetCode: asset.code,
      mtbf: 0,
      failureCount: asset.workOrders.length,
      message: "Insufficient data (need at least 2 failures)",
    };
  }

  // Calculate time between failures
  const intervals = [];
  for (let i = 1; i < asset.workOrders.length; i++) {
    const current = asset.workOrders[i];
    const previous = asset.workOrders[i - 1];
    if (current.finishedAt && previous.finishedAt) {
      const interval = (current.finishedAt - previous.finishedAt) / (1000 * 60 * 60); // hours
      intervals.push(interval);
    }
  }

  const mtbfHours = intervals.length > 0 ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0;

  return {
    assetId,
    assetCode: asset.code,
    mtbf: parseFloat(mtbfHours.toFixed(2)),
    failureCount: asset.workOrders.length,
    avgInterval: parseFloat(mtbfHours.toFixed(2)),
  };
}

// ============================================================
// RECURRENCE (Same failure in same asset within N days)
// ============================================================

export async function getRecurrence(plantId, days = 30) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const workOrders = await prisma.mtWorkOrder.findMany({
    where: {
      plantId,
      createdAt: { gte: startDate },
    },
    include: {
      asset: true,
    },
  });

  // Group by asset + failure code
  const failuresByAsset = {};
  workOrders.forEach((wo) => {
    const key = `${wo.assetId}-${wo.failure?.failureModeId || "unknown"}`;
    if (!failuresByAsset[key]) {
      failuresByAsset[key] = [];
    }
    failuresByAsset[key].push({
      workOrderId: wo.id,
      createdAt: wo.createdAt,
      asset: wo.asset,
      failure: wo.failure,
    });
  });

  // Find recurrences (2+ same failures on same asset)
  const recurrences = Object.entries(failuresByAsset)
    .filter(([_, failures]) => failures.length > 1)
    .map(([key, failures]) => ({
      assetId: failures[0].asset.id,
      assetCode: failures[0].asset.code,
      failureMode: failures[0].failure?.failureMode?.name || "Unknown",
      count: failures.length,
      firstOccurrence: failures[0].createdAt,
      lastOccurrence: failures[failures.length - 1].createdAt,
      daysSinceFirst: Math.floor((Date.now() - failures[0].createdAt) / (1000 * 60 * 60 * 24)),
    }));

  return recurrences.sort((a, b) => b.count - a.count);
}

// ============================================================
// AVAILABILITY & RELIABILITY
// ============================================================

export async function calculateAvailability(assetId, plantId, days = 30) {
  const asset = await prisma.mtAsset.findUnique({
    where: { id: assetId },
  });

  if (!asset || asset.plantId !== plantId) {
    return null;
  }

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const workOrders = await prisma.mtWorkOrder.findMany({
    where: {
      assetId,
      plantId,
      finishedAt: { gte: startDate },
      type: "CORRECTIVE",
      status: { in: ["FINISHED", "VALIDATED"] },
    },
  });

  const totalDowntimeMinutes = workOrders.reduce((sum, wo) => {
    if (wo.startedAt && wo.finishedAt) {
      const diff = (wo.finishedAt - wo.startedAt) / (1000 * 60);
      return sum + diff;
    }
    return sum;
  }, 0);

  const calendarMinutes = days * 24 * 60;
  const availability = ((calendarMinutes - totalDowntimeMinutes) / calendarMinutes) * 100;

  return {
    assetId,
    assetCode: asset.code,
    availability: parseFloat(availability.toFixed(2)),
    downtime: parseFloat((totalDowntimeMinutes / 60).toFixed(2)), // hours
    downtimePercent: parseFloat(((totalDowntimeMinutes / calendarMinutes) * 100).toFixed(2)),
    period: days,
  };
}

// ============================================================
// TOP ASSETS
// ============================================================

export async function getTopAssets(plantId, metric = "cost", limit = 10, days = 30) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const workOrders = await prisma.mtWorkOrder.findMany({
    where: {
      plantId,
      createdAt: { gte: startDate },
      status: { in: ["FINISHED", "VALIDATED"] },
    },
    include: {
      asset: true,
    },
  });

  const assetMetrics = {};

  workOrders.forEach((wo) => {
    const assetCode = wo.asset?.code || "unknown";
    if (!assetMetrics[assetCode]) {
      assetMetrics[assetCode] = {
        assetId: wo.assetId,
        assetCode,
        cost: 0,
        downtime: 0,
        failures: 0,
        orders: [],
      };
    }

    const partsCost = 0; // Simplified - would need parts query
    const laborCost = wo.downtimeMinutes ? (wo.downtimeMinutes / 60) * 50 : 0;

    assetMetrics[assetCode].cost += laborCost;
    assetMetrics[assetCode].downtime += wo.downtimeMinutes || 0;
    if (wo.type === "CORRECTIVE") {
      assetMetrics[assetCode].failures += 1;
    }
    assetMetrics[assetCode].orders.push(wo.id);
  });

  const sorted = Object.values(assetMetrics)
    .sort((a, b) => {
      if (metric === "cost") return b.cost - a.cost;
      if (metric === "downtime") return b.downtime - a.downtime;
      if (metric === "failures") return b.failures - a.failures;
      return 0;
    })
    .slice(0, limit);

  return sorted.map((item) => ({
    ...item,
    cost: parseFloat(item.cost.toFixed(2)),
    downtime: parseFloat((item.downtime / 60).toFixed(2)), // hours
  }));
}

// ============================================================
// SUMMARY DASHBOARD
// ============================================================

export async function getDashboardSummary(plantId) {
  const [
    totalWOs,
    preventiveWOs,
    correctiveWOs,
    workInProgress,
    totalCost,
    mttr,
    topAssets,
    recurrences,
  ] = await Promise.all([
    prisma.mtWorkOrder.count({ where: { plantId, status: { in: ["FINISHED", "VALIDATED"] } } }),
    prisma.mtWorkOrder.count({
      where: { plantId, type: "PREVENTIVE", status: { in: ["FINISHED", "VALIDATED"] } },
    }),
    prisma.mtWorkOrder.count({
      where: { plantId, type: "CORRECTIVE", status: { in: ["FINISHED", "VALIDATED"] } },
    }),
    prisma.mtWorkOrder.count({ where: { plantId, status: "IN_PROGRESS" } }),
    getCostsByPeriod(plantId, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), new Date()),
    calculateMTTR(plantId, 30),
    getTopAssets(plantId, "cost", 5, 30),
    getRecurrence(plantId, 30),
  ]);

  return {
    period: "30 days",
    summary: {
      totalOrders: totalWOs,
      preventive: preventiveWOs,
      corrective: correctiveWOs,
      inProgress: workInProgress,
      preventivePercent: totalWOs > 0 ? parseFloat(((preventiveWOs / totalWOs) * 100).toFixed(1)) : 0,
    },
    costs: totalCost.summary,
    mttr: mttr.mttr,
    topAssets,
    recurrences,
  };
}
