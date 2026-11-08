import prisma from "../../../prisma.js";
import { logger } from "../../../config/logger.js";

// Predict equipment degradation based on historical trends
export async function predictEquipmentDegradation(assetId, plantId) {
  try {
    const workOrders = await prisma.mtWorkOrder.findMany({
      where: {
        assetId,
        plantId,
        status: { in: ["FINISHED", "VALIDATED"] },
        createdAt: { gte: new Date(Date.now() - 180 * 24 * 60 * 60 * 1000) }, // Last 6 months
      },
      orderBy: { finishedAt: "asc" },
      select: {
        id: true,
        finishedAt: true,
        downtimeMinutes: true,
        type: true,
      },
    });

    if (workOrders.length < 3) {
      return { riskLevel: "LOW", confidence: 0, reason: "Insufficient data" };
    }

    // Calculate intervals between failures
    const intervals = [];
    for (let i = 1; i < workOrders.length; i++) {
      const prev = workOrders[i - 1].finishedAt;
      const curr = workOrders[i].finishedAt;
      const days = (curr - prev) / (1000 * 60 * 60 * 24);
      intervals.push(days);
    }

    // Calculate trend
    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const recentInterval = intervals[intervals.length - 1];
    const degradationRate = (avgInterval - recentInterval) / avgInterval;

    // Calculate downtime trend
    const recentWOs = workOrders.slice(-10);
    const avgDowntime = recentWOs.reduce((sum, wo) => sum + (wo.downtimeMinutes || 0), 0) / recentWOs.length;
    const oldWOs = workOrders.slice(0, Math.min(10, workOrders.length - 10));
    const oldAvgDowntime = oldWOs.length > 0 ? oldWOs.reduce((sum, wo) => sum + (wo.downtimeMinutes || 0), 0) / oldWOs.length : 0;
    const downtimeTrend = (avgDowntime - oldAvgDowntime) / (oldAvgDowntime || 1);

    // Predict next failure
    let riskLevel = "LOW";
    let confidence = 0;
    let daysUntilFailure = null;

    if (degradationRate > 0.3 || downtimeTrend > 0.2) {
      riskLevel = "HIGH";
      confidence = Math.min(100, (Math.abs(degradationRate) + Math.abs(downtimeTrend)) * 150);
      daysUntilFailure = Math.max(1, Math.round(avgInterval * 0.5));
    } else if (degradationRate > 0.1 || downtimeTrend > 0.05) {
      riskLevel = "MEDIUM";
      confidence = Math.min(100, (Math.abs(degradationRate) + Math.abs(downtimeTrend)) * 100);
      daysUntilFailure = Math.max(1, Math.round(avgInterval * 0.7));
    } else {
      confidence = 30;
    }

    return {
      assetId,
      riskLevel,
      confidence: Math.round(confidence),
      daysUntilFailure,
      avgIntervalDays: Math.round(avgInterval),
      recentIntervalDays: Math.round(recentInterval),
      degradationRate: Math.round(degradationRate * 100),
      downtimeTrendPercent: Math.round(downtimeTrend * 100),
      analysis: generateAnalysis(riskLevel, degradationRate, downtimeTrend),
      recommendations: generateRecommendations(riskLevel, avgDowntime),
    };
  } catch (error) {
    logger.error("[predictEquipmentDegradation]", error);
    throw error;
  }
}

function generateAnalysis(riskLevel, degradationRate, downtimeTrend) {
  if (riskLevel === "HIGH") {
    return "El equipo muestra signos de degradación acelerada. Se recomiendan inspecciones inmediatas y posible reemplazo de componentes críticos.";
  } else if (riskLevel === "MEDIUM") {
    return "Se detecta una tendencia gradual de degradación. Aumentar frecuencia de mantenimiento preventivo.";
  }
  return "El equipo funciona dentro de parámetros normales.";
}

function generateRecommendations(riskLevel, avgDowntime) {
  const recommendations = [];

  if (riskLevel === "HIGH") {
    recommendations.push("Realizar inspección completa inmediatamente");
    recommendations.push("Revisar disponibilidad de refacciones críticas");
    recommendations.push("Aumentar monitoreo a diario");
  } else if (riskLevel === "MEDIUM") {
    recommendations.push("Aumentar frecuencia de preventivos a cada 2 semanas");
    recommendations.push("Revisar componentes desgastados");
  }

  if (avgDowntime > 480) {
    // > 8 hours
    recommendations.push("El downtime es alto - considerar reemplazo");
  }

  return recommendations;
}

// Get all assets with risk assessment
export async function getRiskAssessment(plantId) {
  try {
    const assets = await prisma.mtAsset.findMany({
      where: { plantId },
      select: { id: true, code: true, name: true },
    });

    const assessments = await Promise.all(
      assets.map(async (asset) => {
        const prediction = await predictEquipmentDegradation(asset.id, plantId);
        return {
          ...asset,
          ...prediction,
        };
      })
    );

    // Sort by risk
    return assessments.sort((a, b) => {
      const riskOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
      const aRisk = riskOrder[a.riskLevel];
      const bRisk = riskOrder[b.riskLevel];
      return aRisk - bRisk || b.confidence - a.confidence;
    });
  } catch (error) {
    logger.error("[getRiskAssessment]", error);
    throw error;
  }
}
