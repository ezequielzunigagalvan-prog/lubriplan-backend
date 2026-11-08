import prisma from "../src/prisma.js";

async function main() {
  const args = process.argv.slice(2);
  const plantId = parseInt(args[0]);
  const plan = args[1] || null;

  if (!Number.isFinite(plantId) || plantId <= 0) {
    console.error("Usage: node scripts/enableMaintenance.js <plantId> [plan]");
    console.error("Example: node scripts/enableMaintenance.js 1 basic");
    process.exit(1);
  }

  const plant = await prisma.plant.findUnique({
    where: { id: plantId },
    select: { id: true, name: true },
  });

  if (!plant) {
    console.error(`Plant with ID ${plantId} not found`);
    process.exit(1);
  }

  const result = await prisma.mtPlantAccess.upsert({
    where: { plantId },
    create: {
      plantId,
      enabled: true,
      plan,
      enabledAt: new Date(),
    },
    update: {
      enabled: true,
      plan,
      enabledAt: new Date(),
    },
  });

  console.log(`✅ Maintenance module enabled for plant "${plant.name}" (ID: ${plantId})`);
  if (plan) console.log(`   Plan: ${plan}`);
  console.log(`   Enabled at: ${result.enabledAt}`);
}

main()
  .catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
