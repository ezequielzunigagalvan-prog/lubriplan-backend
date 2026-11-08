import express from "express";
import prisma from "../../../prisma.js";
import { logger } from "../../../config/logger.js";

const router = express.Router();

router.get("/pm-compliance", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const { from, to, assetId } = req.query;

    if (!from || !to) {
      return res.status(400).json({ error: "from and to query parameters required" });
    }

    const fromDate = new Date(from);
    const toDate = new Date(to);
    const graceDays = 0;

    const where = {
      plantId,
      planId: { not: null },
      dueAt: { gte: fromDate, lte: toDate },
    };

    if (assetId) {
      where.assetId = parseInt(assetId);
    }

    const workOrders = await prisma.mtWorkOrder.findMany({
      where,
      select: {
        id: true,
        dueAt: true,
        finishedAt: true,
        status: true,
        rescheduleCount: true,
        assetId: true,
      },
    });

    const skipped = await prisma.mtPlanRun.findMany({
      where: {
        plantId,
        decision: "SKIPPED_OPEN",
        dueAt: { gte: fromDate, lte: toDate },
      },
      select: { dueAt: true },
    });

    let onTime = 0;
    let late = 0;
    let omitted = 0;
    let pending = 0;

    const now = new Date();

    for (const wo of workOrders) {
      if (wo.status === "FINISHED" || wo.status === "VALIDATED") {
        const dueDate = new Date(wo.dueAt);
        dueDate.setDate(dueDate.getDate() + graceDays);

        if (new Date(wo.finishedAt) <= dueDate) {
          onTime++;
        } else {
          late++;
        }
      } else if (
        ["CANCELLED", "REJECTED"].includes(wo.status)
      ) {
        omitted++;
      } else if (new Date(wo.dueAt) < now) {
        omitted++;
      } else {
        pending++;
      }
    }

    omitted += skipped.length;

    const total = onTime + late + omitted;
    const compliancePercent = total > 0 ? ((onTime / total) * 100).toFixed(1) : 0;

    return res.json({
      period: { from: fromDate, to: toDate },
      summary: {
        total,
        onTime,
        late,
        omitted,
        pending,
        compliancePercent: parseFloat(compliancePercent),
      },
      formula:
        "A_TIEMPO: finishedAt <= dueAt+graceDays. LATE: finishedAt > dueAt+graceDays. OMITTED: CANCELLED|REJECTED|SKIPPED_OPEN|overdue and still open. PENDING: not yet due. Compliance = A_TIEMPO / (A_TIEMPO+LATE+OMITTED)",
      details: {
        workOrders: workOrders.length,
        skippedOpen: skipped.length,
      },
    });
  } catch (err) {
    logger.error("[compliance GET]", err);
    return res.status(500).json({ error: "Error calculating compliance" });
  }
});

export default router;
