import { getAISummary } from "../ia/aiService.js";
import {
  AI_LANG_DEFAULT,
  AI_SCHEMA_VERSION,
} from "../ia/aiConfig.js";
import { sendMonthlyExecutiveReportEmail } from "../services/email/email.service.js";
import { withVerifiedMonth } from "../routes/analysis.routes.js";
import { logger } from "../config/logger.js";

function nowInTimezone(timezone = "America/Mexico_City") {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: timezone })
  );
}

function ym(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function previousMonthYm(date = new Date()) {
  const d = new Date(date);
  d.setMonth(d.getMonth() - 1);
  return ym(d);
}

function shouldRunForPlant(plant, nowTz) {
  const day = Number(plant?.monthlyReportDay || 1);
  const hour = Number(plant?.monthlyReportHour || 8);

  if (!plant?.monthlyReportEnabled) return false;
  if (nowTz.getDate() !== day) return false;
  if (nowTz.getHours() < hour) return false;

  return true;
}

async function getOrCreateJobRun({ prisma, plantId, period }) {
  const existing = await prisma.scheduledJobRun.findUnique({
    where: {
      jobType_plantId_period: {
        jobType: "MONTHLY_EXEC_REPORT",
        plantId: Number(plantId),
        period,
      },
    },
  });

  if (existing) return existing;

  try {
    return await prisma.scheduledJobRun.create({
      data: {
        jobType: "MONTHLY_EXEC_REPORT",
        plantId: Number(plantId),
        period,
        status: "PENDING",
      },
    });
  } catch {
    return prisma.scheduledJobRun.findUnique({
      where: {
        jobType_plantId_period: {
          jobType: "MONTHLY_EXEC_REPORT",
          plantId: Number(plantId),
          period,
        },
      },
    });
  }
}

export async function runMonthlyExecutiveReportJob({
  prisma,
  buildDashboardSummary,
  toStartOfDaySafe,
  baseUrl = process.env.APP_BASE_URL || "http://localhost:5173",
  forcePlantId = null,
  forceMonth = null,
}) {
  if (!prisma) throw new Error("runMonthlyExecutiveReportJob: prisma is required");
  if (!buildDashboardSummary) {
    throw new Error("runMonthlyExecutiveReportJob: buildDashboardSummary is required");
  }

  const plants = await prisma.plant.findMany({
    where: {
      active: true,
      ...(forcePlantId ? { id: Number(forcePlantId) } : {}),
    },
    select: {
      id: true,
      name: true,
      timezone: true,
      monthlyReportEnabled: true,
      monthlyReportDay: true,
      monthlyReportHour: true,
      monthlyReportRecipientsExtra: true,
    },
    orderBy: { id: "asc" },
  });

  const results = [];

  for (const plant of plants) {
    try {
      const nowTz = nowInTimezone(plant.timezone || "America/Mexico_City");
      const reportMonth = forceMonth || previousMonthYm(nowTz);

      if (!forceMonth && !forcePlantId && !shouldRunForPlant(plant, nowTz)) {
        results.push({
          plantId: plant.id,
          plantName: plant.name,
          sent: false,
          reason: "OUTSIDE_WINDOW",
          period: reportMonth,
        });
        continue;
      }

      const jobRun = await getOrCreateJobRun({
        prisma,
        plantId: plant.id,
        period: reportMonth,
      });

      if (jobRun?.status === "SENT") {
        results.push({
          plantId: plant.id,
          plantName: plant.name,
          sent: false,
          reason: "ALREADY_SENT",
          period: reportMonth,
        });
        continue;
      }

      await prisma.scheduledJobRun.update({
        where: { id: jobRun.id },
        data: {
          status: "PENDING",
          startedAt: new Date(),
          finishedAt: null,
          errorMessage: null,
        },
      });

      const rawDashboard = await buildDashboardSummary({
        prisma,
        user: {
          id: null,
          role: "ADMIN",
          technicianId: null,
        },
        month: reportMonth,
        days: 30,
        plantId: String(plant.id),
        toStartOfDaySafe,
      });

      // Mismos cálculos verificados que el Reporte mensual (antes usaba otra fórmula y una
      // "eficiencia operativa" inventada).
      const { overview, dashboard } = await withVerifiedMonth(prisma, plant.id, reportMonth, rawDashboard);
      const alerts = dashboard?.alerts || {};
      const c = overview.compliance;
      const rep = overview.reports;

      const completed = c.completed;
      const pending = c.dueToday + c.upcoming;
      const overdue = c.overdue;
      const total = c.due + c.dueToday + c.upcoming;
      const conditionReported = rep.total;
      const conditionAttended = rep.byStatus.IN_PROGRESS + rep.byStatus.RESOLVED + rep.byStatus.DISMISSED;
      const compliance = c.complianceRate ?? 0;
      const onTimeRate = c.onTimeRate ?? 0;

      const ai = await getAISummary({
        month: reportMonth,
        plantId: String(plant.id),
        role: "ADMIN",
        userId: null,
        lang: AI_LANG_DEFAULT,
        schemaVersion: AI_SCHEMA_VERSION,
        dashboard,
      });

      const summary = ai?.summary || {};

      const sendResult = await sendMonthlyExecutiveReportEmail({
        prisma,
        payload: {
          plantId: plant.id,
          plantName: plant.name,
          month: reportMonth,
          generatedAt: new Date(),
          total,
          completed,
          pending,
          overdue,
          compliance,
          onTimeRate,
          lowStock: Number(alerts?.lowStockCount || 0),
          unassigned: overview.quality.overdueWithoutTechnician,
          conditionReported,
          conditionAttended,
          conditionOpen: rep.openNow,
          executiveSummary: summary?.executiveSummary || "",
          highlights: Array.isArray(summary?.highlights) ? summary.highlights : [],
          recommendations: Array.isArray(summary?.recommendations)
            ? summary.recommendations
            : [],
          risks: Array.isArray(summary?.risks) ? summary.risks : [],
          link: `${String(baseUrl).replace(/\/$/, "")}/reports/monthly?month=${reportMonth}`,
        },
      });

      if (!sendResult?.ok) {
        await prisma.scheduledJobRun.update({
          where: { id: jobRun.id },
          data: {
            status: "FAILED",
            finishedAt: new Date(),
            errorMessage: sendResult?.reason || "SEND_FAILED",
          },
        });

        results.push({
          plantId: plant.id,
          plantName: plant.name,
          sent: false,
          reason: sendResult?.reason || "SEND_FAILED",
          period: reportMonth,
        });
        continue;
      }

      await prisma.scheduledJobRun.update({
        where: { id: jobRun.id },
        data: {
          status: "SENT",
          recipientsJson: JSON.stringify(sendResult?.recipients || []),
          subject: sendResult?.subject || null,
          finishedAt: new Date(),
          errorMessage: null,
        },
      });

      results.push({
        plantId: plant.id,
        plantName: plant.name,
        sent: true,
        reason: "OK",
        period: reportMonth,
        recipients: Array.isArray(sendResult?.recipients)
          ? sendResult.recipients.length
          : 0,
      });
    } catch (error) {
      logger.error(`❌ monthlyExecutiveReportJob plant ${plant?.id}:`, error);

      try {
        const reportMonth =
          forceMonth || previousMonthYm(nowInTimezone(plant.timezone || "America/Mexico_City"));

        const existing = await prisma.scheduledJobRun.findUnique({
          where: {
            jobType_plantId_period: {
              jobType: "MONTHLY_EXEC_REPORT",
              plantId: Number(plant.id),
              period: reportMonth,
            },
          },
        });

        if (existing) {
          await prisma.scheduledJobRun.update({
            where: { id: existing.id },
            data: {
              status: "FAILED",
              finishedAt: new Date(),
              errorMessage: error?.message || "UNKNOWN_ERROR",
            },
          });
        }
      } catch {}

      results.push({
        plantId: plant?.id ?? null,
        plantName: plant?.name ?? "—",
        sent: false,
        reason: "ERROR",
        error: error?.message || "Unknown error",
      });
    }
  }

  return {
    ok: true,
    ranAt: new Date().toISOString(),
    plantsProcessed: plants.length,
    results,
  };
}

export function startMonthlyExecutiveReportScheduler({
  prisma,
  buildDashboardSummary,
  toStartOfDaySafe,
  baseUrl = process.env.APP_BASE_URL || "http://localhost:5173",
}) {
  // Evita que una corrida se encime con la siguiente si tarda más que el intervalo.
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runMonthlyExecutiveReportJob({
        prisma,
        buildDashboardSummary,
        toStartOfDaySafe,
        baseUrl,
      });

      logger.info("📧 monthlyExecutiveReportJob:", result);
    } catch (e) {
      logger.error("❌ monthlyExecutiveReportScheduler:", e);
    } finally {
      running = false;
    }
  };

  setTimeout(run, 15_000);
  const interval = setInterval(run, 15 * 60 * 1000);

  logger.info("✅ Monthly Executive Report scheduler iniciado");
  return interval;
}
