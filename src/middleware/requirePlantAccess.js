export const requirePlantAccess = (prisma) => {
  return async (req, res, next) => {
    try {
      const userId = req.user?.id;
      const plantId = req.currentPlantId;

      if (!plantId) {
        return res.status(400).json({ error: "PLANT_REQUIRED" });
      }

      const membership = await prisma.userPlant.findUnique({
        where: {
          userId_plantId: {
            userId,
            plantId,
          },
        },
      });

      if (!membership) {
        return res.status(403).json({ error: "PLANT_FORBIDDEN" });
      }

      if (membership.active === false) {
        return res.status(403).json({ error: "PLANT_FORBIDDEN" });
      }

      next();
    } catch (err) {
      console.error("requirePlantAccess error:", err);
      return res.status(500).json({ error: "Error validando acceso a planta" });
    }
  };
};
