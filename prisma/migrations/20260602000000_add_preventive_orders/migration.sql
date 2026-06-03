-- AddSourceTypeToExecution
ALTER TABLE "Execution"
    ADD COLUMN IF NOT EXISTS "sourceType" TEXT DEFAULT 'ROUTE';

CREATE INDEX IF NOT EXISTS "Execution_sourceType_idx" ON "Execution"("sourceType");

-- CreatePreventiveOrderStatus
-- CreatePreventiveOrderItemStatus
-- Estos enums se crean implícitamente en PostgreSQL mediante los valores que se insertan

-- CreatePreventiveOrder table
CREATE TABLE IF NOT EXISTS "PreventiveOrder" (
    "id"            SERIAL           NOT NULL,
    "plantId"       INTEGER          NOT NULL,
    "equipmentId"   INTEGER          NOT NULL,
    "title"         TEXT             NOT NULL,
    "scheduledDate" TIMESTAMP(3)     NOT NULL,
    "status"        TEXT             NOT NULL DEFAULT 'DRAFT',
    "createdBy"     INTEGER          NOT NULL,
    "assignedTo"    INTEGER,
    "requiresPhoto" BOOLEAN          NOT NULL DEFAULT false,
    "notes"         TEXT,
    "signatureImage" TEXT,
    "completedAt"   TIMESTAMP(3),
    "createdAt"     TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3)     NOT NULL,

    CONSTRAINT "PreventiveOrder_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PreventiveOrder_plantId_idx" ON "PreventiveOrder"("plantId");
CREATE INDEX IF NOT EXISTS "PreventiveOrder_equipmentId_idx" ON "PreventiveOrder"("equipmentId");
CREATE INDEX IF NOT EXISTS "PreventiveOrder_status_idx" ON "PreventiveOrder"("status");
CREATE INDEX IF NOT EXISTS "PreventiveOrder_scheduledDate_idx" ON "PreventiveOrder"("scheduledDate");
CREATE INDEX IF NOT EXISTS "PreventiveOrder_createdAt_idx" ON "PreventiveOrder"("createdAt");
CREATE INDEX IF NOT EXISTS "PreventiveOrder_plantId_status_idx" ON "PreventiveOrder"("plantId", "status");

-- FK PreventiveOrder → Plant
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'PreventiveOrder_plantId_fkey'
      AND table_name = 'PreventiveOrder'
  ) THEN
    ALTER TABLE "PreventiveOrder"
      ADD CONSTRAINT "PreventiveOrder_plantId_fkey"
      FOREIGN KEY ("plantId") REFERENCES "Plant"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- FK PreventiveOrder → Equipment
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'PreventiveOrder_equipmentId_fkey'
      AND table_name = 'PreventiveOrder'
  ) THEN
    ALTER TABLE "PreventiveOrder"
      ADD CONSTRAINT "PreventiveOrder_equipmentId_fkey"
      FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- FK PreventiveOrder.createdBy → User
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'PreventiveOrder_createdBy_fkey'
      AND table_name = 'PreventiveOrder'
  ) THEN
    ALTER TABLE "PreventiveOrder"
      ADD CONSTRAINT "PreventiveOrder_createdBy_fkey"
      FOREIGN KEY ("createdBy") REFERENCES "User"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- FK PreventiveOrder.assignedTo → Technician
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'PreventiveOrder_assignedTo_fkey'
      AND table_name = 'PreventiveOrder'
  ) THEN
    ALTER TABLE "PreventiveOrder"
      ADD CONSTRAINT "PreventiveOrder_assignedTo_fkey"
      FOREIGN KEY ("assignedTo") REFERENCES "Technician"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- CreatePreventiveOrderItem table
CREATE TABLE IF NOT EXISTS "PreventiveOrderItem" (
    "id"                INTEGER      NOT NULL,
    "preventiveOrderId" INTEGER      NOT NULL,
    "routeId"           INTEGER      NOT NULL,
    "status"            TEXT         NOT NULL DEFAULT 'PENDING',
    "observations"      TEXT,
    "photoUrl"          TEXT,
    "completedAt"       TIMESTAMP(3),
    "completedBy"       INTEGER,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PreventiveOrderItem_pkey" PRIMARY KEY ("id")
);

CREATE SEQUENCE IF NOT EXISTS "PreventiveOrderItem_id_seq" AS INTEGER START WITH 1 INCREMENT BY 1;
ALTER TABLE "PreventiveOrderItem" ALTER COLUMN "id" SET DEFAULT nextval('"PreventiveOrderItem_id_seq"');

CREATE INDEX IF NOT EXISTS "PreventiveOrderItem_preventiveOrderId_idx" ON "PreventiveOrderItem"("preventiveOrderId");
CREATE INDEX IF NOT EXISTS "PreventiveOrderItem_routeId_idx" ON "PreventiveOrderItem"("routeId");
CREATE INDEX IF NOT EXISTS "PreventiveOrderItem_status_idx" ON "PreventiveOrderItem"("status");

-- Unique constraint: una ruta no puede aparecer dos veces en una orden
CREATE UNIQUE INDEX IF NOT EXISTS "PreventiveOrderItem_preventiveOrderId_routeId_key" ON "PreventiveOrderItem"("preventiveOrderId", "routeId");

-- FK PreventiveOrderItem → PreventiveOrder
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'PreventiveOrderItem_preventiveOrderId_fkey'
      AND table_name = 'PreventiveOrderItem'
  ) THEN
    ALTER TABLE "PreventiveOrderItem"
      ADD CONSTRAINT "PreventiveOrderItem_preventiveOrderId_fkey"
      FOREIGN KEY ("preventiveOrderId") REFERENCES "PreventiveOrder"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- FK PreventiveOrderItem → Route
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'PreventiveOrderItem_routeId_fkey'
      AND table_name = 'PreventiveOrderItem'
  ) THEN
    ALTER TABLE "PreventiveOrderItem"
      ADD CONSTRAINT "PreventiveOrderItem_routeId_fkey"
      FOREIGN KEY ("routeId") REFERENCES "Route"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- FK PreventiveOrderItem.completedBy → Technician
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'PreventiveOrderItem_completedBy_fkey'
      AND table_name = 'PreventiveOrderItem'
  ) THEN
    ALTER TABLE "PreventiveOrderItem"
      ADD CONSTRAINT "PreventiveOrderItem_completedBy_fkey"
      FOREIGN KEY ("completedBy") REFERENCES "Technician"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
