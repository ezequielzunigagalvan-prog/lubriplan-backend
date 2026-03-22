/*
  Warnings:

  - A unique constraint covering the columns `[code]` on the table `Lubricant` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Lubricant" ADD COLUMN     "code" TEXT,
ADD COLUMN     "supplier" TEXT,
ADD COLUMN     "unitCost" DOUBLE PRECISION,
ALTER COLUMN "unit" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Lubricant_code_key" ON "Lubricant"("code");
