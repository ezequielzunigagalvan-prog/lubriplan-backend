// src/ia/chatContextBuilder.js
// Foto de la planta activa para LubriBot.
//
// Correcciones respecto a la versión anterior:
//  - Los indicadores del mes salen del mismo cálculo que Análisis y el Reporte mensual
//    (computeOverview), así LubriBot no contradice esas pantallas.
//  - El mes se calcula en la zona horaria de la planta (antes, con el reloj del servidor).
//  - Ahora incluye QUÉ actividades están vencidas, cuáles tocan hoy y cuáles vienen
//    (antes solo los conteos, así que no podía responder "¿cuáles están vencidas?").
//  - Los reportes de condición se ordenan por gravedad real (antes, alfabéticamente: REGULAR primero).
//  - Agrega pendientes del Plan de acción y órdenes OLP abiertas.
//  - Todas las consultas filtran por la planta de forma explícita.

import { computeOverview } from "../routes/analysis.routes.js";
import { zonedYmd, zonedStartOfDay, safeTimeZone } from "../utils/tzRange.js";

const SEVERITY = { CRITICO: 4, MALO: 3, REGULAR: 2, BUENO: 1 };
const isActiveTech = (s) => ["ACTIVO", "ACTIVE"].includes(String(s || "").trim().toUpperCase());
const addDaysYmd = (ymd, n) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dayDiff = (a, b) => Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86_400_000);
const r1 = (n) => (n == null ? null : Math.round(Number(n) * 10) / 10);

function activityRow(e, tz, today) {
  const eq = e.route?.equipment || e.equipment || null;
  const ymd = zonedYmd(e.scheduledAt, tz);
  return {
    activity: e.route?.name || e.manualTitle || "Actividad",
    equipment: eq?.name || null,
    code: eq?.code || null,
    criticality: eq?.criticality || null,
    date: ymd,
    daysLate: ymd < today ? dayDiff(ymd, today) : 0,
    technician: e.technician?.name || null,
  };
}

export async function buildChatContext(prisma, { plantId, role }) {
  const pid = Number(plantId);
  if (!Number.isFinite(pid) || pid <= 0) return null;

  const plant = await prisma.plant.findUnique({ where: { id: pid }, select: { name: true, timezone: true } });
  const tz = safeTimeZone(plant?.timezone || "America/Mexico_City");
  const today = zonedYmd(new Date(), tz);
  const month = today.slice(0, 7);
  const weekEnd = zonedStartOfDay(addDaysYmd(today, 8), tz);

  const execSelect = {
    scheduledAt: true,
    manualTitle: true,
    technician: { select: { name: true } },
    equipment: { select: { name: true, code: true, criticality: true } },
    route: { select: { name: true, equipment: { select: { name: true, code: true, criticality: true } } } },
  };

  const [overview, open, reports, lubricants, technicians, purchaseOrders, actions, olp] = await Promise.all([
    computeOverview(prisma, pid, { month }).catch(() => null),
    // Todas las actividades abiertas hasta dentro de 7 días (incluye vencidas de meses anteriores)
    prisma.execution.findMany({
      where: { plantId: pid, status: { in: ["PENDING", "OVERDUE"] }, scheduledAt: { lt: weekEnd } },
      select: execSelect,
      orderBy: { scheduledAt: "asc" },
      take: 400,
    }),
    prisma.conditionReport.findMany({
      where: { plantId: pid, status: { in: ["OPEN", "IN_PROGRESS"] } },
      select: { status: true, condition: true, category: true, createdAt: true, equipment: { select: { name: true, code: true, criticality: true } } },
      take: 50,
    }),
    prisma.lubricant.findMany({
      where: { plantId: pid, minStock: { not: null } },
      select: { name: true, code: true, stock: true, minStock: true, unit: true },
      take: 200,
    }),
    prisma.technician.findMany({
      where: { plantId: pid, deletedAt: null },
      select: { id: true, name: true, code: true, status: true },
      take: 100,
    }),
    prisma.purchaseOrder.findMany({
      where: { plantId: pid, status: { in: ["REQUESTED", "APPROVED"] } },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, items: { select: { requestedQty: true, unit: true, lubricant: { select: { name: true } } } } },
      take: 5,
    }),
    prisma.actionItem.findMany({
      where: { plantId: pid, status: { not: "DONE" } },
      orderBy: { dueDate: "asc" },
      select: { title: true, category: true, progress: true, dueDate: true, owner: { select: { name: true } } },
      take: 10,
    }).catch(() => []),
    prisma.preventiveOrder.findMany({
      where: { plantId: pid, status: { in: ["DRAFT", "OPEN", "IN_PROGRESS"] } },
      orderBy: { scheduledDate: "asc" },
      select: { id: true, title: true, status: true, scheduledDate: true, equipment: { select: { name: true, code: true } }, _count: { select: { items: true } } },
      take: 8,
    }).catch(() => []),
  ]);

  const rows = open.map((e) => activityRow(e, tz, today));
  const overdue = rows.filter((r) => r.date < today).sort((a, b) => b.daysLate - a.daysLate);
  const dueToday = rows.filter((r) => r.date === today);
  const upcoming = rows.filter((r) => r.date > today);

  const tCount = new Map();
  for (const r of rows) {
    if (!r.technician) continue;
    const t = tCount.get(r.technician) || { overdue: 0, today: 0, week: 0 };
    if (r.date < today) t.overdue++;
    else if (r.date === today) t.today++;
    else t.week++;
    tCount.set(r.technician, t);
  }

  const c = overview?.compliance || {};
  return {
    plantName: plant?.name || "Planta activa",
    today,
    month,
    role,
    month_kpis: overview
      ? {
          complianceRate: c.complianceRate,
          onTimeRate: c.onTimeRate,
          due: c.due,
          completed: c.completed,
          onTime: c.onTime,
          late: c.late,
          overdueInMonth: c.overdue,
          criticalOverdue: c.criticalOverdue,
          executed: overview.executed?.total,
          ole: overview.ole?.value,
          condition: overview.condition ? { BUENO: overview.condition.BUENO, REGULAR: overview.condition.REGULAR, MALO: overview.condition.MALO, CRITICO: overview.condition.CRITICO } : null,
          oilL: overview.consumption?.oilL,
          greaseKg: overview.consumption?.greaseKg,
          topLubricants: (overview.consumption?.byLubricant || []).slice(0, 3).map((l) => `${l.name}: ${r1(l.qty)} ${l.unit || ""}`.trim()),
          failures: (overview.failures || []).slice(0, 5).map((f) => ({ equipment: f.name, code: f.code, malo: f.malo, critico: f.critico, reports: f.reports })),
        }
      : null,
    open: {
      overdueCount: overdue.length,
      overdue: overdue.slice(0, 12),
      todayCount: dueToday.length,
      today: dueToday.slice(0, 10),
      next7Count: upcoming.length,
      next7: upcoming.slice(0, 8),
      unassigned: rows.filter((r) => !r.technician).length,
    },
    conditionReports: reports
      .map((r) => ({
        status: r.status,
        condition: String(r.condition || ""),
        category: r.category || null,
        equipment: r.equipment?.name || "Equipo",
        code: r.equipment?.code || null,
        criticality: r.equipment?.criticality || null,
        ageDays: Math.max(0, Math.floor((Date.now() - new Date(r.createdAt)) / 86_400_000)),
      }))
      .sort((a, b) => (SEVERITY[b.condition] || 0) - (SEVERITY[a.condition] || 0) || b.ageDays - a.ageDays),
    technicians: technicians
      .filter((t) => isActiveTech(t.status))
      .map((t) => ({ name: t.name, code: t.code, ...(tCount.get(t.name) || { overdue: 0, today: 0, week: 0 }) }))
      .sort((a, b) => b.overdue - a.overdue || b.today - a.today),
    lowStock: lubricants
      .filter((l) => l.minStock != null && Number(l.stock) <= Number(l.minStock))
      .map((l) => ({ name: l.name, code: l.code || null, stock: r1(l.stock), minStock: r1(l.minStock), unit: l.unit })),
    purchaseOrders: purchaseOrders.map((po) => ({
      id: po.id,
      status: po.status,
      items: po.items.map((i) => `${i.lubricant?.name || "Lubricante"} ${r1(i.requestedQty)} ${i.unit || ""}`.trim()),
    })),
    actionPlan: actions.map((a) => ({
      title: a.title,
      category: a.category,
      progress: a.progress,
      due: a.dueDate ? new Date(a.dueDate).toISOString().slice(0, 10) : null,
      owner: a.owner?.name || null,
    })),
    olpOrders: olp.map((o) => ({
      id: o.id,
      title: o.title,
      status: o.status,
      date: o.scheduledDate ? new Date(o.scheduledDate).toISOString().slice(0, 10) : null,
      equipment: o.equipment?.name || null,
      code: o.equipment?.code || null,
      routes: o._count?.items || 0,
    })),
  };
}
