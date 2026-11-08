-- CreateEnum
CREATE TYPE "MtWorkOrderType" AS ENUM ('CORRECTIVE', 'PREVENTIVE', 'INSPECTION');

-- CreateEnum
CREATE TYPE "MtWorkOrderStatus" AS ENUM ('REQUESTED', 'REJECTED', 'APPROVED', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_PARTS', 'WAITING_PRODUCTION', 'FINISHED', 'VALIDATED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MtWorkOrderPriority" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "MtAssetLevel" AS ENUM ('AREA', 'LINE', 'EQUIPMENT', 'SUBASSEMBLY', 'COMPONENT');

-- CreateEnum
CREATE TYPE "MtAssetCriticality" AS ENUM ('A', 'B', 'C');

-- CreateEnum
CREATE TYPE "MtAssetStatus" AS ENUM ('OPERATING', 'STOPPED', 'OUT_OF_SERVICE');

-- CreateTable
CREATE TABLE "MtPlantAccess" (
    "id" SERIAL NOT NULL,
    "plantId" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "plan" TEXT,
    "enabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MtPlantAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MtCounter" (
    "id" SERIAL NOT NULL,
    "plantId" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MtCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MtAsset" (
    "id" SERIAL NOT NULL,
    "plantId" INTEGER NOT NULL,
    "parentId" INTEGER,
    "level" "MtAssetLevel" NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT,
    "manufacturer" TEXT,
    "model" TEXT,
    "serialNumber" TEXT,
    "installedAt" TIMESTAMP(3),
    "criticality" "MtAssetCriticality",
    "status" "MtAssetStatus" NOT NULL DEFAULT 'OPERATING',
    "notes" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MtAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MtWorkOrder" (
    "id" SERIAL NOT NULL,
    "plantId" INTEGER NOT NULL,
    "number" INTEGER NOT NULL,
    "type" "MtWorkOrderType" NOT NULL,
    "status" "MtWorkOrderStatus" NOT NULL DEFAULT 'REQUESTED',
    "priority" "MtWorkOrderPriority" NOT NULL DEFAULT 'MEDIUM',
    "assetId" INTEGER,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "requestedBy" INTEGER NOT NULL,
    "assignedTo" INTEGER,
    "scheduledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "validatedAt" TIMESTAMP(3),
    "validatedBy" INTEGER,
    "diagnosis" TEXT,
    "failureCause" TEXT,
    "workDone" TEXT,
    "downtimeMinutes" INTEGER,
    "version" INTEGER NOT NULL DEFAULT 0,
    "planId" INTEGER,
    "cycleKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MtWorkOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MtWorkOrderEvent" (
    "id" SERIAL NOT NULL,
    "workOrderId" INTEGER NOT NULL,
    "plantId" INTEGER NOT NULL,
    "fromStatus" "MtWorkOrderStatus",
    "toStatus" "MtWorkOrderStatus" NOT NULL,
    "userId" INTEGER NOT NULL,
    "comment" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MtWorkOrderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MtWorkOrderPhoto" (
    "id" SERIAL NOT NULL,
    "workOrderId" INTEGER NOT NULL,
    "plantId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "uploadedBy" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MtWorkOrderPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MtPlantAccess_plantId_key" ON "MtPlantAccess"("plantId");

-- CreateIndex
CREATE INDEX "MtPlantAccess_plantId_idx" ON "MtPlantAccess"("plantId");

-- CreateIndex
CREATE INDEX "MtCounter_plantId_idx" ON "MtCounter"("plantId");

-- CreateIndex
CREATE UNIQUE INDEX "MtCounter_plantId_key_key" ON "MtCounter"("plantId", "key");

-- CreateIndex
CREATE INDEX "MtAsset_plantId_idx" ON "MtAsset"("plantId");

-- CreateIndex
CREATE INDEX "MtAsset_parentId_idx" ON "MtAsset"("parentId");

-- CreateIndex
CREATE INDEX "MtAsset_level_idx" ON "MtAsset"("level");

-- CreateIndex
CREATE INDEX "MtAsset_deletedAt_idx" ON "MtAsset"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MtAsset_plantId_code_key" ON "MtAsset"("plantId", "code");

-- CreateIndex
CREATE INDEX "MtWorkOrder_plantId_idx" ON "MtWorkOrder"("plantId");

-- CreateIndex
CREATE INDEX "MtWorkOrder_status_idx" ON "MtWorkOrder"("status");

-- CreateIndex
CREATE INDEX "MtWorkOrder_assetId_idx" ON "MtWorkOrder"("assetId");

-- CreateIndex
CREATE INDEX "MtWorkOrder_assignedTo_idx" ON "MtWorkOrder"("assignedTo");

-- CreateIndex
CREATE INDEX "MtWorkOrder_createdAt_idx" ON "MtWorkOrder"("createdAt");

-- CreateIndex
CREATE INDEX "MtWorkOrder_plantId_status_idx" ON "MtWorkOrder"("plantId", "status");

-- CreateIndex
CREATE INDEX "MtWorkOrder_plantId_assetId_idx" ON "MtWorkOrder"("plantId", "assetId");

-- CreateIndex
CREATE INDEX "MtWorkOrder_plantId_assignedTo_idx" ON "MtWorkOrder"("plantId", "assignedTo");

-- CreateIndex
CREATE INDEX "MtWorkOrder_plantId_createdAt_idx" ON "MtWorkOrder"("plantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MtWorkOrder_plantId_number_key" ON "MtWorkOrder"("plantId", "number");

-- CreateIndex
CREATE INDEX "MtWorkOrderEvent_workOrderId_idx" ON "MtWorkOrderEvent"("workOrderId");

-- CreateIndex
CREATE INDEX "MtWorkOrderEvent_plantId_idx" ON "MtWorkOrderEvent"("plantId");

-- CreateIndex
CREATE INDEX "MtWorkOrderEvent_createdAt_idx" ON "MtWorkOrderEvent"("createdAt");

-- CreateIndex
CREATE INDEX "MtWorkOrderPhoto_workOrderId_idx" ON "MtWorkOrderPhoto"("workOrderId");

-- CreateIndex
CREATE INDEX "MtWorkOrderPhoto_plantId_idx" ON "MtWorkOrderPhoto"("plantId");

-- AddForeignKey
ALTER TABLE "MtAsset" ADD CONSTRAINT "MtAsset_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "MtAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MtWorkOrder" ADD CONSTRAINT "MtWorkOrder_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MtAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MtWorkOrderEvent" ADD CONSTRAINT "MtWorkOrderEvent_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "MtWorkOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MtWorkOrderPhoto" ADD CONSTRAINT "MtWorkOrderPhoto_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "MtWorkOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Partial unique index for cycleKey (only when cycleKey is NOT NULL)
CREATE UNIQUE INDEX "MtWorkOrder_plantId_planId_cycleKey_key" ON "MtWorkOrder"("plantId", "planId", "cycleKey") WHERE "cycleKey" IS NOT NULL;
