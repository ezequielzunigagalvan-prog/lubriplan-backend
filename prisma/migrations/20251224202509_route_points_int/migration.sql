/*
  Warnings:

  - The `points` column on the `Route` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "Route" ADD COLUMN     "lastDate" TIMESTAMP(3),
ADD COLUMN     "nextDate" TIMESTAMP(3),
DROP COLUMN "points",
ADD COLUMN     "points" INTEGER,
ALTER COLUMN "unit" SET DEFAULT 'ml';
