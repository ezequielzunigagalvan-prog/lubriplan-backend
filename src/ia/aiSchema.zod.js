// src/ia/aiSchema.zod.js
import { z } from "zod";

// Mantén esto chico al inicio. Luego crecemos.
export const AISummarySchema = z.object({
  title: z.string().min(3).max(120),
  period: z.string().regex(/^\d{4}-\d{2}$/), // YYYY-MM
  plantId: z.string().min(1),

  highlights: z.array(z.string().min(3)).max(8),
  risks: z.array(
    z.object({
      level: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
      message: z.string().min(3),
      action: z.string().min(3),
    })
  ).max(8),

  kpis: z.object({
    completed: z.number().int().min(0),
    pending: z.number().int().min(0),
    overdue: z.number().int().min(0),
    conditionOpen: z.number().int().min(0),
    conditionInProgress: z.number().int().min(0),
    lowStockCount: z.number().int().min(0).optional(),
    unassignedPending: z.number().int().min(0).optional(),
  }),

  recommendations: z.array(z.string().min(3)).max(8),

  // Para UI “bonita”: algo corto tipo 2-4 líneas
  executiveSummary: z.string().min(10).max(900),
});

export const AISummarySchemaVersioned = (schemaVersion) =>
  AISummarySchema.extend({
    schemaVersion: z.number().int().min(1).default(schemaVersion),
  });
