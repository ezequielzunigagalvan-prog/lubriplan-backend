-- CreateEnum
CREATE TYPE "EquipmentCondition" AS ENUM ('BUENO', 'REGULAR', 'MALO', 'CRITICO');

-- AlterTable
ALTER TABLE "Execution" ADD COLUMN     "condition" "EquipmentCondition",
ADD COLUMN     "observations" TEXT,
ADD COLUMN     "usedQuantity" DOUBLE PRECISION;
