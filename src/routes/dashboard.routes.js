// src/routes/dashboard.routes.js
import express from "express";

export default function dashboardRoutes({
  prisma,
  auth,
  requireRole,
  buildDashboardSummary,
  toStartOfDaySafe,
  getPredictiveMetrics,
}) {
  const router = express.Router();

  const parseMonthRange = (monthRaw) => {
    const now = new Date();
    const month = String(monthRaw || "").trim();
    const monthOk = /^\d{4}-\d{2}$/.test(month);

    const year = monthOk ? Number(month.slice(0, 4)) : now.getFullYear();
    const monthNum = monthOk ? Number(month.slice(5, 7)) : now.getMonth() + 1;

    const from = new Date(year, monthNum - 1, 1, 0, 0, 0, 0);
    const to = new Date(year, monthNum, 0, 23, 59, 59, 999);
    const ym = `${year}-${String(monthNum).padStart(2, "0")}`;

    return { monthOk, year, monthNum, from, to, ym };
  };

  // GET /api/dashboard/summary
  router.get("/summary", auth, async (req, res) => {
    try {
      const month = String(req.query.month || "").trim();
      const days = Number(req.query.days ?? 30);

      const plantId = req.currentPlantId;
      if (!plantId) {
        return res.status(400).json({ error: "PLANT_REQUIRED" });
      }

      const payload = await buildDashboardSummary({
        prisma,
        user: req.user,
        month,
        days,
        plantId,
        toStartOfDaySafe,
      });

      return res.json(payload);
    } catch (e) {
      console.error("dashboard summary error:", e);
      return res.status(500).json({ error: "Error dashboard summary" });
    }
  });

  // GET /api/dashboard/alerts?month=YYYY-MM
  router.get("/alerts", auth, requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
    try {
      const role = String(req.user?.role || "").toUpperCase();
      const plantId = req.currentPlantId;

      if (!plantId) {
        return res.status(400).json({ error: "PLANT_REQUIRED" });
      }

      const { year, monthNum, from, to, ym } = parseMonthRange(req.query.month);
      const today = toStartOfDaySafe(new Date());

      const overdueActivities = await prisma.execution.count({
        where: {
          plantId,
          scheduledAt: { gte: from, lte: to, lt: today },
          status: { not: "COMPLETED" },
        },
      });

      const unassignedPending = await prisma.execution.count({
        where: {
          plantId,
          scheduledAt: { gte: from, lte: to },
          status: "PENDING",
          technicianId: null,
        },
      });

      const lubs = await prisma.lubricant.findMany({
        where: {
          plantId,
          minStock: { not: null },
        },
        select: { stock: true, minStock: true },
      });

      let lowStockCount = 0;
      for (const l of lubs) {
        const min = Number(l.minStock);
        const stock = Number(l.stock);
        if (Number.isFinite(min) && Number.isFinite(stock) && stock <= min) lowStockCount += 1;
      }

      const badConditionCount = await prisma.execution.count({
        where: {
          plantId,
          status: "COMPLETED",
          condition: "MALO",
          executedAt: { gte: from, lte: to },
        },
      });

      const criticalExecutions = await prisma.execution.count({
        where: {
          plantId,
          status: "COMPLETED",
          condition: "CRITICO",
          executedAt: { gte: from, lte: to },
        },
      });

      const equipmentWithoutRoutes = await prisma.equipment.count({
        where: {
          plantId,
          routes: { none: {} },
        },
      });

      const outOfRangeExecs = await prisma.execution.findMany({
        where: {
          plantId,
          status: "COMPLETED",
          executedAt: { gte: from, lte: to },
          usedQuantity: { not: null },
          route: {
            is: {
              plantId,
              quantity: { gt: 0 },
            },
          },
        },
        select: {
          usedQuantity: true,
          route: { select: { quantity: true, points: true, instructions: true } },
        },
      });

      const TOL_PCT = 0.3;
      let outOfRangeConsumption = 0;

      for (const ex of outOfRangeExecs) {
        const used = Number(ex.usedQuantity);
        const qty = Number(ex?.route?.quantity);
        const pts = Math.max(1, Number(ex?.route?.points ?? 1));
        const instr = String(ex?.route?.instructions || "");
        const isAdvanced = instr.includes("PUNTOS (AVANZADO)");

        if (!Number.isFinite(used) || !Number.isFinite(qty) || qty <= 0) continue;

        const expectedTotal = qty * pts;
        const actualTotal = isAdvanced ? used : used * pts;

        const deviation = Math.abs(actualTotal - expectedTotal) / expectedTotal;
        if (deviation > TOL_PCT) outOfRangeConsumption += 1;
      }

      const conditionReportsOpen = await prisma.conditionReport.count({
        where: {
          plantId,
          detectedAt: { gte: from, lte: to },
          status: { in: ["OPEN", "IN_PROGRESS"] },
        },
      });

      const total =
        overdueActivities +
        lowStockCount +
        unassignedPending +
        badConditionCount +
        criticalExecutions +
        equipmentWithoutRoutes +
        outOfRangeConsumption +
        conditionReportsOpen;

      return res.json({
        ok: true,
        updatedAt: new Date().toISOString(),
        role,
        plantId,
        month: ym,
        range: { from: from.toISOString(), to: to.toISOString() },
        alerts: {
          overdueActivities,
          lowStockCount,
          unassignedPending,
          badConditionCount,
          criticalExecutions,
          equipmentWithoutRoutes,
          outOfRangeConsumption,
          conditionReportsOpen,
        },
        total,
      });
    } catch (e) {
      console.error("Error dashboard alerts:", e);
      return res.status(500).json({ error: "Error dashboard alerts" });
    }
  });

  // GET /api/dashboard/priority-queue?month=YYYY-MM
  router.get("/priority-queue", auth, requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
    try {
      const role = String(req.user?.role || "").toUpperCase();
      const plantId = req.currentPlantId;

      if (!plantId) {
        return res.status(400).json({ error: "PLANT_REQUIRED" });
      }

      const { from, to, ym } = parseMonthRange(req.query.month);
      const today = toStartOfDaySafe(new Date());
      const now = new Date();

      const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
      const sevFromScore = (score) =>
        score >= 90 ? "CRITICAL" : score >= 70 ? "HIGH" : score >= 45 ? "MED" : "LOW";
      const add = (arr, item) => arr.push(item);
      const labelFromType = (type) => {
        const t = String(type || "").toUpperCase();
        if (t === "EXEC_OVERDUE") return "Actividad vencida";
        if (t === "EXEC_UNASSIGNED") return "Actividad sin tÃ©cnico";
        if (t === "COND_REPORT") return "CondiciÃ³n reportada";
        if (t === "DAYS_TO_EMPTY") return "Inventario en riesgo";
        if (t === "CONSUMPTION_ANOMALY") return "Consumo fuera de patrÃ³n";
        return "Prioridad";
      };
      const priorityLabelFromSeverity = (severity) => {
        const s = String(severity || "").toUpperCase();
        if (s === "CRITICAL") return "AtenciÃ³n inmediata";
        if (s === "HIGH") return "Alta prioridad";
        if (s === "MED") return "AtenciÃ³n hoy";
        return "Seguimiento";
      };
      const ownerLabelFromSuggestedOwner = (owner) => {
        const o = String(owner || "").toUpperCase();
        if (o === "ADMIN") return "Administrador";
        if (o === "SUPERVISOR") return "Supervisor";
        if (o === "TECHNICIAN") return "TÃ©cnico";
        return "Equipo";
      };
      const actionFromItem = (item) => {
        const t = String(item?.type || "").toUpperCase();
        if (t === "EXEC_OVERDUE") return "Completar o reprogramar la actividad hoy";
        if (t === "EXEC_UNASSIGNED") return "Asignar responsable antes de que se retrase mÃ¡s";
        if (t === "COND_REPORT") return "Revisar el reporte y definir acciÃ³n correctiva";
        if (t === "DAYS_TO_EMPTY") return "Reponer lubricante o ajustar el plan de consumo";
        if (t === "CONSUMPTION_ANOMALY") return "Inspeccionar el equipo y validar el consumo real";
        return "Revisar y atender";
      };
      const formatReason = (item) => {
        const t = String(item?.type || "").toUpperCase();
        const raw = String(item?.reason || "").trim();
        if (t === "DAYS_TO_EMPTY") {
          return raw
            .replace(/Days-to-empty|DTE/gi, "DÃ­as estimados restantes")
            .replace(/Stock:/gi, "Stock actual:")
            .replace(/Bajo m[Ã­i]nimo/gi, "por debajo del mÃ­nimo");
        }
        if (t === "CONSUMPTION_ANOMALY") {
          return raw
            .replace(/Ratio:/gi, "DesviaciÃ³n:")
            .replace(/Base:/gi, "Promedio base:")
            .replace(/Ãšlt\.?14:|Ult\.?14:/gi, "Promedio Ãºltimos 14 dÃ­as:");
        }
        if (t === "EXEC_UNASSIGNED") {
          return raw.replace(/^Vencida/gi, "Ya vencida").replace(/^Pendiente/gi, "Pendiente por asignar");
        }
        if (t === "EXEC_OVERDUE") {
          return raw.replace(/^Programada/gi, "Retrasada");
        }
        return raw || "Sin detalle adicional";
      };
      const formatTitle = (item) => {
        const t = String(item?.type || "").toUpperCase();
        const severity = String(item?.severity || "").toUpperCase();
        if (t === "EXEC_OVERDUE") {
          return severity === "CRITICAL"
            ? "Atender actividad vencida de inmediato"
            : "Atender actividad vencida hoy";
        }
        if (t === "EXEC_UNASSIGNED") {
          return severity === "CRITICAL"
            ? "Asignar tÃ©cnico a una actividad crÃ­tica"
            : "Asignar tÃ©cnico a una actividad pendiente";
        }
        if (t === "COND_REPORT") {
          return "Revisar condiciÃ³n anormal reportada";
        }
        if (t === "DAYS_TO_EMPTY") {
          return "Reponer lubricante con riesgo de agotarse";
        }
        if (t === "CONSUMPTION_ANOMALY") {
          return "Revisar consumo fuera de patrÃ³n";
        }
        return String(item?.title || "").trim() || labelFromType(t);
      };

      const overdueExecs = await prisma.execution.findMany({
        where: {
          plantId,
          scheduledAt: { gte: from, lte: to, lt: today },
          status: { not: "COMPLETED" },
        },
        select: {
          id: true,
          scheduledAt: true,
          status: true,
          technicianId: true,
          route: {
            select: {
              name: true,
              equipment: {
                select: { id: true, name: true, code: true, location: true, criticality: true },
              },
            },
          },
          equipment: { select: { id: true, name: true, code: true, location: true, criticality: true } },
        },
        orderBy: { scheduledAt: "asc" },
        take: 25,
      });

      const unassignedExecs = await prisma.execution.findMany({
        where: {
          plantId,
          scheduledAt: { gte: from, lte: to },
          status: { not: "COMPLETED" },
          technicianId: null,
        },
        select: {
          id: true,
          scheduledAt: true,
          status: true,
          route: {
            select: {
              name: true,
              equipment: {
                select: { id: true, name: true, code: true, location: true, criticality: true },
              },
            },
          },
          equipment: { select: { id: true, name: true, code: true, location: true, criticality: true } },
        },
        orderBy: { scheduledAt: "asc" },
        take: 25,
      });

      const openReports = await prisma.conditionReport.findMany({
        where: {
          plantId,
          status: "OPEN",
        },
        select: {
          id: true,
          detectedAt: true,
          condition: true,
          category: true,
          equipment: { select: { id: true, name: true, code: true, location: true, criticality: true } },
        },
        orderBy: { detectedAt: "desc" },
        take: 20,
      });

      const metrics = await getPredictiveMetrics({
        prisma,
        toStartOfDaySafe,
        plantId,
        month: ym,
        histDays: 90,
        shortWindowDays: 14,
        now,
      });

      const dteTop = (metrics?.lubricantDaysToEmptyTop || []).filter(
        (x) => String(x?.risk || "").toUpperCase() !== "LOW"
      );

      const anomaliesTop = (metrics?.equipmentConsumptionAnomaliesTop || []).filter(
        (x) => String(x?.risk || "").toUpperCase() !== "LOW"
      );

      const queue = [];

      for (const ex of overdueExecs || []) {
        const eq = ex?.equipment || ex?.route?.equipment || null;
        const crit = String(eq?.criticality || "").toUpperCase();
        const isCritical = ["ALTA", "CRITICA", "CRÃTICA"].includes(crit);

        const sched = ex?.scheduledAt ? toStartOfDaySafe(new Date(ex.scheduledAt)) : null;
        const daysLate = sched ? Math.floor((today.getTime() - sched.getTime()) / 86400000) : 0;

        let score = 55 + clamp(daysLate * 6, 0, 30);
        if (isCritical) score += 20;
        if (ex?.technicianId == null) score += 10;
        score = clamp(score, 0, 100);

        add(queue, {
          key: `EXEC_OVERDUE:${ex.id}`,
          type: "EXEC_OVERDUE",
          severity: sevFromScore(score),
          score,
          title: `Actividad vencida${isCritical ? " (crÃ­tica)" : ""}`,
          reason: `Programada ${daysLate} dÃ­a(s) atrÃ¡s${eq?.name ? ` Â· ${eq.name}` : ""}`,
          suggestedOwner: ex?.technicianId ? "TECHNICIAN" : "SUPERVISOR",
          entity: { executionId: ex.id, equipmentId: eq?.id ?? null },
          link: `/activities?status=OVERDUE&month=${ym}`,
        });
      }

      for (const ex of unassignedExecs || []) {
        const eq = ex?.equipment || ex?.route?.equipment || null;
        const crit = String(eq?.criticality || "").toUpperCase();
        const isCritical = ["ALTA", "CRITICA", "CRÃTICA"].includes(crit);

        let score = 45;
        const sched = ex?.scheduledAt ? toStartOfDaySafe(new Date(ex.scheduledAt)) : null;
        const isOverdue = sched ? sched.getTime() < today.getTime() : false;

        if (isOverdue) score += 20;
        if (isCritical) score += 20;
        score = clamp(score, 0, 100);

        add(queue, {
          key: `EXEC_UNASSIGNED:${ex.id}`,
          type: "EXEC_UNASSIGNED",
          severity: sevFromScore(score),
          score,
          title: `Actividad sin tÃ©cnico${isCritical ? " (crÃ­tica)" : ""}`,
          reason: `${isOverdue ? "Vencida" : "Pendiente"}${eq?.name ? ` Â· ${eq.name}` : ""}`,
          suggestedOwner: "SUPERVISOR",
          entity: { executionId: ex.id, equipmentId: eq?.id ?? null },
          link: `/activities?filter=unassigned&month=${ym}`,
        });
      }

      for (const r of openReports || []) {
        const eq = r?.equipment || null;
        const lvl = String(r?.condition || "REGULAR").toUpperCase();

        let score = 50;
        if (lvl === "CRITICO") score += 35;
        else if (lvl === "MALO") score += 25;
        else if (lvl === "REGULAR") score += 10;

        score = clamp(score, 0, 100);

        add(queue, {
          key: `COND_REPORT:${r.id}`,
          type: "COND_REPORT",
          severity: sevFromScore(score),
          score,
          title: `CondiciÃ³n anormal: ${lvl}`,
          reason: `${r?.category ? String(r.category) : "Sin categorÃ­a"}${eq?.name ? ` Â· ${eq.name}` : ""}`,
          suggestedOwner: "SUPERVISOR",
          entity: { reportId: r.id, equipmentId: eq?.id ?? null },
          link: `/condition-reports?status=OPEN`,
        });
      }

      for (const it of dteTop.slice(0, 10)) {
        const risk = String(it?.risk || "").toUpperCase();
        let score = risk === "HIGH" ? 90 : risk === "MED" ? 75 : 60;
        if (it?.underMin) score = Math.min(100, score + 8);

        add(queue, {
          key: `DTE:${it.lubricantId}`,
          type: "DAYS_TO_EMPTY",
          severity: sevFromScore(score),
          score,
          title: `Days-to-empty ${risk === "HIGH" ? "crÃ­tico" : "en riesgo"}`,
          reason: `${it.name || it.lubricantName || "Lubricante"} Â· DTE: ${it.daysToEmpty ?? it.dte ?? "â€”"} dÃ­a(s) Â· Stock: ${Number(it.stock || 0)} ${it.unit || ""}${it?.underMin ? " Â· Bajo mÃ­nimo" : ""}`,
          suggestedOwner: "ADMIN",
          entity: { lubricantId: it.lubricantId },
          link: `/inventory?filter=predictive-dte&month=${ym}`,
        });
      }

      for (const it of anomaliesTop.slice(0, 10)) {
        const risk = String(it?.risk || "").toUpperCase();
        let score = risk === "HIGH" ? 88 : risk === "MED" ? 72 : 58;

        const crit = String(it?.criticality || "").toUpperCase();
        if (["ALTA", "CRITICA", "CRÃTICA"].includes(crit)) score = Math.min(100, score + 7);

        add(queue, {
          key: `ANOMALY:${it.equipmentId}`,
          type: "CONSUMPTION_ANOMALY",
          severity: sevFromScore(score),
          score,
          title: `AnomalÃ­a de consumo (${risk})`,
          reason: `${it.name || it.equipmentName || "Equipo"}${it.code ? ` (${it.code})` : ""} Â· Ratio: ${it.ratio ?? "â€”"} Â· Base: ${it.baselineAvgDaily ?? "â€”"} Â· Ãšlt.14: ${it.last14AvgDaily ?? it.lastNAvgDaily ?? "â€”"}`,
          suggestedOwner: "SUPERVISOR",
          entity: { equipmentId: it.equipmentId },
          link: `/analysis?tab=consumption&filter=anomalies&month=${ym}`,
        });
      }

      const seen = new Set();
      const dedup = [];
      for (const item of queue) {
        if (!item?.key) continue;
        if (seen.has(item.key)) continue;
        seen.add(item.key);
        dedup.push(item);
      }

      dedup.sort((a, b) => (b.score - a.score) || String(a.type).localeCompare(String(b.type)));

      const presentable = dedup.slice(0, 20).map((item) => ({
        ...item,
        title: formatTitle(item),
        reason: formatReason(item),
        categoryLabel: labelFromType(item?.type),
        priorityLabel: priorityLabelFromSeverity(item?.severity),
        ownerLabel: ownerLabelFromSuggestedOwner(item?.suggestedOwner),
        actionLabel: actionFromItem(item),
      }));

      return res.json({
        ok: true,
        updatedAt: new Date().toISOString(),
        role,
        plantId,
        month: ym,
        range: { from: from.toISOString(), to: to.toISOString() },
        priorityQueue: presentable,
        total: dedup.length,
      });
    } catch (e) {
      console.error("Error dashboard priority queue:", e);
      return res.status(500).json({ error: "Error dashboard priority queue" });
    }
  });

  // GET /api/dashboard/alerts/predictive?month=YYYY-MM
  router.get(
    "/alerts/predictive",
    auth,
    requireRole(["ADMIN", "SUPERVISOR"]),
    async (req, res) => {
      try {
        const role = String(req.user?.role || "").toUpperCase();
        const plantId = req.currentPlantId;

        if (!plantId) {
          return res.status(400).json({ error: "PLANT_REQUIRED" });
        }

        const { year, monthNum, from, to, ym } = parseMonthRange(req.query.month);
        const today = toStartOfDaySafe(new Date());
        const now = new Date();

        const histDays = 90;
        const histFrom = new Date(today);
        histFrom.setDate(histFrom.getDate() - histDays);

        const completed = await prisma.execution.findMany({
          where: {
            plantId,
            status: "COMPLETED",
            executedAt: { gte: histFrom, lte: now },
          },
          select: {
            scheduledAt: true,
            executedAt: true,
            route: { select: { equipmentId: true } },
          },
        });

        const completedSafe = (completed || []).filter(
          (ex) => ex?.scheduledAt && ex?.executedAt && ex?.route?.equipmentId != null
        );

        const byEquipment = new Map();

        for (const ex of completedSafe) {
          const equipmentId = ex.route.equipmentId;

          const schedDay = toStartOfDaySafe(new Date(ex.scheduledAt));
          const execDay = toStartOfDaySafe(new Date(ex.executedAt));
          const delayDays = Math.floor((execDay.getTime() - schedDay.getTime()) / 86400000);

          if (!byEquipment.has(equipmentId)) {
            byEquipment.set(equipmentId, { total: 0, late2plus: 0, sumDelay: 0, maxDelay: 0 });
          }

          const s = byEquipment.get(equipmentId);
          s.total += 1;
          s.sumDelay += delayDays;
          if (delayDays >= 2) s.late2plus += 1;
          if (delayDays > s.maxDelay) s.maxDelay = delayDays;
        }

        const riskEquipments = [];
        for (const [equipmentId, s] of byEquipment.entries()) {
          const avgDelay = s.total ? s.sumDelay / s.total : 0;
          const lateRate = s.total ? s.late2plus / s.total : 0;

          let risk = "LOW";
          if (s.total >= 4 && lateRate >= 0.35) risk = "HIGH";
          else if (s.total >= 3 && lateRate >= 0.2) risk = "MED";

          riskEquipments.push({
            equipmentId,
            totalCompleted: s.total,
            late2plus: s.late2plus,
            lateRate: Number(lateRate.toFixed(3)),
            avgDelayDays: Number(avgDelay.toFixed(2)),
            maxDelayDays: s.maxDelay,
            risk,
          });
        }

        riskEquipments.sort((a, b) => {
          const score = (x) => (x.risk === "HIGH" ? 3 : x.risk === "MED" ? 2 : 1);
          const ds = score(b) - score(a);
          if (ds !== 0) return ds;
          if (b.lateRate !== a.lateRate) return b.lateRate - a.lateRate;
          return (b.maxDelayDays || 0) - (a.maxDelayDays || 0);
        });

        const pendingInMonth = await prisma.execution.findMany({
          where: {
            plantId,
            scheduledAt: { gte: from, lte: to },
            status: { not: "COMPLETED" },
          },
          select: {
            id: true,
            scheduledAt: true,
            status: true,
            technicianId: true,
            route: { select: { equipmentId: true, name: true } },
          },
        });

        const pendingSafe = (pendingInMonth || []).filter(
          (ex) => ex?.route?.equipmentId != null && ex?.scheduledAt
        );

        const riskMap = new Map(riskEquipments.map((x) => [x.equipmentId, x.risk]));

        let riskPendingCount = 0;
        let riskOverdueCount = 0;
        const topRiskPending = [];

        for (const ex of pendingSafe) {
          const equipmentId = ex.route.equipmentId;
          const risk = riskMap.get(equipmentId) || "LOW";
          if (risk === "LOW") continue;

          riskPendingCount += 1;

          const schedDay = toStartOfDaySafe(new Date(ex.scheduledAt));
          const overdue = schedDay.getTime() < today.getTime();
          if (overdue) riskOverdueCount += 1;

          if (topRiskPending.length < 10) {
            topRiskPending.push({
              executionId: ex.id,
              equipmentId,
              routeName: ex?.route?.name || "â€”",
              scheduledAt: ex.scheduledAt,
              risk,
              overdue,
              technicianId: ex.technicianId ?? null,
            });
          }
        }

        const alerts = {
          riskEquipmentsTop: riskEquipments.slice(0, 10),
          riskPendingCount,
          riskOverdueCount,
          topRiskPending,
        };

        const badEvents = await prisma.execution.findMany({
          where: {
            plantId,
            status: "COMPLETED",
            executedAt: { gte: histFrom, lte: now },
            condition: { in: ["MALO", "CRITICO"] },
          },
          select: {
            executedAt: true,
            condition: true,
            route: { select: { equipmentId: true } },
          },
        });

        const badByEq = new Map();
        for (const ex of badEvents || []) {
          const eqId = ex?.route?.equipmentId;
          if (eqId == null) continue;

          const t = new Date(ex.executedAt).getTime();
          if (!Number.isFinite(t)) continue;

          if (!badByEq.has(eqId)) badByEq.set(eqId, { total: 0, crit: 0, lastAt: null });
          const s = badByEq.get(eqId);

          s.total += 1;
          if (String(ex.condition).toUpperCase() === "CRITICO") s.crit += 1;
          if (!s.lastAt || t > new Date(s.lastAt).getTime()) s.lastAt = ex.executedAt;
        }

        const repeatedFailures = [];
        for (const [equipmentId, s] of badByEq.entries()) {
          const score = s.total + s.crit * 1.5;
          const lastAtTs = s.lastAt ? new Date(s.lastAt).getTime() : null;
          const daysSinceLast = Number.isFinite(lastAtTs)
            ? Math.floor((now.getTime() - lastAtTs) / 86400000)
            : null;
          const recentEnough = daysSinceLast == null || daysSinceLast <= 45;

          let risk = "LOW";
          if (recentEnough && (s.total >= 4 || s.crit >= 2)) risk = "HIGH";
          else if (recentEnough && (s.total >= 3 || (s.total >= 2 && s.crit >= 1))) risk = "MED";

          repeatedFailures.push({
            equipmentId,
            badTotal: s.total,
            critTotal: s.crit,
            lastBadAt: s.lastAt,
            daysSinceLast,
            score: Number(score.toFixed(2)),
            risk,
          });
        }

        repeatedFailures.sort((a, b) => (b.score - a.score) || (b.badTotal - a.badTotal));
        const repeatedFailuresCount = repeatedFailures.filter((x) => x.risk !== "LOW").length;

        alerts.repeatedFailuresCount = repeatedFailuresCount;
        alerts.repeatedFailuresTop = repeatedFailures.slice(0, 10);
        alerts.repeatedFailures = repeatedFailuresCount;

        const criticalUnassigned = await prisma.execution.findMany({
          where: {
            plantId,
            scheduledAt: { gte: from, lte: to, lt: today },
            status: { not: "COMPLETED" },
            technicianId: null,
            route: {
              is: {
                equipment: {
                  is: {
                    plantId,
                    criticality: { in: ["ALTA", "CRITICA", "CRÃTICA"] },
                  },
                },
              },
            },
          },
          select: {
            id: true,
            scheduledAt: true,
            status: true,
            route: {
              select: {
                name: true,
                equipment: { select: { id: true, name: true, code: true, location: true, criticality: true } },
              },
            },
          },
          orderBy: { scheduledAt: "asc" },
        });

        const criticalUnassignedCount = Array.isArray(criticalUnassigned) ? criticalUnassigned.length : 0;

        alerts.criticalUnassignedCount = criticalUnassignedCount;
        alerts.criticalUnassignedTop = (criticalUnassigned || []).slice(0, 10).map((ex) => ({
          executionId: ex.id,
          scheduledAt: ex.scheduledAt,
          status: ex.status,
          routeName: ex?.route?.name || "â€”",
          equipment: {
            id: ex?.route?.equipment?.id ?? null,
            name: ex?.route?.equipment?.name || "â€”",
            code: ex?.route?.equipment?.code || "",
            location: ex?.route?.equipment?.location || "",
            criticality: ex?.route?.equipment?.criticality || "â€”",
          },
        }));

        const metrics = await getPredictiveMetrics({
          prisma,
          toStartOfDaySafe,
          plantId,
          month: ym,
          histDays: 90,
          shortWindowDays: 14,
          now,
        });

        alerts.lubricantDaysToEmptyTop = metrics?.lubricantDaysToEmptyTop || [];
        alerts.equipmentConsumptionAnomaliesTop = metrics?.equipmentConsumptionAnomaliesTop || [];
        alerts.lubricantDaysToEmptyCount = Number(metrics?.lubricantDaysToEmptyCount || 0);
        alerts.equipmentConsumptionAnomaliesCount = Number(
          metrics?.equipmentConsumptionAnomaliesCount || 0
        );
        alerts.consumptionSignalsCount =
          Number(alerts.lubricantDaysToEmptyCount || 0) +
          Number(alerts.equipmentConsumptionAnomaliesCount || 0);

        const historyRange = metrics?.ranges?.historyRange;

        const total =
          Number(alerts?.riskPendingCount || 0) +
          Number(alerts?.repeatedFailuresCount || 0) +
          Number(alerts?.criticalUnassignedCount || 0) +
          Number(alerts?.lubricantDaysToEmptyCount || 0) +
          Number(alerts?.equipmentConsumptionAnomaliesCount || 0);

        return res.json({
          ok: true,
          updatedAt: new Date().toISOString(),
          role,
          plantId,
          month: ym,
          range: { from: from.toISOString(), to: to.toISOString() },
          historyRange,
          alerts,
          total,
        });
      } catch (e) {
        console.error("Error dashboard predictive alerts:", e);
        return res.status(500).json({ error: "Error dashboard predictive alerts" });
      }
    }
  );

  // GET /api/dashboard/admin/counts
  router.get("/admin/counts", auth, requireRole(["ADMIN"]), async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) {
        return res.status(400).json({ error: "PLANT_REQUIRED" });
      }

      const [routesCount, equipmentsCount] = await Promise.all([
        prisma.route.count({ where: { plantId } }),
        prisma.equipment.count({ where: { plantId } }),
      ]);

      return res.json({
        ok: true,
        updatedAt: new Date().toISOString(),
        plantId,
        routesCount,
        equipmentsCount,
      });
    } catch (e) {
      console.error("dashboard admin counts error:", e);
      return res.status(500).json({ error: "Error dashboard admin counts" });
    }
  });

  // GET /api/dashboard/activities/monthly
  router.get("/activities/monthly", auth, requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
    try {
      const role = String(req.user?.role || "").toUpperCase();
      const plantId = req.currentPlantId;

      if (!plantId) {
        return res.status(400).json({ error: "PLANT_REQUIRED" });
      }

      const { monthOk, from, to, ym } = parseMonthRange(req.query.month);
      const today = toStartOfDaySafe(new Date());

      const executions = await prisma.execution.findMany({
        where: {
          plantId,
          scheduledAt: { gte: from, lte: to },
        },
        select: { status: true, scheduledAt: true, executedAt: true },
      });

      let completed = 0;
      let overdue = 0;
      let pending = 0;

      for (const e of executions) {
        const sched = toStartOfDaySafe(e.scheduledAt);
        if (e.status === "COMPLETED" && e.executedAt) completed++;
        else if (sched.getTime() < today.getTime()) overdue++;
        else pending++;
      }

      const total = completed + overdue + pending;

      return res.json({
        ok: true,
        role,
        plantId,
        month: monthOk ? ym : null,
        range: { from: from.toISOString(), to: to.toISOString() },
        data: {
          total,
          completed,
          overdue,
          pending,
          completedPct: total ? Number(((completed / total) * 100).toFixed(1)) : 0,
          overduePct: total ? Number(((overdue / total) * 100).toFixed(1)) : 0,
        },
      });
    } catch (e) {
      console.error("Error monthly activities:", e);
      return res.status(500).json({ error: "Error monthly activities" });
    }
  });

  // GET /api/dashboard/technicians/efficiency-monthly
  router.get("/technicians/efficiency-monthly", auth, requireRole(["ADMIN", "SUPERVISOR"]), async (req, res) => {
    try {
      const role = String(req.user?.role || "").toUpperCase();
      const plantId = req.currentPlantId;

      if (!plantId) {
        return res.status(400).json({ error: "PLANT_REQUIRED" });
      }

      const { monthOk, from, to, ym } = parseMonthRange(req.query.month);
      const today = toStartOfDaySafe(new Date());

      const execs = await prisma.execution.findMany({
        where: {
          plantId,
          scheduledAt: { gte: from, lte: to },
          technicianId: { not: null },
        },
        select: {
          technicianId: true,
          status: true,
          scheduledAt: true,
          executedAt: true,
        },
      });

      const byTech = new Map();

      for (const e of execs || []) {
        const techId = e.technicianId;
        if (!techId) continue;

        if (!byTech.has(techId)) {
          byTech.set(techId, {
            totalProgramadas: 0,
            completadas: 0,
            aTiempo: 0,
            tarde: 0,
            vencidas: 0,
            pendientes: 0,
          });
        }

        const s = byTech.get(techId);
        s.totalProgramadas += 1;

        const schedDay = toStartOfDaySafe(e.scheduledAt);

        const isCompleted = e.status === "COMPLETED" && !!e.executedAt;
        if (isCompleted) {
          s.completadas += 1;

          const execDay = toStartOfDaySafe(e.executedAt);
          if (execDay.getTime() <= schedDay.getTime()) s.aTiempo += 1;
          else s.tarde += 1;
        } else {
          if (schedDay.getTime() < today.getTime()) s.vencidas += 1;
          else s.pendientes += 1;
        }
      }

      const techIds = Array.from(byTech.keys());

      if (techIds.length === 0) {
        return res.json({
          ok: true,
          role,
          plantId,
          month: monthOk ? ym : null,
          range: { from: from.toISOString(), to: to.toISOString() },
          formula: { onTime: 1.0, late: 0.6, overdue: 0.2 },
          items: [],
        });
      }

      const techs = await prisma.technician.findMany({
        where: {
          plantId,
          id: { in: techIds },
          deletedAt: null,
        },
        select: { id: true, name: true, code: true, status: true, specialty: true },
      });

      const techMap = new Map(techs.map((t) => [t.id, t]));

      const scorePct = (s) => {
        const total = Math.max(1, Number(s?.totalProgramadas || 0));
        const score =
          (Number(s?.aTiempo || 0) * 1.0 +
            Number(s?.tarde || 0) * 0.6 +
            Number(s?.vencidas || 0) * 0.2) / total;
        return Math.round(score * 100);
      };

      const items = techIds.map((id) => {
        const t = techMap.get(id) || {
          id,
          name: "â€”",
          code: "",
          status: "â€”",
          specialty: "",
        };

        const s = byTech.get(id) || {
          totalProgramadas: 0,
          completadas: 0,
          aTiempo: 0,
          tarde: 0,
          vencidas: 0,
          pendientes: 0,
        };

        return {
          technician: {
            id: t.id,
            name: t.name,
            code: t.code,
            status: t.status,
            specialty: t.specialty,
          },
          totalProgramadas: Number(s.totalProgramadas || 0),
          completadas: Number(s.completadas || 0),
          aTiempo: Number(s.aTiempo || 0),
          tarde: Number(s.tarde || 0),
          vencidas: Number(s.vencidas || 0),
          pendientes: Number(s.pendientes || 0),
          scorePct: scorePct(s),
        };
      });

      items.sort((a, b) => b.scorePct - a.scorePct || b.completadas - a.completadas);

      return res.json({
        ok: true,
        role,
        plantId,
        month: monthOk ? ym : null,
        range: { from: from.toISOString(), to: to.toISOString() },
        formula: { onTime: 1.0, late: 0.6, overdue: 0.2 },
        items,
      });
    } catch (e) {
      console.error("dashboard technicians efficiency-monthly error:", e);
      return res.status(500).json({ error: "Error dashboard technicians efficiency-monthly" });
    }
  });

  return router;
}

