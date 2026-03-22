-- DropIndex
DROP INDEX "Execution_routeId_scheduledAt_status_key";

-- CreateTable
CREATE TABLE "Lubricant" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "brand" TEXT,
    "type" TEXT,
    "viscosity" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'ml',
    "stock" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "minStock" DOUBLE PRECISION,
    "location" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lubricant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Execution_status_scheduledAt_idx" ON "Execution"("status", "scheduledAt");
