import prisma from "../src/prisma.js";
import { logger } from "../src/config/logger.js";

const DEMO_PREFIX = "DEMO";
const DEMO_EMAIL_DOMAIN = "@demo.maintenance.local";

async function validateEnvironment() {
  const dbUrl = process.env.DATABASE_URL || "";
  const dryRun = !process.argv.includes("--confirm-local");
  const plantId = process.argv
    .find((arg) => arg.startsWith("--plant="))
    ?.split("=")[1];

  if (!plantId) {
    console.error("❌ Missing required flag: --plant=<id>");
    console.error("Usage: node scripts/cleanMaintenanceDemo.js --plant=<id> [--confirm-local]");
    process.exit(1);
  }

  if (process.env.NODE_ENV === "production") {
    console.error("❌ Abortado: NODE_ENV is production. Cleanup only in development.");
    process.exit(1);
  }

  const isLocal =
    dbUrl.includes("localhost") ||
    dbUrl.includes("127.0.0.1") ||
    dbUrl.includes("host.docker.internal");

  if (!isLocal) {
    console.error(
      "❌ Abortado: DATABASE_URL no apunta a localhost. Esta base no es local."
    );
    process.exit(1);
  }

  if (dryRun) {
    console.log("🔍 DRY RUN MODE — No changes will be committed.");
  }

  return { plantId: parseInt(plantId), dryRun };
}

async function cleanMaintenanceDemo() {
  const { plantId, dryRun } = await validateEnvironment();

  console.log(`\n🧹 Cleaning Maintenance Demo for Plant ${plantId}\n`);

  try {
    const plant = await prisma.plant.findUnique({
      where: { id: plantId },
      select: { id: true, name: true },
    });

    if (!plant) {
      console.error(`❌ Plant ${plantId} not found.`);
      process.exit(1);
    }

    if (dryRun) {
      console.log(`[DRY RUN] Would delete demo data for plant: ${plant.name}\n`);
      await summarizeDemoData(plantId);
      return;
    }

    console.log(`✓ Deleting demo data for plant: ${plant.name}\n`);

    let counts = { users: 0, assets: 0, workOrders: 0, events: 0 };

    const demoWorkOrders = await prisma.mtWorkOrder.findMany({
      where: {
        plantId,
        title: { contains: DEMO_PREFIX },
      },
      select: { id: true },
    });

    if (demoWorkOrders.length > 0) {
      const woIds = demoWorkOrders.map((w) => w.id);

      await prisma.mtWorkOrderEvent.deleteMany({
        where: { workOrderId: { in: woIds }, plantId },
      });
      counts.events += demoWorkOrders.length;

      await prisma.mtWorkOrderPhoto.deleteMany({
        where: { workOrderId: { in: woIds }, plantId },
      });

      await prisma.mtWorkOrder.deleteMany({
        where: { id: { in: woIds }, plantId },
      });
      counts.workOrders += demoWorkOrders.length;
    }

    const demoAssets = await prisma.mtAsset.findMany({
      where: {
        plantId,
        code: { contains: DEMO_PREFIX },
      },
      select: { id: true },
    });

    if (demoAssets.length > 0) {
      const assetIds = demoAssets.map((a) => a.id);
      const childAssets = await prisma.mtAsset.findMany({
        where: { parentId: { in: assetIds } },
        select: { id: true },
      });

      if (childAssets.length > 0) {
        const childIds = childAssets.map((a) => a.id);
        await prisma.mtAsset.deleteMany({
          where: { parentId: { in: childIds } },
        });
      }

      await prisma.mtAsset.deleteMany({
        where: { parentId: { in: assetIds } },
      });

      await prisma.mtAsset.deleteMany({
        where: { id: { in: assetIds } },
      });
      counts.assets += demoAssets.length + childAssets.length;
    }

    const demoUsers = await prisma.user.findMany({
      where: { email: { contains: DEMO_EMAIL_DOMAIN } },
      select: { id: true, email: true },
    });

    for (const user of demoUsers) {
      await prisma.userPlant.deleteMany({
        where: { userId: user.id, plantId },
      });

      const userPlants = await prisma.userPlant.count({
        where: { userId: user.id },
      });

      if (userPlants === 0) {
        await prisma.user.delete({ where: { id: user.id } });
        counts.users++;
      }
    }

    console.log(`\n✨ Cleanup complete!\n`);
    console.log(`📊 Deleted:`);
    console.log(`  Users: ${counts.users}`);
    console.log(`  Assets: ${counts.assets}`);
    console.log(`  Work Orders: ${counts.workOrders}`);
    console.log(`  Events: ${counts.events}\n`);
  } catch (err) {
    logger.error("[cleanMaintenanceDemo]", err);
    console.error(`\n❌ Error: ${err.message}\n`);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

async function summarizeDemoData(plantId) {
  const [users, assets, workOrders, events] = await Promise.all([
    prisma.user.count({
      where: { email: { contains: DEMO_EMAIL_DOMAIN } },
    }),
    prisma.mtAsset.count({
      where: { plantId, code: { contains: DEMO_PREFIX } },
    }),
    prisma.mtWorkOrder.count({
      where: { plantId, title: { contains: DEMO_PREFIX } },
    }),
    prisma.mtWorkOrderEvent.count({
      where: {
        plantId,
        workOrder: { title: { contains: DEMO_PREFIX } },
      },
    }),
  ]);

  console.log(`📊 Demo Data Summary:`);
  console.log(`  Users: ${users}`);
  console.log(`  Assets: ${assets}`);
  console.log(`  Work Orders: ${workOrders}`);
  console.log(`  Events: ${events}\n`);
}

cleanMaintenanceDemo().catch((err) => {
  logger.error("[cleanMaintenanceDemo]", err);
  process.exit(1);
});
