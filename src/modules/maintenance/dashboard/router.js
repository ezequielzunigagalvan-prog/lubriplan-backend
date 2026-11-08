import express from "express";
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

    const [
      statusCounts,
      overdue,
      createdLast30,
      closedLast30,
      topAssets,
    ] = await Promise.all([
      prisma.mtWorkOrder.groupBy({
        by: ["status"],
        where: { plantId },
        _count: true,
      }),

      prisma.mtWorkOrder.count({
        where: {
          plantId,
          scheduledAt: { lt: today },
          status: { notIn: ["VALIDATED", "REJECTED", "CANCELLED"] },
        },
      }),

      prisma.mtWorkOrder.count({
        where: {
          plantId,
          createdAt: { gte: thirtyDaysAgo },
        },
      }),

      prisma.mtWorkOrder.count({
        where: {
          plantId,
          finishedAt: { gte: thirtyDaysAgo },
          status: { in: ["VALIDATED", "REJECTED", "CANCELLED"] },
        },
      }),

      prisma.mtWorkOrder.groupBy({
        by: ["assetId"],
        where: { plantId, type: "CORRECTIVE" },
        _count: true,
        orderBy: { _count: { id: "desc" } },
        take: 5,
      }),
    ]);

    const statusSummary = {};
    statusCounts.forEach(({ status, _count }) => {
      statusSummary[status] = _count;
    });

    const assetIds = topAssets
      .filter((a) => a.assetId)
      .map((a) => a.assetId);

    let topAssetsWithNames = [];
    if (assetIds.length > 0) {
      topAssetsWithNames = await prisma.mtAsset.findMany({
        where: { id: { in: assetIds }, plantId },
        select: { id: true, code: true, name: true },
      });

      topAssetsWithNames = topAssets
        .filter((a) => a.assetId)
        .map((ta) => {
          const asset = topAssetsWithNames.find((a) => a.id === ta.assetId);
          return {
            assetId: ta.assetId,
            assetCode: asset?.code,
            assetName: asset?.name,
            correctiveCount: ta._count,
          };
        });
    }

    return res.json({
      byStatus: statusSummary,
      overdueCount: overdue,
      createdLast30Days: createdLast30,
      closedLast30Days: closedLast30,
      topCorrectedAssets: topAssetsWithNames,
    });
  } catch (err) {
    logger.error("[dashboard/summary GET]", err);
    return res.status(500).json({ error: "Error fetching dashboard summary" });
  }
});

export default router;
