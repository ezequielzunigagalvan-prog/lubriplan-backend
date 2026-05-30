// src/schemas/index.js
// Schemas Zod centralizados para validación de endpoints
import { z } from "zod";

// ── Primitivos reutilizables ─────────────────────────────────────────────────
const id        = z.number({ coerce: true }).int().positive();
const plantId   = id;
const email     = z.string().trim().toLowerCase().email("Email inválido");
const password  = z
  .string()
  .min(8, "La contraseña debe tener al menos 8 caracteres")
  .max(128, "Contraseña demasiado larga");
const dateStr   = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida (YYYY-MM-DD)");
const monthStr  = z.string().regex(/^\d{4}-\d{2}$/, "Mes inválido (YYYY-MM)");

// ── Auth ─────────────────────────────────────────────────────────────────────
export const loginSchema = z.object({
  email,
  password: z.string().min(1, "Password requerido"),
});

export const setPasswordSchema = z.object({
  email,
  password,
});

// ── Usuarios ─────────────────────────────────────────────────────────────────
export const createUserSchema = z.object({
  name:     z.string().trim().min(2).max(100),
  email,
  password,
  role:     z.enum(["ADMIN", "SUPERVISOR", "TECHNICIAN"]),
});

export const updateUserSchema = z.object({
  name:     z.string().trim().min(2).max(100).optional(),
  role:     z.enum(["ADMIN", "SUPERVISOR", "TECHNICIAN"]).optional(),
  active:   z.boolean().optional(),
});

// ── Reportes de condición ────────────────────────────────────────────────────
export const createConditionReportSchema = z.object({
  equipmentId:  id,
  condition:    z.enum(["BUENO", "REGULAR", "MALO", "CRITICO"]),
  category:     z.string().trim().min(1).max(100).optional(),
  description:  z.string().trim().max(2000).optional(),
  detectedAt:   z.string().optional(),
  evidenceImage: z.string().url().optional().or(z.literal("")),
});

// ── Muestras de aceite ───────────────────────────────────────────────────────
export const createOilSampleSchema = z.object({
  equipmentId:   id,
  sampledAt:     z.string().datetime({ offset: true }).or(dateStr).optional(),
  labReference:  z.string().trim().max(100).optional(),
  viscosity40:   z.number().optional(),
  viscosity100:  z.number().optional(),
  acidNumber:    z.number().optional(),
  waterContent:  z.number().min(0).max(100).optional(),
  flashPoint:    z.number().optional(),
  notes:         z.string().trim().max(2000).optional(),
});

// ── Órdenes de compra ────────────────────────────────────────────────────────
export const createPurchaseOrderSchema = z.object({
  title:       z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  items: z.array(z.object({
    lubricantId: id,
    quantity:    z.number().positive(),
    unit:        z.string().trim().max(20).optional(),
    unitPrice:   z.number().min(0).optional(),
  })).min(1, "La orden debe tener al menos un artículo"),
});

// ── Actividades de emergencia ────────────────────────────────────────────────
export const createEmergencyActivitySchema = z.object({
  equipmentId:  id,
  description:  z.string().trim().min(1).max(2000),
  priority:     z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  scheduledAt:  z.string().optional(),
});

// ── Lubricantes ───────────────────────────────────────────────────────────────
export const createLubricantSchema = z.object({
  name:        z.string().trim().min(1).max(200),
  code:        z.string().trim().max(50).optional(),
  brand:       z.string().trim().max(100).optional(),
  type:        z.string().trim().max(100).optional(),
  viscosity:   z.string().trim().max(50).optional(),
  unit:        z.string().trim().max(20).optional(),
  stock:       z.number().min(0).optional(),
  minStock:    z.number().min(0).optional(),
  cost:        z.number().min(0).optional(),
});

// ── Analytics / rangos de fecha ──────────────────────────────────────────────
export const dateRangeSchema = z.object({
  from: dateStr.optional(),
  to:   dateStr.optional(),
  month: monthStr.optional(),
});

export { id, email, password, dateStr, monthStr };
