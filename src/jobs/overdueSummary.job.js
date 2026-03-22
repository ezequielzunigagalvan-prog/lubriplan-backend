import fs from "fs";
import path from "path";
import { sendOverdueSummaryEmail } from "../services/email/email.service.js";

const STATE_DIR = path.resolve(process.cwd(), "data");
const STATE_FILE = path.join(STATE_DIR, "overdue-summary-state.json");
const DEFAULT_HOUR = Number(process.env.OVERDUE_SUMMARY_HOUR || 8);

function up(v) {
  return String(v || "").trim().toUpperCase();
}

function startOfDaySafe(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function ymLocal(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function getLocalParts(date = new Date(), timezone = "America/Mexico_City") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  return {
    dateKey: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour") || 0),
  };
}

function readState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function canSendToday({ plantId, timezone, hour = DEFAULT_HOUR, state }) {
  const now = new Date();
  const { dateKey, hour: localHour } = getLocalParts(now, timezone);
  if (localHour < hour) return { ok: false, dateKey, reason: "BEFORE_WINDOW" };

  const sentKey = state?.[String(plantId)]?.lastSentDateKey || null;
  if (sentKey === dateKey) return { ok: false, dateKey, reason: "ALREADY_SENT_TODAY" };

  return { ok: true, dateKey, reason: "OK" };
}

export async function runOverdueSummaryJob({
  prisma,
  baseUrl = "",
  forcePlantId = null,
}) {
  if (!prisma) throw new Error("runOverdueSummaryJob: prisma is required");

  const today = startOfDaySafe(new Date());
  const now = new Date();
  const month = ymLocal(now);

  const plants = await prisma.plant.findMany({
    where: {
      active: true,
      ...(forcePlantId ? { id: Number(forcePlantId) } : {}),
    },
    select: {
      id: true,
      name: true,
      timezone: true,
    },
  });

  const results = [];

  for (const plant of plants) {
    try {
      const overdueItems = await prisma.execution.findMany({
        where: {
          plantId: plant.id,
          scheduledAt: { lt: today },
          status: { not: "COMPLETED" },
        },
        select: {
          id: true,
          scheduledAt: true,
          status: true,
          technicianId: true,
          route: {
            select: {
              id: true,
              name: true,
              equipment: {
                select: {
                  id: true,
                  name: true,
                  code: true,
                  location: true,
                  criticality: true,
                },
              },
            },
          },
          equipment: {
            select: {
              id: true,
              name: true,
              code: true,
              location: true,
              criticality: true,
            },
          },
        },
        orderBy: { scheduledAt: "asc" },
      });

      const totalOverdue = overdueItems.length;

      if (totalOverdue <= 0) {
        results.push({
          plantId: plant.id,
          plantName: plant.name,
          sent: false,
          reason: "NO_OVERDUE",
          totalOverdue: 0,
          criticalOverdue: 0,
          unassignedOverdue: 0,
          recipients: 0,
        });
        continue;
      }

      const criticalOverdue = overdueItems.filter((item) => {
        const eq = item?.equipment || item?.route?.equipment || null;
        const crit = up(eq?.criticality);
        return ["ALTA", "CRITICA", "CRÍTICA"].includes(crit);
      }).length;

      const unassignedOverdue = overdueItems.filter(
        (item) => item?.technicianId == null
      ).length;

      const topOverdue = overdueItems.slice(0, 10).map((item) => {
        const eq = item?.equipment || item?.route?.equipment || null;

        return {
          executionId: item.id,
          scheduledAt: item.scheduledAt,
          routeName: item?.route?.name || "Actividad",
          equipmentName: eq?.name || "Equipo",
          equipmentCode: eq?.code || "",
          location: eq?.location || "",
          criticality: eq?.criticality || "",
          technicianId: item?.technicianId ?? null,
          status: item?.status || "PENDING",
        };
      });

      const dashboardUrl = baseUrl
        ? `${String(baseUrl).replace(/\/$/, "")}/activities?status=OVERDUE&month=${encodeURIComponent(month)}`
        : `/activities?status=OVERDUE&month=${encodeURIComponent(month)}`;

      const sendResult = await sendOverdueSummaryEmail({
        prisma,
        payload: {
          plantId: plant.id,
          plantName: plant.name,
          totalOverdue,
          criticalOverdue,
          unassignedOverdue,
          generatedAt: new Date(),
          month,
          topOverdue,
          link: dashboardUrl,
        },
      });

      results.push({
        plantId: plant.id,
        plantName: plant.name,
        sent: !!sendResult?.ok,
        reason: sendResult?.ok ? "OK" : sendResult?.reason || "SEND_FAILED",
        totalOverdue,
        criticalOverdue,
        unassignedOverdue,
        recipients: Array.isArray(sendResult?.recipients)
          ? sendResult.recipients.length
          : 0,
      });
    } catch (error) {
      console.error(`❌ overdueSummaryJob plant ${plant?.id}:`, error);

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

export async function runScheduledOverdueSummaryJob({
  prisma,
  baseUrl = process.env.APP_BASE_URL || "http://localhost:5173",
  sendHour = DEFAULT_HOUR,
}) {
  if (!prisma) throw new Error("runScheduledOverdueSummaryJob: prisma is required");

  const plants = await prisma.plant.findMany({
    where: { active: true },
    select: {
      id: true,
      name: true,
      timezone: true,
    },
    orderBy: { id: "asc" },
  });

  const state = readState();
  const results = [];
  let changed = false;

  for (const plant of plants) {
    const gate = canSendToday({
      plantId: plant.id,
      timezone: plant.timezone || "America/Mexico_City",
      hour: sendHour,
      state,
    });

    if (!gate.ok) {
      results.push({
        plantId: plant.id,
        plantName: plant.name,
        sent: false,
        reason: gate.reason,
      });
      continue;
    }

    const result = await runOverdueSummaryJob({
      prisma,
      baseUrl,
      forcePlantId: plant.id,
    });

    const plantResult = Array.isArray(result?.results)
      ? result.results[0]
      : null;

    results.push(plantResult || {
      plantId: plant.id,
      plantName: plant.name,
      sent: false,
      reason: "UNKNOWN",
    });

    if (plantResult?.sent) {
      state[String(plant.id)] = {
        lastSentDateKey: gate.dateKey,
        lastSentAt: new Date().toISOString(),
      };
      changed = true;
    }
  }

  if (changed) writeState(state);

  return {
    ok: true,
    ranAt: new Date().toISOString(),
    plantsProcessed: plants.length,
    results,
  };
}

export function startOverdueSummaryScheduler({
  prisma,
  baseUrl = process.env.APP_BASE_URL || "http://localhost:5173",
  sendHour = DEFAULT_HOUR,
}) {
  const run = async () => {
    try {
      const result = await runScheduledOverdueSummaryJob({
        prisma,
        baseUrl,
        sendHour,
      });
      console.log("📧 overdueSummaryScheduler:", result);
    } catch (e) {
      console.error("❌ overdueSummaryScheduler:", e);
    }
  };

  setTimeout(run, 20_000);
  const interval = setInterval(run, 15 * 60 * 1000);

  console.log(`✅ Overdue Summary scheduler iniciado (hora local objetivo: ${sendHour}:00)`);
  return interval;
}
