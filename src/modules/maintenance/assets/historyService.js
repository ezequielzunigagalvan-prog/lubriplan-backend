import prisma from "../../../prisma.js";
import { logger } from "../../../config/logger.js";

export async function getAssetHistory(assetId, plantId, days = 90) {
  try {
    const asset = await prisma.mtAsset.findUnique({
      where: { id: assetId },
      include: {
        workOrders: {
          where: {
            plantId,
            createdAt: { gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) },
          },
          include: {
            photos: true,
            failure: true,
            parts: { select: { quantity: true, costPerUnitAtTime: true } },
          },
          orderBy: { createdAt: "desc" },
        },
        plans: {
          where: { plantId },
          select: { id: true, code: true, title: true, active: true, nextDueAt: true },
        },
      },
    });

    if (!asset || asset.plantId !== plantId || asset.deletedAt) {
      return null;
    }

    // Los códigos de falla no tienen relación declarada en el esquema: se resuelven por id
    const codeIds = [
      ...new Set(
        asset.workOrders
          .flatMap((wo) => (wo.failure ? [wo.failure.failureModeId, wo.failure.mechanismId, wo.failure.rootCauseId] : []))
          .filter(Boolean)
      ),
    ];
    const codes = codeIds.length
      ? await prisma.mtFailureCode.findMany({ where: { id: { in: codeIds }, plantId }, select: { id: true, code: true } })
      : [];
    const codeOf = (id) => codes.find((c) => c.id === id)?.code;
    const partsCostOf = (wo) =>
      (wo.parts || []).reduce((sum, p) => sum + Number(p.quantity) * Number(p.costPerUnitAtTime), 0);

    // Calculate metrics
    const workOrders = asset.workOrders || [];
    const finishedWOs = workOrders.filter((wo) =>
      ["FINISHED", "VALIDATED"].includes(wo.status)
    );

    const totalDowntime = finishedWOs.reduce((sum, wo) => sum + (wo.downtimeMinutes || 0), 0);
    // Costo real = refacciones consumidas (no hay tarifa de mano de obra registrada)
    const totalCost = finishedWOs.reduce((sum, wo) => sum + partsCostOf(wo), 0);

    const preventiveCount = workOrders.filter((wo) => wo.type === "PREVENTIVE").length;
    const correctiveCount = workOrders.filter((wo) => wo.type === "CORRECTIVE").length;

    // Failure distribution
    const failuresByMode = {};
    workOrders.forEach((wo) => {
      const code = codeOf(wo.failure?.failureModeId);
      if (code) {
        failuresByMode[code] = (failuresByMode[code] || 0) + 1;
      }
    });

    // Monthly trend
    const monthlyData = {};
    workOrders.forEach((wo) => {
      const monthKey = wo.createdAt.toISOString().slice(0, 7); // YYYY-MM
      if (!monthlyData[monthKey]) {
        monthlyData[monthKey] = {
          month: monthKey,
          count: 0,
          downtime: 0,
          cost: 0,
        };
      }
      monthlyData[monthKey].count += 1;
      monthlyData[monthKey].downtime += wo.downtimeMinutes || 0;
      monthlyData[monthKey].cost += partsCostOf(wo);
    });

    // Timeline entries
    const timeline = workOrders.map((wo) => ({
      id: wo.id,
      number: wo.number,
      date: wo.createdAt,
      type: wo.type,
      status: wo.status,
      title: wo.title,
      priority: wo.priority,
      assignedTo: wo.assignedTo,
      downtime: wo.downtimeMinutes || 0,
      cost: partsCostOf(wo),
      failure: wo.failure
        ? {
            mode: codeOf(wo.failure.failureModeId) || null,
            mechanism: codeOf(wo.failure.mechanismId) || null,
            rootCause: codeOf(wo.failure.rootCauseId) || null,
          }
        : null,
      photoCount: wo.photos?.length || 0,
      finishedAt: wo.finishedAt,
      validatedAt: wo.validatedAt,
    }));

    return {
      asset: {
        id: asset.id,
        code: asset.code,
        name: asset.name,
        location: asset.location,
        status: asset.status,
      },
      metrics: {
        totalWorkOrders: workOrders.length,
        preventive: preventiveCount,
        corrective: correctiveCount,
        totalDowntime: Math.round(totalDowntime),
        totalDowntimeHours: Math.round(totalDowntime / 60),
        totalCost: Math.round(totalCost),
        averageDowntime: Math.round(totalDowntime / (finishedWOs.length || 1)),
      },
      failureDistribution: failuresByMode,
      monthlyTrend: Object.values(monthlyData).sort((a, b) =>
        a.month.localeCompare(b.month)
      ),
      activePlans: asset.plans || [],
      timeline,
    };
  } catch (error) {
    logger.error("[getAssetHistory]", error);
    throw error;
  }
}
