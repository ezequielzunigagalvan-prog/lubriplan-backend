import express from "express";
import prisma from "../../../prisma.js";
import { logger } from "../../../config/logger.js";
import { listDueCycles } from "../scheduler/dates.js";

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const { from, to, assignedTo } = req.query;

    if (!from || !to) {
      return res.status(400).json({ error: "from and to query parameters required" });
    }

    const fromDate = new Date(from);
    const toDate = new Date(to);
    const now = new Date();

    const realWOs = await prisma.mtWorkOrder.findMany({
      where: {
        plantId,
        scheduledAt: { gte: fromDate, lte: toDate },
        ...(assignedTo ? { assignedTo: parseInt(assignedTo) } : {}),
      },
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        priority: true,
        scheduledAt: true,
        assignedTo: true,
        estimatedMinutes: true,
        dueAt: true,
      },
      orderBy: { scheduledAt: "asc" },
    });

    const items = realWOs.map((wo) => ({
      id: wo.id,
      type: "WORK_ORDER",
      number: wo.number,
      title: wo.title,
      date: wo.scheduledAt,
      status: wo.status,
      priority: wo.priority,
      assignedTo: wo.assignedTo,
      estimatedMinutes: wo.estimatedMinutes,
      dueAt: wo.dueAt,
    }));

    const maxProjectedDays = 90;
    const projectRangeEnd = new Date(now);
    projectRangeEnd.setDate(projectRangeEnd.getDate() + maxProjectedDays);

    const plans = await prisma.mtPlan.findMany({
      where: {
        plantId,
        active: true,
        deletedAt: null,
      },
      select: {
        id: true,
        code: true,
        title: true,
        anchorDate: true,
        frequencyUnit: true,
        frequencyEvery: true,
        scheduleMode: true,
        leadDays: true,
        defaultAssigneeId: true,
        estimatedMinutes: true,
      },
    });

    const projected = [];
    for (const plan of plans) {
      if (!plan.frequencyUnit || !plan.frequencyEvery) continue;

      const cycles = listDueCycles(plan, projectRangeEnd, plan.leadDays);
      for (const cycle of cycles) {
        if (cycle.dueAt >= fromDate && cycle.dueAt <= toDate) {
          projected.push({
            id: `plan-${plan.id}-${cycle.dueAt.getTime()}`,
            type: "PROJECTED",
            planCode: plan.code,
            title: `[${plan.code}] ${plan.title}`,
            date: cycle.dueAt,
            assignedTo: plan.defaultAssigneeId,
            estimatedMinutes: plan.estimatedMinutes,
          });
        }
      }

      if (projected.length > 500) break;
    }

    const load = {};
    for (const item of [...items, ...projected]) {
      if (!item.assignedTo) continue;

      const dateStr = new Date(item.date).toISOString().split("T")[0];
      const key = `${item.assignedTo}:${dateStr}`;

      if (!load[key]) {
        load[key] = { technicianId: item.assignedTo, date: dateStr, minutes: 0 };
      }

      load[key].minutes += item.estimatedMinutes || 0;
    }

    return res.json({
      items: (items.length + projected.length > 500 ? items.slice(0, 500) : [...items, ...projected]),
      projected: projected.slice(0, 500),
      load: Object.values(load),
    });
  } catch (err) {
    logger.error("[calendar GET]", err);
    return res.status(500).json({ error: "Error fetching calendar" });
  }
});

export default router;
