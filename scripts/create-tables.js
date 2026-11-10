import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function createTables() {
  try {
    console.log("📋 Creating MtAsset table...");

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "MtAsset" (
        id SERIAL PRIMARY KEY,
        plantid INTEGER NOT NULL,
        parentid INTEGER,
        level VARCHAR(50) NOT NULL,
        code VARCHAR(100) NOT NULL,
        name VARCHAR(255) NOT NULL,
        location VARCHAR(255),
        manufacturer VARCHAR(255),
        model VARCHAR(255),
        serialnumber VARCHAR(255),
        installedat TIMESTAMP,
        criticality VARCHAR(10),
        status VARCHAR(50) DEFAULT 'OPERATING',
        notes TEXT,
        deletedat TIMESTAMP,
        createdat TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updatedat TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(plantid, code)
      )
    `);

    console.log("✅ MtAsset table created/verified");

    console.log("📋 Creating indexes...");

    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS idx_mtasset_plantid ON "MtAsset"(plantid)`
    );
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS idx_mtasset_parentid ON "MtAsset"(parentid)`
    );
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS idx_mtasset_code ON "MtAsset"(code)`
    );
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS idx_mtasset_status ON "MtAsset"(status)`
    );

    console.log("✅ Indexes created");

    console.log("📋 Creating MtWorkOrder table...");

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "MtWorkOrder" (
        id SERIAL PRIMARY KEY,
        plantid INTEGER NOT NULL,
        assetid INTEGER,
        number VARCHAR(50) NOT NULL,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        type VARCHAR(50),
        status VARCHAR(50) DEFAULT 'OPEN',
        priority VARCHAR(20),
        assignedtoid INTEGER,
        createdat TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updatedat TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(plantid, number)
      )
    `);

    console.log("✅ MtWorkOrder table created/verified");

    console.log("📋 All tables created successfully! ✨");

  } catch (error) {
    console.error("❌ Error creating tables:", error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

createTables();
