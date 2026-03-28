import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash("Admin1234", 10);

  const admin = await prisma.user.upsert({
    where: { email: "admin@lubriplan.com" },
    update: {
      name: "Administrador",
      passwordHash,
      role: "ADMIN",
      active: true,
    },
    create: {
      name: "Administrador",
      email: "admin@lubriplan.com",
      passwordHash,
      role: "ADMIN",
      active: true,
    },
  });

  const plant = await prisma.plant.upsert({
    where: { id: 1 },
    update: {
      name: "Hidrolub",
      active: true,
      timezone: "America/Mexico_City",
    },
    create: {
      id: 1,
      name: "Hidrolub",
      active: true,
      timezone: "America/Mexico_City",
    },
  });

  await prisma.userPlant.upsert({
    where: {
      userId_plantId: {
        userId: admin.id,
        plantId: plant.id,
      },
    },
    update: {
      active: true,
      isDefault: true,
    },
    create: {
      userId: admin.id,
      plantId: plant.id,
      active: true,
      isDefault: true,
    },
  });

  console.log("✅ Usuario listo:", admin.email);
  console.log("✅ Planta lista:", plant.name);
  console.log("✅ Relación usuario-planta lista");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });