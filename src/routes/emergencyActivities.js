import express from "express";
import { notifyManagers, notifyTechnicianAssignee } from "../notifications/notify.js";
import { sseHub } from "../realtime/sseHub.js";
import { sendCriticalActivityEmail } from "../services/email/email.service.js";
import { normalizeImageInput } from "../lib/cloudinary.js";

export default function emergencyActivitiesRoutes({ prisma, auth }) {
  const router = express.Router();

  function normUnit(u) {
    return String(u || "").trim().toLowerCase();
  }

  function convertQtyToLubUnit(qty, fromUnit, lubricantUnit) {
    const q = Number(qty);
    if (!Number.isFinite(q)) return 0;

    const fromU = normUnit(fromUnit);
    const toU = normUnit(lubricantUnit);

    // liquidos: ml <-> L
    if (fromU === "l" && toU === "ml") return q * 1000;
    if (fromU === "ml" && toU === "l") return q / 1000;

    // grasas: g <-> kg
    if (fromU === "kg" && toU === "g") return q * 1000;
    if (fromU === "g" && toU === "kg") return q / 1000;

    return q;
  }

  /**
   * Crea una actividad emergente que impacta:
      * - Execution (COMPLETED)
   * - LubricantMovement (OUT)
   * - Lubricant.stock (descuento)
   */
  router.post(
  "/emergency-activities",
  auth,
  async (req, res) => {
      try {
        const plantId = req.currentPlantId;
        if (!plantId) {
          return res.status(400).json({ error: "PLANT_REQUIRED" });
        }

        const {
          equipmentId,
          technicianId,
          executedAt,
          emergencyReason,
          lubricantId,
          quantity,
          unit,
          condition,
          observations,
          evidenceImage,
          evidenceNote,
        } = req.body || {};

        // ===== Validaciones =====
        const eqId = Number(equipmentId);
        const techId =
          technicianId != null && technicianId !== ""
            ? Number(technicianId)
            : null;
        const lubId = Number(lubricantId);
        const qty = Number(quantity);

        if (!eqId) {
          return res.status(400).json({ error: "equipmentId requerido" });
        }
        if (!lubId) {
          return res.status(400).json({ error: "lubricantId requerido" });
        }
        if (!executedAt) {
          return res.status(400).json({ error: "executedAt requerido" });
        }
        if (!String(emergencyReason || "").trim()) {
          return res
            .status(400)
            .json({ error: "emergencyReason requerido" });
        }
        if (!Number.isFinite(qty) || qty <= 0) {
          return res.status(400).json({ error: "quantity inválida" });
        }

        const executedAtDT = new Date(
          `${String(executedAt).slice(0, 10)}T12:00:00`
        );
        if (Number.isNaN(executedAtDT.getTime())) {
          return res.status(400).json({ error: "executedAt inválido" });
        }

        const uploadedEvidence = await normalizeImageInput(evidenceImage, {
          folder: "lubriplan/execution-evidence",
          publicId: `emergency_${eqId}_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        });

        const result = await prisma.$transaction(async (tx) => {
          const equipment = await tx.equipment.findFirst({
            where: { id: eqId, plantId },
          });
          if (!equipment) {
            throw new Error("Equipo no encontrado en la planta actual");
          }

          const lubricant = await tx.lubricant.findFirst({
            where: { id: lubId, plantId },
          });
          if (!lubricant) {
            throw new Error("Lubricante no encontrado en la planta actual");
          }

          if (techId) {
            const technician = await tx.technician.findFirst({
              where: { id: techId, plantId, deletedAt: null },
            });
            if (!technician) {
              throw new Error("Técnico no encontrado en la planta actual");
            }
          }

          const lubUnit = String(lubricant.unit || "ml").trim();
          const inputUnit = String(unit || lubUnit).trim();
          const qtyNormalized = convertQtyToLubUnit(qty, inputUnit, lubUnit);

          if (!Number.isFinite(qtyNormalized) || qtyNormalized <= 0) {
            throw new Error("Cantidad inválida después de la conversión");
          }

          const manualTitle = `EMERGENTE · ${equipment.name || `Equipo ${eqId}`} · ${String(
            emergencyReason
          )
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 80)}`.slice(0, 120);
          const manualInstructions = [
            `Motivo: ${String(emergencyReason).trim()}`,
            observations?.trim() ? `Observaciones: ${observations.trim()}` : null,
          ]
            .filter(Boolean)
            .join("\n\n");

          // 1) Execution COMPLETED irrepetible
          const exec = await tx.execution.create({
            data: {
              origin: "MANUAL",
              equipmentId: eqId,
              manualTitle,
              manualInstructions: manualInstructions || null,
              technicianId: techId,
              plantId,
              status: "COMPLETED",
              scheduledAt: executedAtDT,
              executedAt: executedAtDT,
              usedQuantity: qtyNormalized,
              usedInputQuantity: qty,
              usedInputUnit: inputUnit,
              usedConvertedQuantity: qtyNormalized,
              usedConvertedUnit: lubUnit,
              condition: condition || null,
              observations: manualInstructions || null,
              evidenceImage: uploadedEvidence?.imageUrl || null,
              evidenceImagePublicId: uploadedEvidence?.imagePublicId || null,
              evidenceNote:
                String(evidenceNote || "").trim() ||
                `EMERGENCY: ${String(emergencyReason).trim()}`,
              inventoryDeductedAt: executedAtDT,
            },
          });

          // 2) Movimiento OUT
          const stockBefore = Number(lubricant.stock || 0);
          const stockAfter = stockBefore - qtyNormalized;
          const settings = await tx.appSettings.findUnique({
            where: { id: 1 },
            select: { preventNegativeStock: true },
          });
          const preventNegativeStock = settings?.preventNegativeStock ?? true;

          if (preventNegativeStock && stockAfter < 0) {
            throw new Error("Stock insuficiente para registrar la actividad emergente");
          }

          await tx.lubricantMovement.create({
            data: {
              lubricantId: lubId,
              executionId: exec.id,
              type: "OUT",
              quantity: qtyNormalized,
              inputQuantity: qty,
              inputUnit,
              convertedQuantity: qtyNormalized,
              convertedUnit: lubUnit,
              reason: "EMERGENCY",
              note: `Equipo: ${equipment.code || equipment.name || eqId} · ${String(
                emergencyReason
              ).trim()}`,
              stockBefore,
              stockAfter,
              createdAt: executedAtDT,
            },
          });

          // 3) Descontar stock
          await tx.lubricant.update({
            where: { id: lubId },
            data: { stock: stockAfter },
          });

          return {
            ok: true,
            execution: exec,
            lubricant: {
              id: lubricant.id,
              name: lubricant.name,
              unit: lubUnit,
              stockBefore,
              stockAfter,
            },
          };
        });

        if (String(condition || "").trim().toUpperCase() === "CRITICO") {
          try {
            await notifyManagers(prisma, {
              plantId,
              type: "EXEC_CONDITION_CRITICAL",
              title: "Actividad emergente crítica",
              message: `${result.execution?.manualTitle || "Actividad emergente"} · ${
                result.execution?.id ? `Ejecución #${result.execution.id}` : "sin folio"
              }`,
              link: `/activities?filter=critical-risk&executionId=${result.execution.id}&focus=critical`,
            });

            await sendCriticalActivityEmail({
              prisma,
              payload: {
                plantId,
                plantName: null,
                equipmentName: result.execution?.manualTitle || "Actividad emergente",
                equipmentCode: null,
                riskLevel: "CRÍTICO",
                reason: `Actividad emergente con condición ${String(condition).trim().toUpperCase()}`,
                observation:
                  result.execution?.observations ||
                  result.execution?.evidenceNote ||
                  "",
                evidenceImage: result.execution?.evidenceImage || null,
                occurredAt: result.execution?.executedAt || executedAtDT,
                suggestedAction: "Revisar la actividad crítica y validar seguimiento inmediato.",
                link: `${process.env.APP_BASE_URL || "http://localhost:5173"}/activities?filter=critical-risk&executionId=${result.execution.id}&focus=critical`,
              },
            });

            sseHub.broadcast("execution.critical", {
              plantId,
              executionId: result.execution.id,
              equipmentId: eqId,
              equipmentName: null,
              equipmentCode: null,
              routeName: result.execution?.manualTitle ?? null,
              executedAt: result.execution.executedAt,
            });
          } catch (notifyErr) {
            console.error("No se pudo notificar actividad emergente crítica:", notifyErr);
          }
        }

        if (techId) {
          try {
            await notifyTechnicianAssignee(prisma, {
              plantId,
              technicianId: techId,
              type: "TECH_ACTIVITY_ASSIGNED",
              title: "Actividad emergente asignada",
              message: `${result.execution?.manualTitle || "Actividad emergente"} programada para ${String(executedAt).slice(0, 10)}`,
              link: "/activities",
            });
          } catch (notifyErr) {
            console.error("No se pudo notificar actividad emergente al tecnico:", notifyErr);
          }
        }

        if (
          result.lubricant?.stockAfter != null &&
          result.lubricant?.stockBefore != null
        ) {
          const minStock = await prisma.lubricant.findFirst({
            where: { id: result.lubricant.id, plantId },
            select: { minStock: true },
          });

          if (
            minStock?.minStock != null &&
            Number(result.lubricant.stockAfter) <= Number(minStock.minStock)
          ) {
            try {
              await notifyManagers(prisma, {
                plantId,
                type: "LOW_STOCK",
                title: "Stock bajo",
                message: `${result.lubricant.name} quedó en ${result.lubricant.stockAfter} ${result.lubricant.unit || ""}`,
                link: "/inventory",
              });

              sseHub.broadcast("inventory.low-stock", {
                plantId,
                lubricantId: result.lubricant.id,
                lubricantName: result.lubricant.name,
                stockAfter: result.lubricant.stockAfter,
                unit: result.lubricant.unit || null,
              });
            } catch (notifyErr) {
              console.error("No se pudo notificar low stock en emergente:", notifyErr);
            }
          }
        }

        return res.json(result);
      } catch (err) {
        console.error("POST /api/emergency-activities", err);
        return res
          .status(400)
          .json({ error: err?.message || "Error creando actividad emergente" });
      }
    }
  );

  return router;
}









