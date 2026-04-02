// src/dashboard/predictiveMetrics.js

export async function getPredictiveMetrics({
  prisma,
  toStartOfDaySafe,
  plantId,
  month = "",
  histDays = 90,
  shortWindowDays = 14,
  now = new Date(),
} = {}) {
  if (!prisma) throw new Error("getPredictiveMetrics: prisma requerido");
  if (typeof toStartOfDaySafe !== "function") {
    throw new Error("getPredictiveMetrics: toStartOfDaySafe requerido");
  }
  if (!plantId) {
    throw new Error("getPredictiveMetrics: plantId requerido");
  }

  const today = toStartOfDaySafe(new Date());

  const histFrom = new Date(today);
  histFrom.setDate(histFrom.getDate() - Number(histDays || 90));

  const lastNFrom = new Date(today);
  lastNFrom.setDate(lastNFrom.getDate() - Number(shortWindowDays || 14));

  const whereOutMoves = {
    type: "OUT",
    createdAt: { gte: histFrom, lte: now },
    executionId: { not: null },
    execution: {
      is: {
        plantId: Number(plantId),
        route: { isNot: null },
      },
    },
  };

  const outMoves = await prisma.lubricantMovement.findMany({
    where: whereOutMoves,
    select: {
      quantity: true,
      createdAt: true,
      lubricantId: true,
      execution: {
        select: {
          route: {
            select: {
              equipmentId: true,
            },
          },
        },
      },
    },
  });

  const byLub = new Map();
  const byEq = new Map();

  for (const mv of outMoves || []) {
    const qty = Number(mv.quantity || 0) || 0;
    if (qty <= 0) continue;

    const lubId = mv.lubricantId;
    const eqId = mv?.execution?.route?.equipmentId;
    if (eqId == null) continue;

    if (!byLub.has(lubId)) byLub.set(lubId, 0);
    byLub.set(lubId, byLub.get(lubId) + qty);

    const day = toStartOfDaySafe(new Date(mv.createdAt));
    const y = day.getFullYear();
    const m = String(day.getMonth() + 1).padStart(2, "0");
    const d = String(day.getDate()).padStart(2, "0");
    const dayKey = `${y}-${m}-${d}`;

    if (!byEq.has(eqId)) {
      byEq.set(eqId, {
        totalOut: 0,
        moveCount: 0,
        recentTotal: 0,
        recentMoveCount: 0,
        byDay: new Map(),
      });
    }
    const s = byEq.get(eqId);
    s.totalOut += qty;
    s.moveCount += 1;
    s.byDay.set(dayKey, (s.byDay.get(dayKey) || 0) + qty);
    if (day.getTime() >= lastNFrom.getTime()) {
      s.recentTotal += qty;
      s.recentMoveCount += 1;
    }
  }

  const lubIds = [...byLub.keys()];

  const lubs = lubIds.length
    ? await prisma.lubricant.findMany({
        where: {
          plantId: Number(plantId),
          id: { in: lubIds },
        },
        select: {
          id: true,
          name: true,
          stock: true,
          unit: true,
          minStock: true,
        },
      })
    : [];

  const lubMeta = new Map(lubs.map((l) => [l.id, l]));

  const lubricantDaysToEmpty = lubIds
    .map((id) => {
      const meta = lubMeta.get(id);
      const totalOut = byLub.get(id) || 0;

      const avgDailyOut = totalOut / Number(histDays || 90);
      const stock = Number(meta?.stock || 0) || 0;
      const dte = avgDailyOut > 0 ? stock / avgDailyOut : null;

      const minStock = meta?.minStock != null ? Number(meta.minStock) : null;
      const underMin = minStock != null ? stock <= minStock : false;

      let risk = "LOW";
      if (dte != null && dte <= 7) risk = "HIGH";
      else if (dte != null && dte <= 14) risk = "MED";
      else if (underMin) risk = "MED";

      return {
        type: "DAYS_TO_EMPTY",
        month,
        lubricantId: id,
        lubricantName: meta?.name || `Lubricant ${id}`,
        name: meta?.name || `Lubricant ${id}`,
        unit: meta?.unit || "ml",
        stock,
        minStock,
        underMin,
        avgDailyOut: Number.isFinite(avgDailyOut) ? Number(avgDailyOut.toFixed(2)) : 0,
        daysToEmpty: dte == null ? null : Number(dte.toFixed(1)),
        dte: dte == null ? null : Number(dte.toFixed(1)),
        risk,
      };
    })
    .sort((a, b) => (a.daysToEmpty ?? 1e9) - (b.daysToEmpty ?? 1e9));

  const lubricantDaysToEmptyAtRisk = lubricantDaysToEmpty.filter((x) => x.risk !== "LOW");
  const lubricantDaysToEmptyTop = lubricantDaysToEmptyAtRisk.slice(0, 10);

  const eqIds = [...byEq.keys()];

  const eqs = eqIds.length
    ? await prisma.equipment.findMany({
        where: {
          plantId: Number(plantId),
          id: { in: eqIds },
        },
        select: {
          id: true,
          name: true,
          code: true,
          location: true,
          area: { select: { name: true } },
          criticality: true,
        },
      })
    : [];

  const eqMeta = new Map(eqs.map((e) => [e.id, e]));

  const equipmentConsumptionAnomalies = eqIds
    .map((id) => {
      const s = byEq.get(id);
      const meta = eqMeta.get(id);

      const moveCount = Number(s?.moveCount || 0);
      const recentMoveCount = Number(s?.recentMoveCount || 0);
      const baselineAvgDaily = moveCount > 0 ? (s.totalOut || 0) / moveCount : 0;
      const lastNAvgDaily =
        recentMoveCount > 0 ? Number(s?.recentTotal || 0) / recentMoveCount : 0;
      const ratio = baselineAvgDaily > 0 ? lastNAvgDaily / baselineAvgDaily : null;
      const minSampleOk = moveCount >= 6 && recentMoveCount >= 2;

      let risk = "LOW";
      if (minSampleOk && ratio != null && ratio >= 1.8) risk = "HIGH";
      else if (minSampleOk && ratio != null && ratio >= 1.5) risk = "MED";

      const criticality = String(meta?.criticality || "").toUpperCase();
      const critBoost = ["CRITICA", "CRÃTICA", "ALTA"].includes(criticality);

      return {
        type: "CONSUMPTION_ANOMALY",
        month,
        equipmentId: id,
        equipmentName: meta?.name || `Equipment ${id}`,
        name: meta?.name || `Equipment ${id}`,
        code: meta?.code || "",
        area: meta?.area?.name || "â€”",
        location: meta?.location || "",
        criticality: meta?.criticality || null,
        movementCount: moveCount,
        recentMovementCount: recentMoveCount,
        baselineAvgDaily: Number.isFinite(baselineAvgDaily) ? Number(baselineAvgDaily.toFixed(2)) : 0,
        lastNAvgDaily: Number.isFinite(lastNAvgDaily) ? Number(lastNAvgDaily.toFixed(2)) : 0,
        last14AvgDaily: Number.isFinite(lastNAvgDaily) ? Number(lastNAvgDaily.toFixed(2)) : 0,
        ratio: ratio == null ? null : Number(ratio.toFixed(2)),
        risk: critBoost && risk !== "LOW" ? "HIGH" : risk,
      };
    })
    .filter((x) => x.risk !== "LOW")
    .sort((a, b) => {
      const score = (x) => (x.risk === "HIGH" ? 3 : x.risk === "MED" ? 2 : 1);
      const ds = score(b) - score(a);
      if (ds !== 0) return ds;
      return (b.ratio || 0) - (a.ratio || 0);
    });

  const equipmentConsumptionAnomaliesTop = equipmentConsumptionAnomalies.slice(0, 10);
  const lubricantDaysToEmptyCount = lubricantDaysToEmptyAtRisk.length;
  const equipmentConsumptionAnomaliesCount = equipmentConsumptionAnomalies.length;
  const consumptionSignalsCount = equipmentConsumptionAnomalies.length;

  return {
    lubricantDaysToEmptyTop,
    equipmentConsumptionAnomaliesTop,
    lubricantDaysToEmptyCount,
    equipmentConsumptionAnomaliesCount,
    consumptionSignalsCount,
    lubricantDaysToEmpty: lubricantDaysToEmptyAtRisk,
    equipmentConsumptionAnomalies,
    ranges: {
      historyRange: {
        from: histFrom.toISOString(),
        to: now.toISOString(),
      },
      shortRange: {
        from: lastNFrom.toISOString(),
        to: now.toISOString(),
      },
    },
  };
}

