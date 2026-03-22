import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // 1) Crear planta default
  const plant = await prisma.plant.create({
    data: { name: "Planta Demo", timezone: "America/Mexico_City", active: true },
  });

  // 2) Vincular a todos los usuarios a esa planta (default=true al primer usuario admin si quieres)
  const users = await prisma.user.findMany({ select: { id: true, role: true } });

  for (const u of users) {
    await prisma.userPlant.upsert({
      where: { userId_plantId: { userId: u.id, plantId: plant.id } },
      update: {},
      create: { userId: u.id, plantId: plant.id, isDefault: u.role === "ADMIN" },
    });
  }

  // 3) Backfill plantId en tablas con datos existentes
  await prisma.equipmentArea.updateMany({ data: { plantId: plant.id } });
  await prisma.equipment.updateMany({ data: { plantId: plant.id } });
  await prisma.lubricant.updateMany({ data: { plantId: plant.id } });
  await prisma.route.updateMany({ data: { plantId: plant.id } });
  await prisma.execution.updateMany({ data: { plantId: plant.id } });
  await prisma.conditionReport.updateMany({ data: { plantId: plant.id } });

  console.log("✅ Backfill listo. PlantId =", plant.id);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });