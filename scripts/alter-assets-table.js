import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function alterTable() {
  try {
    console.log("🔧 Altering MtAsset table to add missing columns...");

    const columnsToAdd = [
      { name: "location", type: "VARCHAR(255)", check: true },
      { name: "manufacturer", type: "VARCHAR(255)", check: true },
      { name: "model", type: "VARCHAR(255)", check: true },
      { name: "serialnumber", type: "VARCHAR(255)", check: true },
      { name: "installedat", type: "TIMESTAMP", check: true },
      { name: "criticality", type: "VARCHAR(10)", check: true },
      { name: "notes", type: "TEXT", check: true },
      { name: "deletedat", type: "TIMESTAMP", check: true }
    ];

    for (const col of columnsToAdd) {
      if (col.check) {
        try {
          await prisma.$executeRawUnsafe(
            `ALTER TABLE "MtAsset" ADD COLUMN IF NOT EXISTS "${col.name}" ${col.type}`
          );
          console.log(`  ✅ Added column: ${col.name}`);
        } catch (err) {
          if (err.message?.includes("already exists")) {
            console.log(`  ℹ️  Column already exists: ${col.name}`);
          } else {
            console.error(`  ❌ Error adding ${col.name}:`, err.message);
          }
        }
      }
    }

    // Agregar índices
    console.log("📋 Creating indexes...");

    const indexes = [
      { name: "idx_mtasset_plantid", column: "plantid" },
      { name: "idx_mtasset_code", column: "code" },
      { name: "idx_mtasset_status", column: "status" },
      { name: "idx_mtasset_parentid", column: "parentid" }
    ];

    for (const idx of indexes) {
      try {
        await prisma.$executeRawUnsafe(
          `CREATE INDEX IF NOT EXISTS ${idx.name} ON "MtAsset"("${idx.column}")`
        );
        console.log(`  ✅ Index created: ${idx.name}`);
      } catch (err) {
        console.log(`  ℹ️  Index already exists: ${idx.name}`);
      }
    }

    console.log("\n✨ MtAsset table structure updated successfully!");

  } catch (error) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

alterTable();
