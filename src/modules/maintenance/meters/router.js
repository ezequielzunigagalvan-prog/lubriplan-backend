import express from "express";
import { z } from "zod";
import prisma from "../../../prisma.js";
import { logger } from "../../../config/logger.js";
import { generateForAssetMeterReading } from "../scheduler/generator.js";

const router = express.Router();

const meterReadingSchema = z.object({
  value: z.number().nonnegative(),
  readAt: z.string().datetime().optional(),
  isReset: z.boolean().default(false),
  note: z.string().optional(),
});

router.get("/assets/:assetId/meter", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const assetId = parseInt(req.params.assetId);

    const asset = await prisma.mtAsset.findFirst({
      where: { id: assetId, plantId, deletedAt: null },
      select: { id: true },
    });

    if (!asset) {
      return res.status(404).json({ error: "Asset not found" });
    }

    const readings = await prisma.mtMeterReading.findMany({
      where: { assetId, plantId },
      select: {
        id: true,
        value: true,
        readAt: true,
        source: true,
        isReset: true,
        note: true,
        createdAt: true,
      },
      orderBy: { readAt: "desc" },
      take: 20,
    });

    const current = readings[0] || null;

    return res.json({
      assetId,
      current: current ? { value: current.value, readAt: current.readAt } : null,
      recent: readings,
    });
  } catch (err) {
    logger.error("[meters GET]", err);
    return res.status(500).json({ error: "Error fetching meter readings" });
  }
});

router.post("/assets/:assetId/meter-readings", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const assetId = parseInt(req.params.assetId);
    const user = req.user;

    const parsed = meterReadingSchema.parse(req.body);

    const asset = await prisma.mtAsset.findFirst({
      where: { id: assetId, plantId, deletedAt: null },
      select: { id: true },
    });

    if (!asset) {
      return res.status(404).json({ error: "Asset not found" });
    }

    const lastReading = await prisma.mtMeterReading.findFirst({
      where: { assetId, plantId },
      orderBy: { readAt: "desc" },
      select: { value: true, readAt: true },
    });

    if (lastReading && !parsed.isReset && parsed.value < lastReading.value) {
      return res.status(422).json({
        error: "Meter value cannot be less than last reading unless isReset=true",
        lastValue: lastReading.value,
      });
    }

    const reading = await prisma.mtMeterReading.create({
      data: {
        plantId,
        assetId,
        value: parsed.value,
        readAt: parsed.readAt ? new Date(parsed.readAt) : new Date(),
        source: "MANUAL",
        isReset: parsed.isReset,
        userId: user.id,
        note: parsed.note,
      },
    });

    const generatedWOs = await generateForAssetMeterReading(
      { id: assetId, plantId },
      { now: new Date() }
    );

    return res.status(201).json({
      reading,
      generatedWorkOrders: generatedWOs.filter((w) => w.decision === "GENERATED"),
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors[0]?.message });
    }
    logger.error("[meters POST]", err);
    return res.status(500).json({ error: "Error recording meter reading" });
  }
});

export default router;
