-- Migración: Agregar campos faltantes que están en schema.prisma pero no en la BD

-- ============================================
-- 1. AppSettings: Agregar requiresPhotoOLP
-- ============================================
-- Este campo fue agregado al schema en el commit e1f6712 pero la migración
-- 20260602000000_add_preventive_orders no lo incluye

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'AppSettings' AND column_name = 'requiresPhotoOLP'
  ) THEN
    ALTER TABLE "AppSettings"
      ADD COLUMN "requiresPhotoOLP" BOOLEAN NOT NULL DEFAULT false;

    CREATE INDEX IF NOT EXISTS "AppSettings_requiresPhotoOLP_idx"
      ON "AppSettings"("requiresPhotoOLP");
  END IF;
END $$;

-- ============================================
-- 2. Verificación: Asegurar que createdAt y updatedAt existen
-- ============================================
-- En caso de que falten estos campos

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'AppSettings' AND column_name = 'createdAt'
  ) THEN
    ALTER TABLE "AppSettings"
      ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'AppSettings' AND column_name = 'updatedAt'
  ) THEN
    ALTER TABLE "AppSettings"
      ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
  END IF;
END $$;

-- ============================================
-- 3. Verificación: PreventiveOrder y PreventiveOrderItem existen
-- ============================================
-- Si no existen, crearlas (por si la migración anterior falló completamente)

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

-- Crear secuencias si no existen
CREATE SEQUENCE IF NOT EXISTS "PreventiveOrder_id_seq" AS INTEGER START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS "PreventiveOrderItem_id_seq" AS INTEGER START WITH 1 INCREMENT BY 1;

ALTER TABLE "PreventiveOrder" ALTER COLUMN "id" SET DEFAULT nextval('"PreventiveOrder_id_seq"');
ALTER TABLE "PreventiveOrderItem" ALTER COLUMN "id" SET DEFAULT nextval('"PreventiveOrderItem_id_seq"');

-- Crear índices
CREATE INDEX IF NOT EXISTS "PreventiveOrder_plantId_idx" ON "PreventiveOrder"("plantId");
CREATE INDEX IF NOT EXISTS "PreventiveOrder_equipmentId_idx" ON "PreventiveOrder"("equipmentId");
CREATE INDEX IF NOT EXISTS "PreventiveOrder_status_idx" ON "PreventiveOrder"("status");
CREATE INDEX IF NOT EXISTS "PreventiveOrder_scheduledDate_idx" ON "PreventiveOrder"("scheduledDate");
CREATE INDEX IF NOT EXISTS "PreventiveOrder_createdAt_idx" ON "PreventiveOrder"("createdAt");
CREATE INDEX IF NOT EXISTS "PreventiveOrder_plantId_status_idx" ON "PreventiveOrder"("plantId", "status");

CREATE INDEX IF NOT EXISTS "PreventiveOrderItem_preventiveOrderId_idx" ON "PreventiveOrderItem"("preventiveOrderId");
CREATE INDEX IF NOT EXISTS "PreventiveOrderItem_routeId_idx" ON "PreventiveOrderItem"("routeId");
CREATE INDEX IF NOT EXISTS "PreventiveOrderItem_status_idx" ON "PreventiveOrderItem"("status");
CREATE UNIQUE INDEX IF NOT EXISTS "PreventiveOrderItem_preventiveOrderId_routeId_key" ON "PreventiveOrderItem"("preventiveOrderId", "routeId");

-- Crear foreign keys si no existen
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'PreventiveOrder_plantId_fkey'
  ) THEN
    ALTER TABLE "PreventiveOrder"
      ADD CONSTRAINT "PreventiveOrder_plantId_fkey"
      FOREIGN KEY ("plantId") REFERENCES "Plant"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'PreventiveOrder_equipmentId_fkey'
  ) THEN
    ALTER TABLE "PreventiveOrder"
      ADD CONSTRAINT "PreventiveOrder_equipmentId_fkey"
      FOREIGN KEY ("equipmentId") REFERENCES "Equipment"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'PreventiveOrder_createdBy_fkey'
  ) THEN
    ALTER TABLE "PreventiveOrder"
      ADD CONSTRAINT "PreventiveOrder_createdBy_fkey"
      FOREIGN KEY ("createdBy") REFERENCES "User"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'PreventiveOrder_assignedTo_fkey'
  ) THEN
    ALTER TABLE "PreventiveOrder"
      ADD CONSTRAINT "PreventiveOrder_assignedTo_fkey"
      FOREIGN KEY ("assignedTo") REFERENCES "Technician"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'PreventiveOrderItem_preventiveOrderId_fkey'
  ) THEN
    ALTER TABLE "PreventiveOrderItem"
      ADD CONSTRAINT "PreventiveOrderItem_preventiveOrderId_fkey"
      FOREIGN KEY ("preventiveOrderId") REFERENCES "PreventiveOrder"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'PreventiveOrderItem_routeId_fkey'
  ) THEN
    ALTER TABLE "PreventiveOrderItem"
      ADD CONSTRAINT "PreventiveOrderItem_routeId_fkey"
      FOREIGN KEY ("routeId") REFERENCES "Route"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'PreventiveOrderItem_completedBy_fkey'
  ) THEN
    ALTER TABLE "PreventiveOrderItem"
      ADD CONSTRAINT "PreventiveOrderItem_completedBy_fkey"
      FOREIGN KEY ("completedBy") REFERENCES "Technician"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ============================================
-- 4. Verificación: Execution.sourceType
-- ============================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Execution' AND column_name = 'sourceType'
  ) THEN
    ALTER TABLE "Execution"
      ADD COLUMN "sourceType" TEXT DEFAULT 'ROUTE';

    CREATE INDEX IF NOT EXISTS "Execution_sourceType_idx" ON "Execution"("sourceType");
  END IF;
END $$;
