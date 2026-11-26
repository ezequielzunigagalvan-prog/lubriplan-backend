// src/services/equipmentMove.js
// Trasladar un equipo a otra planta (solo ADMIN).
//
// Qué se mueve con el equipo:
//  - Sus rutas (donde es el equipo principal y no comparte la ruta con otros equipos) con TODAS sus
//    actividades (pendientes e historial), sus actividades manuales/emergentes, reportes de condición,
//    muestras de aceite, órdenes preventivas, documentos, diagramas, carta de lubricación y QR.
// Qué se ajusta en la planta destino:
//  - Lubricante de la ruta/muestra → el de la planta destino con el mismo nombre (si no hay, queda el nombre como texto).
//  - Técnico de rutas y actividades pendientes → su perfil en la planta destino (misma cuenta o mismo código y nombre);
//    si no tiene, queda sin técnico para que el supervisor de esa planta lo asigne.
//  - Área → la del mismo nombre en la planta destino, o sin área.
// Qué se queda en la planta de origen:
//  - Rutas compartidas con otros equipos (el equipo sale de esas rutas).
//  - Pendientes del Plan de acción (se les quita la referencia al equipo).
//  - Movimientos de inventario ya registrados (son del inventario de esa planta).

const OPEN = ["PENDING", "OVERDUE"];
const norm = (s) => String(s || "").trim().toLowerCase();

export class MoveError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

async function loadContext(prisma, { equipmentId, fromPlantId, toPlantId }) {
  if (!Number.isInteger(toPlantId)) throw new MoveError("Elige la planta destino");
  if (toPlantId === fromPlantId) throw new MoveError("El equipo ya está en esa planta");
  const [equipment, target] = await Promise.all([
    prisma.equipment.findFirst({
      where: { id: equipmentId, plantId: fromPlantId },
      select: { id: true, name: true, code: true, plantId: true, area: { select: { name: true } } },
    }),
    prisma.plant.findFirst({ where: { id: toPlantId, active: true }, select: { id: true, name: true } }),
  ]);
  if (!equipment) throw new MoveError("Equipo no encontrado en la planta actual", 404);
  if (!target) throw new MoveError("La planta destino no existe o está inactiva", 404);

  const routes = await prisma.route.findMany({
    where: { plantId: fromPlantId, OR: [{ equipmentId }, { equipments: { some: { equipmentId } } }] },
    select: {
      id: true, name: true, equipmentId: true, lubricantId: true, lubricantName: true, technicianId: true,
      lubricant: { select: { name: true } },
      equipments: { select: { equipmentId: true, position: true }, orderBy: [{ position: "asc" }, { id: "asc" }] },
    },
  });
  const isShared = (r) => r.equipments.some((l) => l.equipmentId !== equipmentId);
  const movable = routes.filter((r) => r.equipmentId === equipmentId && !isShared(r));
  const shared = routes.filter((r) => isShared(r) || r.equipmentId !== equipmentId);

  const [targetLubricants, targetTechs, targetAreas] = await Promise.all([
    prisma.lubricant.findMany({ where: { plantId: toPlantId }, select: { id: true, name: true } }),
    prisma.technician.findMany({ where: { plantId: toPlantId, deletedAt: null }, select: { id: true, name: true, code: true, userId: true } }),
    prisma.equipmentArea.findMany({ where: { plantId: toPlantId }, select: { id: true, name: true } }).catch(() => []),
  ]);

  return { equipment, target, movable, shared, targetLubricants, targetTechs, targetAreas };
}

