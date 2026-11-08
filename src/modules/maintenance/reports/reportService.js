import prisma from "../../../prisma.js";
import { logger } from "../../../config/logger.js";

export async function generateAssetHistoryReport(assetId, plantId, format = "json") {
  try {
    // Get asset history
    const asset = await prisma.mtAsset.findUnique({
      where: { id: assetId },
      include: {
        workOrders: {
          where: { plantId },
          include: { failure: { include: { failureMode: true } } },
          orderBy: { createdAt: "desc" },
          take: 100,
        },
      },
    });

    if (!asset) return null;

    const finishedWOs = asset.workOrders.filter((wo) =>
      ["FINISHED", "VALIDATED"].includes(wo.status)
    );

    const report = {
      asset: {
        code: asset.code,
        name: asset.name,
        location: asset.location,
        status: asset.status,
        criticality: asset.criticality,
      },
      generatedAt: new Date().toISOString(),
      summary: {
        totalOrders: asset.workOrders.length,
        completedOrders: finishedWOs.length,
        preventive: asset.workOrders.filter((wo) => wo.type === "PREVENTIVE").length,
        corrective: asset.workOrders.filter((wo) => wo.type === "CORRECTIVE").length,
        totalDowntimeHours: Math.round(finishedWOs.reduce((sum, wo) => sum + (wo.downtimeMinutes || 0), 0) / 60),
        totalCost: Math.round(finishedWOs.reduce((sum, wo) => sum + (wo.downtimeMinutes || 0) / 60 * 50, 0)),
      },
      orders: asset.workOrders.map((wo) => ({
        number: wo.number,
        type: wo.type,
        status: wo.status,
        title: wo.title,
        priority: wo.priority,
        createdAt: wo.createdAt?.toISOString(),
        finishedAt: wo.finishedAt?.toISOString(),
        downtime: wo.downtimeMinutes || 0,
        cost: Math.round((wo.downtimeMinutes || 0) / 60 * 50),
        failure: wo.failure ? {
          mode: wo.failure.failureMode?.code,
          cause: wo.failure.rootCause?.code,
        } : null,
      })),
    };

    return report;
  } catch (error) {
    logger.error("[generateAssetHistoryReport]", error);
    throw error;
  }
}

export async function generatePlantSummaryReport(plantId) {
  try {
    const [assets, workOrders, failureCodes] = await Promise.all([
      prisma.mtAsset.count({ where: { plantId } }),
      prisma.mtWorkOrder.findMany({
        where: { plantId },
        select: { id: true, type: true, status: true, downtimeMinutes: true },
      }),
      prisma.mtFailureCode.findMany({
        where: { plantId },
        select: { code: true, name: true },
      }),
    ]);

    const completedWOs = workOrders.filter((wo) =>
      ["FINISHED", "VALIDATED"].includes(wo.status)
    );

    return {
      plant: { id: plantId },
      generatedAt: new Date().toISOString(),
      summary: {
        totalAssets: assets,
        totalWorkOrders: workOrders.length,
        completedOrders: completedWOs.length,
        openOrders: workOrders.filter((wo) => !["FINISHED", "VALIDATED", "REJECTED", "CANCELLED"].includes(wo.status)).length,
        preventive: workOrders.filter((wo) => wo.type === "PREVENTIVE").length,
        corrective: workOrders.filter((wo) => wo.type === "CORRECTIVE").length,
        totalDowntimeHours: Math.round(completedWOs.reduce((sum, wo) => sum + (wo.downtimeMinutes || 0), 0) / 60),
        totalCost: Math.round(completedWOs.reduce((sum, wo) => sum + (wo.downtimeMinutes || 0) / 60 * 50, 0)),
        failureCodesCount: failureCodes.length,
      },
      metrics: {
        completionRate: completedWOs.length > 0 ? Math.round((completedWOs.length / workOrders.length) * 100) : 0,
        preventiveRatio: workOrders.length > 0 ? Math.round((workOrders.filter((wo) => wo.type === "PREVENTIVE").length / workOrders.length) * 100) : 0,
        avgDowntimePerOrder: completedWOs.length > 0 ? Math.round(completedWOs.reduce((sum, wo) => sum + (wo.downtimeMinutes || 0), 0) / completedWOs.length / 60) : 0,
        costPerOrder: completedWOs.length > 0 ? Math.round(completedWOs.reduce((sum, wo) => sum + (wo.downtimeMinutes || 0) / 60 * 50, 0) / completedWOs.length) : 0,
      },
    };
  } catch (error) {
    logger.error("[generatePlantSummaryReport]", error);
    throw error;
  }
}

export async function generateWeeklyDigest(plantId) {
  try {
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [weeklyOrders, criticalAssets, failureStats] = await Promise.all([
      prisma.mtWorkOrder.findMany({
        where: { plantId, createdAt: { gte: oneWeekAgo } },
        include: { asset: { select: { code: true, name: true } } },
      }),
      prisma.mtAsset.findMany({
        where: { plantId, criticality: "A" },
        select: { id: true, code: true, name: true },
        take: 5,
      }),
      prisma.mtWorkOrderFailure.groupBy({
        by: ["failureModeId"],
        where: { workOrder: { plantId, createdAt: { gte: oneWeekAgo } } },
        _count: { failureModeId: true },
      }),
    ]);

    const completedThisWeek = weeklyOrders.filter((wo) =>
      ["FINISHED", "VALIDATED"].includes(wo.status)
    );

    return {
      period: {
        startDate: oneWeekAgo.toISOString(),
        endDate: new Date().toISOString(),
      },
      summary: {
        newOrders: weeklyOrders.length,
        completedOrders: completedThisWeek.length,
        preventive: weeklyOrders.filter((wo) => wo.type === "PREVENTIVE").length,
        corrective: weeklyOrders.filter((wo) => wo.type === "CORRECTIVE").length,
        totalDowntimeHours: Math.round(completedThisWeek.reduce((sum, wo) => sum + (wo.downtimeMinutes || 0), 0) / 60),
      },
      topFailures: failureStats.slice(0, 5),
      criticalAssets: criticalAssets.map((a) => ({ code: a.code, name: a.name })),
      highlights: generateHighlights(weeklyOrders, completedThisWeek),
    };
  } catch (error) {
    logger.error("[generateWeeklyDigest]", error);
    throw error;
  }
}

function generateHighlights(weeklyOrders, completedThisWeek) {
  const highlights = [];

  if (completedThisWeek.length > 10) {
    highlights.push(`Excelente productividad: ${completedThisWeek.length} órdenes completadas`);
  }

  const preventiveCount = weeklyOrders.filter((wo) => wo.type === "PREVENTIVE").length;
  const preventiveRatio = preventiveCount / (weeklyOrders.length || 1);
  if (preventiveRatio > 0.5) {
    highlights.push(`Mantenimiento preventivo fuerte: ${Math.round(preventiveRatio * 100)}% de órdenes`);
  }

  const openOrders = weeklyOrders.filter((wo) => !["FINISHED", "VALIDATED", "REJECTED", "CANCELLED"].includes(wo.status));
  if (openOrders.length > 5) {
    highlights.push(`Atención: ${openOrders.length} órdenes abiertas pendientes`);
  }

  return highlights.length > 0 ? highlights : ["Semana operativa normal"];
}
