/*
  Warnings:

  - You are about to drop the column `updatedAt` on the `Lubricant` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Lubricant" DROP COLUMN "updatedAt";

-- AlterTable
ALTER TABLE "Route" ADD COLUMN     "lubricantId" INTEGER;

-- AddForeignKey
ALTER TABLE "Route" ADD CONSTRAINT "Route_lubricantId_fkey" FOREIGN KEY ("lubricantId") REFERENCES "Lubricant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
