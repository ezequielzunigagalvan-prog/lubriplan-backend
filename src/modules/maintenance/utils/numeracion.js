import prisma from "../../../prisma.js";

export async function getNextWorkOrderNumber(plantId) {
  const counterKey = "WO_NUMBER";

  const updated = await prisma.mtCounter.upsert(
    {
      where: {
        plantId_key: { plantId, key: counterKey },
      },
      create: {
        plantId,
        key: counterKey,
        value: 1,
      },
      update: {
        value: { increment: 1 },
      },
    }
  );

  return updated.value;
}

export function formatWorkOrderNumber(number) {
  return `OT-${String(number).padStart(6, "0")}`;
}
