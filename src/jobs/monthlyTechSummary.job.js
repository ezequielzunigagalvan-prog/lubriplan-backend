import { notifyTechnicianAssignee } from "../notifications/notify.js";

const TZ = "America/Mexico_City";
const SEND_HOUR = 20; // 8 PM

function nowInTz(tz = TZ) {
  return new Date(new Date().toLocaleString("en-US", { timeZone: tz }));
}

function ym(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function isLastDayOfMonth(date) {
  const next = new Date(date);
  next.setDate(next.getDate() + 1);
  return next.getDate() === 1;
}

function monthLabel(ymStr) {
  const [y, m] = ymStr.split("-").map(Number);
  const d = new Date(y, m - 1, 1);
  return d.toLocaleDateString("es-MX", { month: "long", year: "numeric" });
}

function summaryMessage(compliancePct, completed, total) {
  const pct = Math.round(compliancePct);
  const base = `Completaste ${completed} de ${total} actividad${total !== 1 ? "es" : ""} · cumplimiento: ${pct}%.`;
  if (pct >= 85) {
    return `${base} ¡Excelente trabajo este mes! Tu compromiso es un ejemplo para el equipo. ¡Sigue así!`;
  }
  if (pct >= 70) {
    return `${base} Buen mes, estás en camino. Con un poco más de esfuerzo alcanzas la meta. ¡Tú puedes!`;
  }
  return `${base} Este mes fue retador. Enfócate en completar a tiempo — el próximo mes es una nueva oportunidad.`;
}

async function getOrCreateJobRun({ prisma, plantId, period }) {
  const existing = await prisma.scheduledJobRun.findUnique({
    where: { jobType_plantId_period: { jobType: "MONTHLY_TECH_SUMMARY", plantId, period } },
  });
  if (existing) return existing;

  try {
    return await prisma.scheduledJobRun.create({
      data: { jobType: "MONTHLY_TECH_SUMMARY", plantId, period, status: "PENDING" },
    });
  } catch {
    return prisma.scheduledJobRun.findUnique({
      where: { jobType_plantId_period: { jobType: "MONTHLY_TECH_SUMMARY", plantId, period } },
    });
  }
}

export async function runMonthlyTechSummaryJob({ prisma, forcePlantId = null, forceMonth = null }) {
  const settings = await prisma.appSettings.findUnique({ where: { id: 1 } });
  if (!settings?.monthlyTechSummaryEnabled && !forceMonth && !forcePlantId) return [];

  const plants = await prisma.plant.findMany({
    where: { active: true, ...(forcePlantId ? { id: Number(forcePlantId) } : {}) },
    select: { id: true, name: true, timezone: true },
    orderBy: { id: "asc" },
  });

  const results = [];

  for (const plant of plants) {
    try {
      const nowTz = nowInTz(plant.timezone || TZ);
      const period = forceMonth || ym(nowTz);

      if (!forceMonth && !forcePlantId) {
        if (!isLastDayOfMonth(nowTz) || nowTz.getHours() < SEND_HOUR) {
          results.push({ plantId: plant.id, sent: false, reason: "OUTSIDE_WINDOW", period });
          continue;
        }
      }

      const jobRun = await getOrCreateJobRun({ prisma, plantId: plant.id, period });
      if (jobRun?.status === "SENT") {
        results.push({ plantId: plant.id, sent: false, reason: "ALREADY_SENT", period });
        continue;
      }

      await prisma.scheduledJobRun.update({
        where: { id: jobRun.id },
        data: { status: "PENDING", startedAt: new Date() },
      });

      // Rango del mes
      const [y, m] = period.split("-").map(Number);
      const from = new Date(y, m - 1, 1, 0, 0, 0);
      const to   = new Date(y, m, 0, 23, 59, 59, 999);

      // Técnicos con usuario vinculado
      const technicians = await prisma.technician.findMany({
        where: { plantId: plant.id, deletedAt: null, user: { isNot: null } },
        select: { id: true, name: true, user: { select: { id: true, active: true } } },
      });

      let notified = 0;

      for (const tech of technicians) {
        if (!tech.user?.active) continue;

        const executions = await prisma.execution.findMany({
          where: {
            plantId: plant.id,
            technicianId: tech.id,
            scheduledAt: { gte: from, lte: to },
          },
          select: { status: true },
        });

        const completed = executions.filter((e) => e.status === "COMPLETED").length;
        const overdue   = executions.filter((e) => e.status === "OVERDUE").length;
        const pending   = executions.filter((e) => e.status === "PENDING").length;
        const total     = completed + overdue + pending;

        if (total === 0) continue;

        const pct = (completed / total) * 100;
        const label = monthLabel(period);

        await notifyTechnicianAssignee(prisma, {
          plantId: plant.id,
          technicianId: tech.id,
          type: "MONTHLY_TECH_SUMMARY",
          title: `Tu resumen de ${label}`,
          message: summaryMessage(pct, completed, total),
          link: `/activities?month=${period}&scope=mine`,
        }).catch(() => {});

        notified++;
      }

      await prisma.scheduledJobRun.update({
        where: { id: jobRun.id },
        data: {
          status: "SENT",
          finishedAt: new Date(),
          recipientsJson: String(notified),
        },
      });

      results.push({ plantId: plant.id, sent: true, notified, period });
    } catch (e) {
      console.error(`[monthlyTechSummary] plantId=${plant.id}:`, e);
      results.push({ plantId: plant.id, sent: false, reason: "ERROR", error: e?.message });
    }
  }

  return results;
}

export function startMonthlyTechSummaryScheduler({ prisma }) {
  const run = async () => {
    try {
      const result = await runMonthlyTechSummaryJob({ prisma });
      if (result.some((r) => r.sent)) {
        console.log("📬 monthlyTechSummaryJob:", result);
      }
    } catch (e) {
      console.error("❌ monthlyTechSummaryScheduler:", e);
    }
  };

  setTimeout(run, 20_000);
  const interval = setInterval(run, 60 * 60 * 1000); // cada hora

  console.log("✅ Monthly Tech Summary scheduler iniciado");
  return interval;
}
