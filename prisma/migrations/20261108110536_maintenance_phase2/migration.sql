-- CreateEnum
CREATE TYPE "MtTriggerType" AS ENUM ('TIME', 'METER');

-- CreateEnum
CREATE TYPE "MtScheduleMode" AS ENUM ('FIXED', 'FLOATING');

-- CreateEnum
CREATE TYPE "MtTaskKind" AS ENUM ('CHECK', 'MEASURE', 'TEXT');

-- CreateEnum
CREATE TYPE "MtTaskResult" AS ENUM ('OK', 'NOT_OK', 'NA');

-- AlterTable
ALTER TABLE "MtWorkOrder" ADD COLUMN "dueAt" TIMESTAMP(3),
ADD COLUMN "sourceWorkOrderId" INTEGER,
ADD COLUMN "rescheduleCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "MtPlan" (
    "id" SERIAL NOT NULL,
    "plantId" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "assetId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" "MtWorkOrderType" NOT NULL DEFAULT 'PREVENTIVE',
    "triggerType" "MtTriggerType" NOT NULL DEFAULT 'TIME',
    "frequencyUnit" TEXT,
    "frequencyEvery" INTEGER,
    "meterIntervalHours" DOUBLE PRECISION,
    "meterBaseline" DOUBLE PRECISION,
    "lastMeterTrigger" DOUBLE PRECISION,
    "scheduleMode" "MtScheduleMode" NOT NULL DEFAULT 'FIXED',
    "anchorDate" TIMESTAMP(3) NOT NULL,
    "leadDays" INTEGER NOT NULL DEFAULT 0,
    "graceDays" INTEGER NOT NULL DEFAULT 0,
    "priority" "MtWorkOrderPriority" NOT NULL DEFAULT 'MEDIUM',
    "defaultAssigneeId" INTEGER,
    "estimatedMinutes" INTEGER,
    "skipIfOpen" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "nextDueAt" TIMESTAMP(3),
    "lastGeneratedAt" TIMESTAMP(3),
    "lastCompletedAt" TIMESTAMP(3),
    "createdBy" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "MtPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MtPlanTask" (
    "id" SERIAL NOT NULL,
    "planId" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "kind" "MtTaskKind" NOT NULL,
    "unit" TEXT,
    "minValue" DOUBLE PRECISION,
    "maxValue" DOUBLE PRECISION,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "createsCorrectiveOnFail" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MtPlanTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MtWorkOrderTask" (
    "id" SERIAL NOT NULL,
    "workOrderId" INTEGER NOT NULL,
    "plantId" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "kind" "MtTaskKind" NOT NULL,
    "unit" TEXT,
    "minValue" DOUBLE PRECISION,
    "maxValue" DOUBLE PRECISION,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "createsCorrectiveOnFail" BOOLEAN NOT NULL DEFAULT false,
    "result" "MtTaskResult",
    "valueNumber" DOUBLE PRECISION,
    "valueText" TEXT,
    "note" TEXT,
    "doneBy" INTEGER,
    "doneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MtWorkOrderTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MtMeterReading" (
    "id" SERIAL NOT NULL,
    "plantId" INTEGER NOT NULL,
    "assetId" INTEGER NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "isReset" BOOLEAN NOT NULL DEFAULT false,
    "userId" INTEGER NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MtMeterReading_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MtPlanRun" (
    "id" SERIAL NOT NULL,
    "plantId" INTEGER NOT NULL,
    "planId" INTEGER NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trigger" TEXT NOT NULL,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "decision" TEXT NOT NULL,
    "cycleKey" TEXT,
    "dueAt" TIMESTAMP(3),
    "workOrderId" INTEGER,
    "missedCycles" INTEGER NOT NULL DEFAULT 0,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MtPlanRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MtPlan_plantId_idx" ON "MtPlan"("plantId");

-- CreateIndex
CREATE INDEX "MtPlan_assetId_idx" ON "MtPlan"("assetId");

-- CreateIndex
CREATE INDEX "MtPlan_active_idx" ON "MtPlan"("active");

-- CreateIndex
CREATE INDEX "MtPlan_nextDueAt_idx" ON "MtPlan"("nextDueAt");

-- CreateIndex
CREATE UNIQUE INDEX "MtPlan_plantId_code_key" ON "MtPlan"("plantId", "code");

-- CreateIndex
CREATE INDEX "MtPlanTask_planId_idx" ON "MtPlanTask"("planId");

-- CreateIndex
CREATE INDEX "MtWorkOrderTask_workOrderId_idx" ON "MtWorkOrderTask"("workOrderId");

-- CreateIndex
CREATE INDEX "MtWorkOrderTask_plantId_idx" ON "MtWorkOrderTask"("plantId");

-- CreateIndex
CREATE INDEX "MtMeterReading_assetId_readAt_idx" ON "MtMeterReading"("assetId", "readAt");

-- CreateIndex
CREATE INDEX "MtMeterReading_plantId_idx" ON "MtMeterReading"("plantId");

-- CreateIndex
CREATE INDEX "MtPlanRun_planId_runAt_idx" ON "MtPlanRun"("planId", "runAt");

-- CreateIndex
CREATE INDEX "MtPlanRun_plantId_idx" ON "MtPlanRun"("plantId");

-- AddForeignKey
ALTER TABLE "MtPlan" ADD CONSTRAINT "MtPlan_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MtAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MtPlanTask" ADD CONSTRAINT "MtPlanTask_planId_fkey" FOREIGN KEY ("planId") REFERENCES "MtPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MtWorkOrderTask" ADD CONSTRAINT "MtWorkOrderTask_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "MtWorkOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MtMeterReading" ADD CONSTRAINT "MtMeterReading_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MtAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MtPlanRun" ADD CONSTRAINT "MtPlanRun_planId_fkey" FOREIGN KEY ("planId") REFERENCES "MtPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Partial unique index for plan generation idempotency (cycleKey only non-null for plan-generated WO)
CREATE UNIQUE INDEX "MtWorkOrder_plantId_planId_cycleKey_key" ON "MtWorkOrder"("plantId", "planId", "cycleKey") WHERE "cycleKey" IS NOT NULL AND "planId" IS NOT NULL;
