import prisma from "../src/prisma.js";
import bcrypt from "bcryptjs";
import { logger } from "../src/config/logger.js";

const DEMO_PREFIX = "DEMO";
const DEMO_EMAIL_DOMAIN = "@demo.maintenance.local";
const DEMO_PASSWORD = "DemoPass123!";

async function validateEnvironment() {
  const dbUrl = process.env.DATABASE_URL || "";
  const dryRun = !process.argv.includes("--confirm-local");
  const plantId = process.argv
    .find((arg) => arg.startsWith("--plant="))
    ?.split("=")[1];

  if (!plantId) {
    console.error("❌ Missing required flag: --plant=<id>");
    console.error("Usage: node scripts/seedMaintenanceDemo.js --plant=1 [--confirm-local]");
    process.exit(1);
  }

  if (process.env.NODE_ENV === "production") {
    console.error("❌ Abortado: NODE_ENV is production. Seed only in development.");
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

async function seedMaintenanceDemo() {
  const { plantId, dryRun } = await validateEnvironment();

  console.log(`\n🌱 Seeding Maintenance Demo for Plant ${plantId}\n`);

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
      console.log(`[DRY RUN] Would create demo data for plant: ${plant.name}`);
      return;
    }

    console.log(`✓ Creating demo data for plant: ${plant.name}\n`);

    const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

    const demoUsers = [
      {
        email: `demo.admin${DEMO_EMAIL_DOMAIN}`,
        name: "Demo Admin",
        role: "ADMIN",
      },
      {
        email: `demo.tecnico${DEMO_EMAIL_DOMAIN}`,
        name: "Demo Technician",
        role: "TECHNICIAN",
      },
      {
        email: `demo.operador${DEMO_EMAIL_DOMAIN}`,
        name: "Demo Operator",
        role: "SUPERVISOR",
      },
    ];

    const users = [];
    for (const userData of demoUsers) {
      const user = await prisma.user.upsert({
        where: { email: userData.email },
        create: {
          email: userData.email,
          name: userData.name,
          role: userData.role,
          passwordHash,
          active: true,
        },
        update: { active: true },
      });
      users.push(user);

      await prisma.userPlant.upsert({
        where: { userId_plantId: { userId: user.id, plantId } },
        create: {
          userId: user.id,
          plantId,
          isDefault: userData.role === "ADMIN",
          active: true,
        },
        update: { active: true },
      });

      console.log(`  ✓ User: ${user.email} (${user.role})`);
    }

    await prisma.mtPlantAccess.upsert({
      where: { plantId },
      create: {
        plantId,
        enabled: true,
        plan: "demo",
      },
      update: { enabled: true },
    });
    console.log(`  ✓ Maintenance enabled for plant\n`);

    const hierarchy = await seedAssetHierarchy(plantId);
    console.log(`  ✓ ${hierarchy.total} assets created\n`);

    const woCount = await seedWorkOrders(plantId, users);
    console.log(`  ✓ ${woCount} work orders created\n`);

    await seedPhase2IfAvailable(plantId, hierarchy.equipmentIds);

    await prisma.mtPlantAccess.findUnique({ where: { plantId } });

    console.log(`\n✨ Seed complete!\n`);
    console.log(`📋 Demo Credentials:`);
    console.log(`   Plant ID: ${plantId}`);
    demoUsers.forEach((u) => {
      console.log(`   ${u.email} / ${DEMO_PASSWORD} (${u.role})`);
    });
    console.log(`\n🔗 URL: http://localhost:5173/maintenance`);
    console.log(`\n📝 To clean demo data: node scripts/cleanMaintenanceDemo.js --plant=${plantId} --confirm-local\n`);
  } catch (err) {
    logger.error("[seedMaintenanceDemo]", err);
    console.error(`\n❌ Error: ${err.message}\n`);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

async function seedAssetHierarchy(plantId) {
  const areas = [
    { code: `${DEMO_PREFIX}-AREA-1`, name: "Manufacturing Line A", level: "AREA" },
    { code: `${DEMO_PREFIX}-AREA-2`, name: "Manufacturing Line B", level: "AREA" },
  ];

  const lines = [
    { code: `${DEMO_PREFIX}-LINE-1`, name: "Assembly Line 1", parentCode: `${DEMO_PREFIX}-AREA-1` },
    { code: `${DEMO_PREFIX}-LINE-2`, name: "Packaging Line 1", parentCode: `${DEMO_PREFIX}-AREA-1` },
    { code: `${DEMO_PREFIX}-LINE-3`, name: "Testing Line 1", parentCode: `${DEMO_PREFIX}-AREA-2` },
  ];

  const equipments = [
    { code: `${DEMO_PREFIX}-PUMP-001`, name: "Hydraulic Pump", parentCode: `${DEMO_PREFIX}-LINE-1`, criticality: "A", status: "OPERATING" },
    { code: `${DEMO_PREFIX}-MOTOR-001`, name: "Drive Motor", parentCode: `${DEMO_PREFIX}-LINE-1`, criticality: "B", status: "OPERATING" },
    { code: `${DEMO_PREFIX}-PUMP-002`, name: "Circulation Pump", parentCode: `${DEMO_PREFIX}-LINE-2`, criticality: "B", status: "STOPPED" },
    { code: `${DEMO_PREFIX}-VALVE-001`, name: "Control Valve", parentCode: `${DEMO_PREFIX}-LINE-2`, criticality: "C", status: "OPERATING" },
    { code: `${DEMO_PREFIX}-MOTOR-002`, name: "Test Drive Motor", parentCode: `${DEMO_PREFIX}-LINE-3`, criticality: "A", status: "OPERATING" },
    { code: `${DEMO_PREFIX}-SENSOR-001`, name: "Pressure Sensor", parentCode: `${DEMO_PREFIX}-LINE-3`, criticality: "C", status: "OPERATING" },
    { code: `${DEMO_PREFIX}-BEARING-001`, name: "Main Bearing Assembly", parentCode: `${DEMO_PREFIX}-LINE-1`, criticality: "B", status: "OPERATING" },
    { code: `${DEMO_PREFIX}-GEARBOX-001`, name: "Reduction Gearbox", parentCode: `${DEMO_PREFIX}-LINE-2`, criticality: "A", status: "OPERATING" },
  ];

  const components = [
    { code: `${DEMO_PREFIX}-SEAL-001`, name: "Hydraulic Seal", parentCode: `${DEMO_PREFIX}-PUMP-001`, level: "COMPONENT" },
    { code: `${DEMO_PREFIX}-BEARING-002`, name: "Shaft Bearing", parentCode: `${DEMO_PREFIX}-PUMP-001`, level: "COMPONENT" },
    { code: `${DEMO_PREFIX}-BELT-001`, name: "Drive Belt", parentCode: `${DEMO_PREFIX}-MOTOR-001`, level: "COMPONENT" },
    { code: `${DEMO_PREFIX}-SEAL-002`, name: "Valve Seal", parentCode: `${DEMO_PREFIX}-VALVE-001`, level: "COMPONENT" },
    { code: `${DEMO_PREFIX}-OIL-FILTER-001`, name: "Oil Filter Element", parentCode: `${DEMO_PREFIX}-PUMP-002`, level: "COMPONENT" },
    { code: `${DEMO_PREFIX}-COIL-001`, name: "Motor Coil", parentCode: `${DEMO_PREFIX}-MOTOR-002`, level: "COMPONENT" },
  ];

  const map = {};
  let total = 0;
  const equipmentIds = [];

  for (const area of areas) {
    const asset = await prisma.mtAsset.upsert({
      where: { plantId_code: { plantId, code: area.code } },
      create: {
        plantId,
        code: area.code,
        name: area.name,
        level: area.level,
        status: "OPERATING",
      },
      update: {},
    });
    map[area.code] = asset.id;
    total++;
  }

  for (const line of lines) {
    const asset = await prisma.mtAsset.upsert({
      where: { plantId_code: { plantId, code: line.code } },
      create: {
        plantId,
        code: line.code,
        name: line.name,
        level: "LINE",
        parentId: map[line.parentCode],
        status: "OPERATING",
      },
      update: {},
    });
    map[line.code] = asset.id;
    total++;
  }

  for (const equip of equipments) {
    const asset = await prisma.mtAsset.upsert({
      where: { plantId_code: { plantId, code: equip.code } },
      create: {
        plantId,
        code: equip.code,
        name: equip.name,
        level: "EQUIPMENT",
        parentId: map[equip.parentCode],
        criticality: equip.criticality,
        status: equip.status,
      },
      update: {},
    });
    map[equip.code] = asset.id;
    equipmentIds.push(asset.id);
    total++;
  }

  for (const comp of components) {
    const asset = await prisma.mtAsset.upsert({
      where: { plantId_code: { plantId, code: comp.code } },
      create: {
        plantId,
        code: comp.code,
        name: comp.name,
        level: comp.level,
        parentId: map[comp.parentCode],
        status: "OPERATING",
      },
      update: {},
    });
    map[comp.code] = asset.id;
    total++;
  }

  return { total, equipmentIds };
}

async function seedWorkOrders(plantId, users) {
  const assets = await prisma.mtAsset.findMany({
    where: { plantId, level: "EQUIPMENT" },
    select: { id: true },
  });

  const baseDate = new Date();
  baseDate.setDate(baseDate.getDate() - 30);

  const statuses = [
    "REQUESTED",
    "REJECTED",
    "APPROVED",
    "ASSIGNED",
    "IN_PROGRESS",
    "WAITING_PARTS",
    "WAITING_PRODUCTION",
    "FINISHED",
    "VALIDATED",
    "CANCELLED",
  ];

  const priorities = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

  let count = 0;

  for (let i = 0; i < 18; i++) {
    const assetId = assets[i % assets.length].id;
    const status = statuses[i % statuses.length];
    const priority = priorities[i % priorities.length];
    const daysOffset = Math.floor(i / 2);
    const scheduledAt = new Date(baseDate);
    scheduledAt.setDate(scheduledAt.getDate() + daysOffset);

    const woNumber = (await prisma.mtCounter.upsert({
      where: { plantId_key: { plantId, key: "WO_NUMBER" } },
      create: { plantId, key: "WO_NUMBER", value: 1 },
      update: { value: { increment: 1 } },
    })).value;

    const wo = await prisma.mtWorkOrder.upsert({
      where: { plantId_number: { plantId, number: woNumber } },
      create: {
        plantId,
        number: woNumber,
        type: i % 3 === 0 ? "CORRECTIVE" : i % 3 === 1 ? "PREVENTIVE" : "INSPECTION",
        status,
        priority,
        assetId,
        title: `${DEMO_PREFIX} WO #${woNumber}`,
        description: `Demo work order for testing`,
        requestedBy: users[0].id,
        assignedTo: ["ASSIGNED", "IN_PROGRESS", "WAITING_PARTS", "WAITING_PRODUCTION", "FINISHED", "VALIDATED"].includes(status) ? users[1].id : null,
        scheduledAt,
        startedAt: ["IN_PROGRESS", "WAITING_PARTS", "WAITING_PRODUCTION", "FINISHED", "VALIDATED"].includes(status) ? new Date(scheduledAt.getTime() + 86400000) : null,
        finishedAt: ["FINISHED", "VALIDATED"].includes(status) ? new Date(scheduledAt.getTime() + 172800000) : null,
        validatedAt: status === "VALIDATED" ? new Date(scheduledAt.getTime() + 259200000) : null,
        validatedBy: status === "VALIDATED" ? users[0].id : null,
        diagnosis: ["FINISHED", "VALIDATED"].includes(status) ? "Issue identified during inspection" : null,
        workDone: ["FINISHED", "VALIDATED"].includes(status) ? "Replacement completed" : null,
      },
      update: {},
    });

    await prisma.mtWorkOrderEvent.create({
      data: {
        workOrderId: wo.id,
        plantId,
        toStatus: status,
        userId: users[0].id,
        comment: `Demo event for ${status}`,
      },
    });

    count++;
  }

  return count;
}

async function seedPhase2IfAvailable(plantId, equipmentIds) {
  try {
    const mtPlanExists = await prisma.$queryRaw`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'MtPlan'
      ) as exists`;

    if (!Array.isArray(mtPlanExists) || !mtPlanExists[0]?.exists) {
      return;
    }

    console.log(`  ℹ Phase 2 tables detected, skipping additional seed (use mtSchedulerRun for plans)`);
  } catch {
  }
}

seedMaintenanceDemo().catch((err) => {
  logger.error("[seedMaintenanceDemo]", err);
  process.exit(1);
});
