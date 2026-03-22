import { getAISummary } from "../ia/aiService.js";
import {
  AI_LANG_DEFAULT,
  AI_SCHEMA_VERSION,
} from "../ia/aiConfig.js";
import { sendMonthlyExecutiveReportEmail } from "../services/email/email.service.js";

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

function safePct(num, den) {
  const a = Number(num || 0);
  const b = Number(den || 0);
  if (b <= 0) return 0;
  return Math.round((a / b) * 100);
}

function clamp(n, a, b) {
  const x = Number(n || 0);
  return Math.max(a, Math.min(b, x));
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

      const dashboard = await buildDashboardSummary({
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

      const mt = dashboard?.monthlyTotals || dashboard?.activities || {};
      const alerts = dashboard?.alerts || {};

      const completed = Number(mt.completed || 0);
      const pending = Number(mt.pending || 0);
      const overdue = Number(mt.overdue || 0);
      const total = Number(mt.total || completed + pending + overdue || 0);

      const compliance = safePct(completed, total);
      const penalty = total > 0 ? Math.round((overdue / total) * 100) : 0;
      const opEfficiency = clamp(compliance - Math.round(penalty * 0.75), 0, 100);

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
          opEfficiency,
          lowStock: Number(alerts?.lowStockCount || 0),
          unassigned: Number(alerts?.unassignedPending || 0),
          conditionOpen:
            Number(alerts?.conditionOpenCount || 0) +
            Number(alerts?.conditionInProgressCount || 0),
          executiveSummary: summary?.executiveSummary || "",
          highlights: Array.isArray(summary?.highlights) ? summary.highlights : [],
          recommendations: Array.isArray(summary?.recommendations)
            ? summary.recommendations
            : [],
          risks: Array.isArray(summary?.risks) ? summary.risks : [],
          link: `${String(baseUrl).replace(/\/$/, "")}/reports/monthly-intelligent?month=${reportMonth}`,
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
      console.error(`❌ monthlyExecutiveReportJob plant ${plant?.id}:`, error);

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
  const run = async () => {
    try {
      const result = await runMonthlyExecutiveReportJob({
        prisma,
        buildDashboardSummary,
        toStartOfDaySafe,
        baseUrl,
      });

      console.log("📧 monthlyExecutiveReportJob:", result);
    } catch (e) {
      console.error("❌ monthlyExecutiveReportScheduler:", e);
    }
  };

  setTimeout(run, 15_000);
  const interval = setInterval(run, 15 * 60 * 1000);

  console.log("✅ Monthly Executive Report scheduler iniciado");
  return interval;
}