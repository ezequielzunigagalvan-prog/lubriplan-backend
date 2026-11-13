import express from "express";
import { Prisma } from "@prisma/client";
import prisma from "../../../prisma.js";
import { logger } from "../../../config/logger.js";

const router = express.Router();

router.get("/summary", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const thirtyDaysAgo = new Date(today);
    thirtyDaysAgo.setDate(today.getDate() - 30);

    // Contar órdenes por estado
    const statusCounts = await prisma.$queryRaw`
      SELECT status, COUNT(*) as count FROM "MtWorkOrder"
      WHERE "plantId" = ${plantId}
      GROUP BY status
    `;

    // Contar órdenes vencidas
    const overdueResult = await prisma.$queryRaw`
      SELECT COUNT(*) as total FROM "MtWorkOrder"
      WHERE "plantId" = ${plantId}
      AND "scheduledAt" < ${today}
      AND status NOT IN ('VALIDATED', 'REJECTED', 'CANCELLED')
    `;

    // Contar creadas en últimos 30 días
    const createdResult = await prisma.$queryRaw`
      SELECT COUNT(*) as total FROM "MtWorkOrder"
      WHERE "plantId" = ${plantId}
      AND "createdAt" >= ${thirtyDaysAgo}
    `;

    // Contar cerradas en últimos 30 días
    const closedResult = await prisma.$queryRaw`
      SELECT COUNT(*) as total FROM "MtWorkOrder"
      WHERE "plantId" = ${plantId}
      AND "finishedAt" >= ${thirtyDaysAgo}
      AND status IN ('VALIDATED', 'REJECTED', 'CANCELLED')
    `;

    // Top 5 activos con más fallas correctivas
    const topAssets = await prisma.$queryRaw(
      Prisma.sql`
        SELECT "assetId", COUNT(*) as count FROM "MtWorkOrder"
        WHERE "plantId" = ${plantId}
        AND type = 'CORRECTIVE'
        AND "assetId" IS NOT NULL
        GROUP BY "assetId"
        ORDER BY count DESC
        LIMIT 5
      `
    );

    // Construir resumen por estado
    const statusSummary = {};
    statusCounts.forEach(({ status, count }) => {
      statusSummary[status] = parseInt(count);
    });

    // Obtener nombres de activos
    let topAssetsWithNames = [];
    if (topAssets.length > 0) {
      const assetIds = topAssets.map(a => a.assetId);
      const assetNames = await prisma.$queryRaw(
        Prisma.sql`
          SELECT id, code, name FROM "MtAsset"
          WHERE id IN (${Prisma.join(assetIds)})
          AND "plantId" = ${plantId}
        `
      );

      topAssetsWithNames = topAssets.map((ta) => {
        const asset = assetNames.find((a) => a.id === ta.assetId);
        return {
          assetId: ta.assetId,
          assetCode: asset?.code || 'N/A',
          assetName: asset?.name || 'Sin nombre',
          correctiveCount: parseInt(ta.count),
        };
      });
    }

    return res.json({
      data: {
        byStatus: statusSummary,
        openedCount: parseInt(statusSummary.OPEN || 0),
        overdueCount: parseInt(overdueResult[0]?.total || 0),
        waitingCount: parseInt(statusSummary.WAITING || 0),
        closed30DaysCount: parseInt(closedResult[0]?.total || 0),
        topAssets: topAssetsWithNames.map(ta => ({
          id: ta.assetId,
          name: ta.assetName,
          code: ta.assetCode,
          correctiveCount: ta.correctiveCount,
        })),
      },
    });
  } catch (err) {
    logger.error("[dashboard/summary GET]", err);
    return res.status(500).json({ error: "Error fetching dashboard summary" });
  }
});

export default router;
