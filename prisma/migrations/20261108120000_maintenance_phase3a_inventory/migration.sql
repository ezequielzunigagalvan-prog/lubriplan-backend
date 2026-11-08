-- CreateEnum MtStockMovementType
CREATE TYPE "MtStockMovementType" AS ENUM ('IN', 'OUT', 'ADJUST', 'TRANSFER');

-- CreateTable MtSparePart
CREATE TABLE "MtSparePart" (
    "id" SERIAL NOT NULL PRIMARY KEY,
    "plantId" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "brand" TEXT,
    "partNumber" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'piece',
    "minStock" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "maxStock" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "location" TEXT,
    "costPerUnit" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MtSparePart_plantId_fkey" FOREIGN KEY ("plantId") REFERENCES "Plant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex MtSparePart
CREATE UNIQUE INDEX "MtSparePart_plantId_code_key" ON "MtSparePart"("plantId", "code");
CREATE INDEX "MtSparePart_plantId_idx" ON "MtSparePart"("plantId");
CREATE INDEX "MtSparePart_status_idx" ON "MtSparePart"("status");

-- CreateTable MtWarehouse
CREATE TABLE "MtWarehouse" (
    "id" SERIAL NOT NULL PRIMARY KEY,
    "plantId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MtWarehouse_plantId_fkey" FOREIGN KEY ("plantId") REFERENCES "Plant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex MtWarehouse
CREATE UNIQUE INDEX "MtWarehouse_plantId_name_key" ON "MtWarehouse"("plantId", "name");
CREATE INDEX "MtWarehouse_plantId_idx" ON "MtWarehouse"("plantId");

-- CreateTable MtStock
CREATE TABLE "MtStock" (
    "id" SERIAL NOT NULL PRIMARY KEY,
    "warehouseId" INTEGER NOT NULL,
    "sparePartId" INTEGER NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "lastCost" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MtStock_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "MtWarehouse" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MtStock_sparePartId_fkey" FOREIGN KEY ("sparePartId") REFERENCES "MtSparePart" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex MtStock
CREATE UNIQUE INDEX "MtStock_warehouseId_sparePartId_key" ON "MtStock"("warehouseId", "sparePartId");
CREATE INDEX "MtStock_warehouseId_idx" ON "MtStock"("warehouseId");
CREATE INDEX "MtStock_sparePartId_idx" ON "MtStock"("sparePartId");

-- CreateTable MtStockMovement
CREATE TABLE "MtStockMovement" (
    "id" SERIAL NOT NULL PRIMARY KEY,
    "stockId" INTEGER NOT NULL,
    "type" "MtStockMovementType" NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,
    "reason" TEXT,
    "costPerUnit" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "referenceId" INTEGER,
    "referenceType" TEXT,
    "createdById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MtStockMovement_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "MtStock" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MtStockMovement_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex MtStockMovement
CREATE INDEX "MtStockMovement_stockId_idx" ON "MtStockMovement"("stockId");
CREATE INDEX "MtStockMovement_createdAt_idx" ON "MtStockMovement"("createdAt");
CREATE INDEX "MtStockMovement_referenceId_idx" ON "MtStockMovement"("referenceId");

-- CreateTable MtWorkOrderPart
CREATE TABLE "MtWorkOrderPart" (
    "id" SERIAL NOT NULL PRIMARY KEY,
    "workOrderId" INTEGER NOT NULL,
    "sparePartId" INTEGER NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,
    "costPerUnitAtTime" DECIMAL(65,30) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MtWorkOrderPart_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "MtWorkOrder" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MtWorkOrderPart_sparePartId_fkey" FOREIGN KEY ("sparePartId") REFERENCES "MtSparePart" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex MtWorkOrderPart
CREATE INDEX "MtWorkOrderPart_workOrderId_idx" ON "MtWorkOrderPart"("workOrderId");
CREATE INDEX "MtWorkOrderPart_sparePartId_idx" ON "MtWorkOrderPart"("sparePartId");

-- CreateTable MtSparePartAsset
CREATE TABLE "MtSparePartAsset" (
    "id" SERIAL NOT NULL PRIMARY KEY,
    "sparePartId" INTEGER NOT NULL,
    "assetId" INTEGER NOT NULL,

    CONSTRAINT "MtSparePartAsset_sparePartId_fkey" FOREIGN KEY ("sparePartId") REFERENCES "MtSparePart" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MtSparePartAsset_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MtAsset" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex MtSparePartAsset
CREATE UNIQUE INDEX "MtSparePartAsset_sparePartId_assetId_key" ON "MtSparePartAsset"("sparePartId", "assetId");
CREATE INDEX "MtSparePartAsset_assetId_idx" ON "MtSparePartAsset"("assetId");

-- CreateTable MtFailureCode
CREATE TABLE "MtFailureCode" (
    "id" SERIAL NOT NULL PRIMARY KEY,
    "plantId" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "parentId" INTEGER,
    "assetClass" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "isBaseCode" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MtFailureCode_plantId_fkey" FOREIGN KEY ("plantId") REFERENCES "Plant" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MtFailureCode_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "MtFailureCode" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex MtFailureCode
CREATE UNIQUE INDEX "MtFailureCode_plantId_code_key" ON "MtFailureCode"("plantId", "code");
CREATE INDEX "MtFailureCode_plantId_idx" ON "MtFailureCode"("plantId");
CREATE INDEX "MtFailureCode_category_idx" ON "MtFailureCode"("category");

-- CreateTable MtWorkOrderFailure
CREATE TABLE "MtWorkOrderFailure" (
    "id" SERIAL NOT NULL PRIMARY KEY,
    "workOrderId" INTEGER NOT NULL,
    "assetId" INTEGER NOT NULL,
    "failureModeId" INTEGER,
    "mechanismId" INTEGER,
    "rootCauseId" INTEGER,
    "productionEffect" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MtWorkOrderFailure_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "MtWorkOrder" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MtWorkOrderFailure_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MtAsset" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MtWorkOrderFailure_failureModeId_fkey" FOREIGN KEY ("failureModeId") REFERENCES "MtFailureCode" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "MtWorkOrderFailure_mechanismId_fkey" FOREIGN KEY ("mechanismId") REFERENCES "MtFailureCode" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "MtWorkOrderFailure_rootCauseId_fkey" FOREIGN KEY ("rootCauseId") REFERENCES "MtFailureCode" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex MtWorkOrderFailure
CREATE UNIQUE INDEX "MtWorkOrderFailure_workOrderId_key" ON "MtWorkOrderFailure"("workOrderId");

-- AddColumn to User for MtStockMovements relationship
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "stockMovementsBackref" INTEGER;

-- AddColumn to MtAsset for relationships
ALTER TABLE "MtAsset" ADD COLUMN IF NOT EXISTS "sparePartsRef" INTEGER;
ALTER TABLE "MtAsset" ADD COLUMN IF NOT EXISTS "failuresRef" INTEGER;

-- AddColumn to MtWorkOrder for relationships
ALTER TABLE "MtWorkOrder" ADD COLUMN IF NOT EXISTS "partsRef" INTEGER;
ALTER TABLE "MtWorkOrder" ADD COLUMN IF NOT EXISTS "failureRef" INTEGER;
