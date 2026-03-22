import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash("Admin1234", 10);

  const user = await prisma.user.upsert({
    where: { email: "admin@lubriplan.com" },
    update: {
      passwordHash,
      name: "Administrador",
      role: "ADMIN",
      active: true,
    },
    create: {
      email: "admin@lubriplan.com",
      passwordHash,
      name: "Administrador",
      role: "ADMIN",
      active: true,
    },
  });

  console.log("✅ Usuario listo:", user.email);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });