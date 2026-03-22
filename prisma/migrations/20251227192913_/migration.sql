/*
  Warnings:

  - Added the required column `updatedAt` to the `Lubricant` table without a default value. This is not possible if the table is not empty.
  - Made the column `unit` on table `Lubricant` required. This step will fail if there are existing NULL values in that column.

*/
-- DropIndex
DROP INDEX "Lubricant_code_key";

-- AlterTable
ALTER TABLE "Lubricant" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "unit" SET NOT NULL;

-- CreateTable
CREATE TABLE "LubricantMovement" (
    "id" SERIAL NOT NULL,
    "lubricantId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "reason" TEXT,
    "note" TEXT,
    "stockBefore" DOUBLE PRECISION,
    "stockAfter" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LubricantMovement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LubricantMovement_lubricantId_createdAt_idx" ON "LubricantMovement"("lubricantId", "createdAt");

-- AddForeignKey
ALTER TABLE "LubricantMovement" ADD CONSTRAINT "LubricantMovement_lubricantId_fkey" FOREIGN KEY ("lubricantId") REFERENCES "Lubricant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
