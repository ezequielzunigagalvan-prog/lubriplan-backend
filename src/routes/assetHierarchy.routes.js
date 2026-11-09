// src/routes/assetHierarchy.routes.js
import { Router } from "express";
import { logger } from "../config/logger.js";

export default function assetHierarchyRoutes({ prisma, auth }) {
  const router = Router();

  // GET /api/maintenance/assets/hierarchy
  // Returns complete asset hierarchy tree structure (Empresa -> Planta -> Área -> Línea -> Equipo)
  router.get("/hierarchy", auth, async (req, res) => {
    try {
      const plantId = req.currentPlantId;
      if (!plantId) {
        return res.status(400).json({ error: "PLANT_REQUIRED" });
      }

      // Get current plant
      const plant = await prisma.plant?.findUnique({
        where: { id: plantId },
      });

      if (!plant) {
        return res.status(404).json({ error: "Plant not found" });
      }

      // Get all areas for this plant
      const areas = await prisma.equipmentArea?.findMany({
        where: { plantId },
      }) || [];

      // Get all equipment for this plant
      const equipment = await prisma.asset?.findMany({
        where: { plantId },
      }) || [];

      // Build hierarchy tree
      const hierarchy = {
        id: `empresa-${plant.id}`,
        name: plant.name || "TechManufacturing S.A.",
        type: "EMPRESA",
        icon: "building",
        children: [
          {
            id: `planta-${plant.id}`,
            name: plant.name,
            type: "PLANTA",
            location: plant.location || "",
            icon: "factory",
            children: areas.map((area) => ({
              id: `area-${area.id}`,
              name: area.name,
              type: "AREA",
              icon: "grid",
              children: [
                // Add equipment under this area if any
                ...equipment
                  .filter((eq) => eq.areaId === area.id) // Adjust based on actual relationship
                  .map((eq) => ({
                    id: `equipo-${eq.id}`,
                    name: eq.name,
                    type: "EQUIPO",
                    code: eq.code,
                    criticality: eq.criticality,
                    state: eq.state,
                    manufacturer: eq.manufacturer,
                    model: eq.model,
                    icon: "package",
                    children: [], // Can add subassemblies if needed
                  })),
              ],
            })),
          },
        ],
      };

      return res.json(hierarchy);
    } catch (e) {
      logger.error("GET assets/hierarchy", e);
      return res.status(500).json({ error: "Error loading asset hierarchy" });
    }
  });

  return router;
}
