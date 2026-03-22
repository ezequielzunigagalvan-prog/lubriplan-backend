/*
  Warnings:

  - A unique constraint covering the columns `[code]` on the table `Equipment` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE "Execution" DROP CONSTRAINT "Execution_routeId_fkey";

-- DropIndex
DROP INDEX "LubricantMovement_executionId_idx";

-- AlterTable
ALTER TABLE "Equipment" ADD COLUMN     "areaId" INTEGER,
ADD COLUMN     "code" TEXT,
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "criticality" TEXT;

-- CreateTable
CREATE TABLE "EquipmentArea" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EquipmentArea_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EquipmentArea_name_key" ON "EquipmentArea"("name");

-- CreateIndex
CREATE INDEX "EquipmentArea_name_idx" ON "EquipmentArea"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Equipment_code_key" ON "Equipment"("code");

-- CreateIndex
CREATE INDEX "Equipment_areaId_idx" ON "Equipment"("areaId");

-- CreateIndex
CREATE INDEX "Equipment_status_idx" ON "Equipment"("status");

-- CreateIndex
CREATE INDEX "Route_equipmentId_idx" ON "Route"("equipmentId");

-- CreateIndex
CREATE INDEX "Route_lubricantId_idx" ON "Route"("lubricantId");

-- AddForeignKey
ALTER TABLE "Equipment" ADD CONSTRAINT "Equipment_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "EquipmentArea"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LubricantMovement" ADD CONSTRAINT "LubricantMovement_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "Execution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "Route"("id") ON DELETE CASCADE ON UPDATE CASCADE;
