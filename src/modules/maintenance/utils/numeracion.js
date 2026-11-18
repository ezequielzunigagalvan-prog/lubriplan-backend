import prisma from "../../../prisma.js";

/** Incrementa y devuelve un contador por planta (atómico). */
async function nextCounter(plantId, key, client = prisma) {
  const updated = await client.mtCounter.upsert({
    where: { plantId_key: { plantId, key } },
    create: { plantId, key, value: 1 },
    update: { value: { increment: 1 } },
  });
  return updated.value;
}

/** Siguiente número de orden de trabajo de la planta. */
export async function getNextWorkOrderNumber(plantId, client = prisma) {
  return nextCounter(plantId, "WO_NUMBER", client);
}

export function formatWorkOrderNumber(number) {
  return `OT-${String(number).padStart(6, "0")}`;
}

/**
 * Siguiente código de plan (PM-00001, PM-00002…) con su propio contador,
 * para no consumir la numeración de las órdenes de trabajo.
 * Si el código ya existe (planes creados con la numeración anterior), avanza hasta uno libre.
 */
export async function getNextPlanCode(plantId, client = prisma) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const code = `PM-${String(await nextCounter(plantId, "PLAN_CODE", client)).padStart(5, "0")}`;
    const taken = await client.mtPlan.findFirst({ where: { plantId, code }, select: { id: true } });
    if (!taken) return code;
  }
  throw new Error("No se pudo generar un código de plan libre");
}
