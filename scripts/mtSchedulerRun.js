import prisma from "../src/prisma.js";
import { logger } from "../src/config/logger.js";
import { generateForPlan } from "../src/modules/maintenance/scheduler/generator.js";

async function main() {
  const args = process.argv.slice(2);
  let plantId = null;
  let planId = null;
  let dryRun = false;
  let nowStr = null;

  for (const arg of args) {
    if (arg.startsWith("--plant=")) {
      plantId = parseInt(arg.split("=")[1]);
    }
    if (arg.startsWith("--plan=")) {
      planId = parseInt(arg.split("=")[1]);
    }
    if (arg === "--dry-run") {
      dryRun = true;
    }
    if (arg.startsWith("--now=")) {
      nowStr = arg.split("=")[1];
    }
  }

  if (!plantId) {
    console.error("Usage: node scripts/mtSchedulerRun.js --plant=<id> [--plan=<id>] [--dry-run] [--now=<ISO>]");
    console.error("Example: node scripts/mtSchedulerRun.js --plant=1 --dry-run --now=2026-12-01T08:00:00Z");
    process.exit(1);
  }

  const isProd = process.env.NODE_ENV === "production";
  const now = nowStr && !isProd ? new Date(nowStr) : new Date();

  if (isProd && nowStr) {
    console.warn("⚠️  --now parameter ignored in production. Use only in development.");
  }

  console.log(`
🔧 Maintenance Scheduler Run
  Plant: ${plantId}
  Plan: ${planId || "all"}
  Dry Run: ${dryRun}
  Now: ${now.toISOString()}
  `);

  try {
    const plant = await prisma.plant.findUnique({
      where: { id: plantId },
      select: { id: true, name: true },
    });

    if (!plant) {
      console.error(`❌ Plant ${plantId} not found`);
      process.exit(1);
    }

    const access = await prisma.mtPlantAccess.findUnique({
      where: { plantId },
      select: { enabled: true },
    });

    if (!access?.enabled) {
      console.error(`❌ Maintenance not enabled for plant ${plant.name}`);
      process.exit(1);
    }

    const where = {
      plantId,
      active: true,
      deletedAt: null,
      ...(planId ? { id: planId } : {}),
    };

    const plans = await prisma.mtPlan.findMany({
      where,
      include: { tasks: true },
    });

    if (plans.length === 0) {
      console.warn(`⚠️  No active plans found for plant ${plant.name}`);
      process.exit(0);
    }

    console.log(`\n📋 Found ${plans.length} plan(s) to process:\n`);

    const results = [];
    for (const plan of plans) {
      try {
        const result = await generateForPlan(plan, { now, dryRun, trigger: "MANUAL" });
        results.push(result);

        const icon =
          result.decision === "GENERATED"
            ? "✅"
            : result.decision.startsWith("SKIPPED")
              ? "⊘"
              : "❌";

        console.log(
          `${icon} [${plan.code}] ${result.decision} (${result.cycleKey || "no cycle"})${
            result.workOrderId ? ` → WO #${result.workOrderId}` : ""
          }`
        );

        if (result.detail && Object.keys(result.detail).length > 0) {
          console.log(`   Details: ${JSON.stringify(result.detail)}`);
        }
      } catch (err) {
        console.error(`❌ [${plan.code}] ERROR: ${err.message}`);
        results.push({
          planId: plan.id,
          decision: "ERROR",
          detail: { error: err.message },
        });
      }
    }

    console.log(`\n📊 Summary:`);
    console.log(`  Total: ${results.length}`);
    console.log(`  Generated: ${results.filter((r) => r.decision === "GENERATED").length}`);
    console.log(`  Skipped: ${results.filter((r) => r.decision.startsWith("SKIPPED")).length}`);
    console.log(`  Errors: ${results.filter((r) => r.decision === "ERROR").length}`);

    if (dryRun) {
      console.log(
        `\n⚠️  DRY RUN MODE — No changes committed to database`
      );
    } else {
      console.log(`\n✨ Changes committed to database`);
    }
  } catch (err) {
    logger.error("[mtSchedulerRun]", err);
    console.error(`\n❌ Error: ${err.message}`);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
