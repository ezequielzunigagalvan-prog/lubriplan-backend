/*
  Warnings:

  - The `status` column on the `Execution` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `condition` column on the `Execution` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- DropForeignKey
ALTER TABLE "Execution" DROP CONSTRAINT "Execution_technicianId_fkey";

-- AlterTable
ALTER TABLE "Execution" ADD COLUMN     "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
DROP COLUMN "status",
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'PENDING',
ALTER COLUMN "executedAt" DROP NOT NULL,
ALTER COLUMN "executedAt" DROP DEFAULT,
ALTER COLUMN "technicianId" DROP NOT NULL,
DROP COLUMN "condition",
ADD COLUMN     "condition" TEXT;

-- AddForeignKey
ALTER TABLE "Execution" ADD CONSTRAINT "Execution_technicianId_fkey" FOREIGN KEY ("technicianId") REFERENCES "Technician"("id") ON DELETE SET NULL ON UPDATE CASCADE;