async function buildTechMap(prisma, techIds, targetTechs) {
  const ids = [...new Set(techIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const src = await prisma.technician.findMany({
    where: { id: { in: ids }, plantId: { gt: 0 } },
    select: { id: true, name: true, code: true, userId: true, user: { select: { id: true } } },
  });
  const map = new Map();
  for (const t of src) {
    const account = t.userId ?? t.user?.id ?? null;
    const hit =
      (account && targetTechs.find((x) => x.userId === account)) ||
      targetTechs.find((x) => norm(x.code) === norm(t.code) && norm(x.name) === norm(t.name)) ||
      null;
    map.set(t.id, { to: hit?.id ?? null, name: t.name, toName: hit?.name ?? null });
  }
  return map;
}

/** Vista previa: qué se mueve y qué hay que revisar. */
export async function previewMove(prisma, args) {
  const ctx = await loadContext(prisma, args);
  const { equipment, movable, shared, targetLubricants, targetTechs, targetAreas } = ctx;
  const routeIds = movable.map((r) => r.id);

  const [execRoute, execManual, openExecs, reports, samples, orders, docs, diagrams, actions] = await Promise.all([
    prisma.execution.count({ where: { plantId: args.fromPlantId, routeId: { in: routeIds.length ? routeIds : [-1] } } }),
    prisma.execution.count({ where: { plantId: args.fromPlantId, routeId: null, equipmentId: equipment.id } }),
    prisma.execution.findMany({
      where: { plantId: args.fromPlantId, status: { in: OPEN }, OR: [{ routeId: { in: routeIds.length ? routeIds : [-1] } }, { routeId: null, equipmentId: equipment.id }] },
      select: { technicianId: true },
    }),
    prisma.conditionReport.count({ where: { equipmentId: equipment.id, plantId: args.fromPlantId } }),
    prisma.oilSample.count({ where: { equipmentId: equipment.id, plantId: args.fromPlantId } }),
    prisma.preventiveOrder.count({ where: { equipmentId: equipment.id, plantId: args.fromPlantId } }),
    prisma.equipmentDocument.count({ where: { equipmentId: equipment.id } }),
    prisma.lubricationDiagram.count({ where: { equipmentId: equipment.id } }),
    prisma.actionItem.count({ where: { equipmentId: equipment.id } }),
  ]);

  const techMap = await buildTechMap(prisma, [...movable.map((r) => r.technicianId), ...openExecs.map((e) => e.technicianId)], targetTechs);
  const lubIssues = movable
    .filter((r) => r.lubricantId)
    .map((r) => {
      const name = r.lubricant?.name || r.lubricantName;
      const hit = targetLubricants.find((l) => norm(l.name) === norm(name));
      return { route: r.name, lubricant: name, found: Boolean(hit) };
    });
  const areaMatch = equipment.area?.name ? targetAreas.find((a) => norm(a.name) === norm(equipment.area.name)) : null;

  return {
    equipment: { id: equipment.id, name: equipment.name, code: equipment.code, area: equipment.area?.name || null },
    target: ctx.target,
    moves: {
      routes: movable.length,
      activities: execRoute + execManual,
      openActivities: openExecs.length,
      conditionReports: reports,
      oilSamples: samples,
      preventiveOrders: orders,
      documents: docs,
      diagrams,
    },
    stays: {
      sharedRoutes: shared.map((r) => ({ id: r.id, name: r.name })),
      actionItems: actions,
    },
    technicians: [...techMap.values()].map((t) => ({ from: t.name, to: t.toName })),
    lubricants: lubIssues,
    area: equipment.area?.name ? { from: equipment.area.name, to: areaMatch?.name || null } : null,
  };
}

/** Ejecuta el traslado en una sola transacción. */
export async function moveEquipment(prisma, args) {
  const ctx = await loadContext(prisma, args);
  const { equipment, movable, shared, targetLubricants, targetTechs, targetAreas } = ctx;
  const { fromPlantId, toPlantId } = args;
  const eqId = equipment.id;
  const routeIds = movable.map((r) => r.id);
  const inRoutes = { in: routeIds.length ? routeIds : [-1] };

  const openExecs = await prisma.execution.findMany({
    where: { plantId: fromPlantId, status: { in: OPEN }, OR: [{ routeId: inRoutes }, { routeId: null, equipmentId: eqId }] },
    select: { id: true, technicianId: true },
  });
  const techMap = await buildTechMap(prisma, [...movable.map((r) => r.technicianId), ...openExecs.map((e) => e.technicianId)], targetTechs);
  const lubFor = (name) => targetLubricants.find((l) => norm(l.name) === norm(name))?.id ?? null;
  const areaId = equipment.area?.name ? targetAreas.find((a) => norm(a.name) === norm(equipment.area.name))?.id ?? null : null;

  const sharedSummary = [];
  await prisma.$transaction(
    async (tx) => {
      // 1) Rutas compartidas: el equipo sale de ellas (se quedan en la planta de origen).
      for (const r of shared) {
        const rest = r.equipments.filter((l) => l.equipmentId !== eqId);
        await tx.routeEquipment.deleteMany({ where: { routeId: r.id, equipmentId: eqId } });
        if (r.equipmentId === eqId && rest.length) {
          await tx.route.update({ where: { id: r.id }, data: { equipmentId: rest[0].equipmentId } });
        }
        if (rest.length <= 1) await tx.routeEquipment.deleteMany({ where: { routeId: r.id } });
        await tx.execution.updateMany({ where: { routeId: r.id, evidenceEquipmentId: eqId, status: { in: OPEN } }, data: { evidenceEquipmentId: null } });
        await tx.execution.updateMany({ where: { routeId: r.id, equipmentId: eqId, status: { in: OPEN } }, data: { equipmentId: rest[0]?.equipmentId ?? null } });
        sharedSummary.push(r.name);
      }

      // 2) Rutas propias: a la planta destino, con lubricante y técnico de esa planta.
      for (const r of movable) {
        const lubName = r.lubricant?.name || r.lubricantName || null;
        const newLub = r.lubricantId ? lubFor(lubName) : null;
        await tx.route.update({
          where: { id: r.id },
          data: {
            plantId: toPlantId,
            lubricantId: newLub,
            lubricantName: r.lubricantId && !newLub ? lubName : r.lubricantName,
            technicianId: r.technicianId ? techMap.get(r.technicianId)?.to ?? null : null,
          },
        });
      }

      // 3) Actividades: todas las de sus rutas y las manuales del equipo.
      await tx.execution.updateMany({
        where: { plantId: fromPlantId, OR: [{ routeId: inRoutes }, { routeId: null, equipmentId: eqId }] },
        data: { plantId: toPlantId },
      });
      for (const e of openExecs) {
        if (!e.technicianId) continue;
        await tx.execution.update({ where: { id: e.id }, data: { technicianId: techMap.get(e.technicianId)?.to ?? null } });
      }

      // 4) Registros del equipo.
      await tx.conditionReport.updateMany({ where: { equipmentId: eqId, plantId: fromPlantId }, data: { plantId: toPlantId } });
      const samples = await tx.oilSample.findMany({ where: { equipmentId: eqId, plantId: fromPlantId }, select: { id: true, lubricant: { select: { name: true } } } });
      for (const s of samples) {
        await tx.oilSample.update({ where: { id: s.id }, data: { plantId: toPlantId, lubricantId: s.lubricant ? lubFor(s.lubricant.name) : null } });
      }
      const orders = await tx.preventiveOrder.findMany({ where: { equipmentId: eqId, plantId: fromPlantId }, select: { id: true, assignedTo: true } });
      if (orders.length) {
        const omap = await buildTechMap(tx, orders.map((o) => o.assignedTo), targetTechs);
        for (const o of orders) {
          await tx.preventiveOrder.update({ where: { id: o.id }, data: { plantId: toPlantId, assignedTo: o.assignedTo ? omap.get(o.assignedTo)?.to ?? null : null } });
        }
      }
      await tx.equipmentDocument.updateMany({ where: { equipmentId: eqId }, data: { plantId: toPlantId } });
      await tx.lubricationDiagram.updateMany({ where: { equipmentId: eqId }, data: { plantId: toPlantId } });
      await tx.actionItem.updateMany({ where: { equipmentId: eqId }, data: { equipmentId: null } });
      await tx.assetMapping.updateMany({ where: { equipmentId: eqId }, data: { equipmentId: null } }).catch(() => null);

      // 5) El equipo.
      await tx.equipment.update({ where: { id: eqId }, data: { plantId: toPlantId, areaId } });
    },
    { timeout: 30000 }
  );

  return {
    equipment: { id: eqId, name: equipment.name, code: equipment.code },
    target: ctx.target,
    movedRoutes: movable.length,
    movedOpenActivities: openExecs.length,
    sharedRoutesLeft: sharedSummary,
    unassignedTechnicians: [...techMap.values()].filter((t) => !t.to).map((t) => t.name),
  };
}
