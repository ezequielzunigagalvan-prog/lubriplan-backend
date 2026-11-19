import { Router } from "express";
import { logger } from "../../../config/logger.js";
import {
  getUserNotifications,
  markNotificationAsRead,
  markAllAsRead,
  getUnreadCount,
  runAllAlertChecks,
  getOrCreatePreferences,
  updatePreferences,
} from "./service.js";

const router = Router();

// GET /api/maintenance/notifications?limit=50&unread=1&type=
router.get("/", async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const unreadOnly = req.query.unread === "1" || req.query.unread === "true";
    const type = typeof req.query.type === "string" && req.query.type ? req.query.type : undefined;
    const notifications = await getUserNotifications(req.currentPlantId, req.user.id, { limit, unreadOnly, type });
    res.json(notifications);
  } catch (error) {
    logger.error("[GET /notifications]", error);
    res.status(500).json({ error: "Error fetching notifications" });
  }
});

router.get("/unread-count", async (req, res) => {
  try {
    res.json({ unreadCount: await getUnreadCount(req.currentPlantId, req.user.id) });
  } catch (error) {
    logger.error("[GET /notifications/unread-count]", error);
    res.status(500).json({ error: "Error fetching unread count" });
  }
});

// PATCH /api/maintenance/notifications/read-all
router.patch("/read-all", async (req, res) => {
  try {
    res.json({ updated: await markAllAsRead(req.currentPlantId, req.user.id) });
  } catch (error) {
    logger.error("[PATCH /notifications/read-all]", error);
    res.status(500).json({ error: "Error marking notifications as read" });
  }
});

router.patch("/:id/read", async (req, res) => {
  try {
    const notif = await markNotificationAsRead(parseInt(req.params.id, 10), req.currentPlantId, req.user.id);
    if (!notif) return res.status(404).json({ error: "Notification not found" });
    res.json(notif);
  } catch (error) {
    logger.error("[PATCH /notifications/:id/read]", error);
    res.status(500).json({ error: "Error marking notification as read" });
  }
});

// POST /api/maintenance/notifications/check-alerts — revisión manual (el scheduler también la corre)
router.post("/check-alerts", async (req, res) => {
  try {
    if (!["ADMIN", "SUPERVISOR"].includes(req.user?.role)) {
      return res.status(403).json({ error: "Only ADMIN/SUPERVISOR can run alert checks" });
    }
    res.json(await runAllAlertChecks(req.currentPlantId));
  } catch (error) {
    logger.error("[POST /notifications/check-alerts]", error);
    res.status(500).json({ error: "Error checking alerts" });
  }
});

router.get("/preferences", async (req, res) => {
  try {
    res.json(await getOrCreatePreferences(req.user.id, req.currentPlantId));
  } catch (error) {
    logger.error("[GET /notifications/preferences]", error);
    res.status(500).json({ error: "Error fetching preferences" });
  }
});

router.patch("/preferences", async (req, res) => {
  try {
    res.json(await updatePreferences(req.user.id, req.currentPlantId, req.body));
  } catch (error) {
    logger.error("[PATCH /notifications/preferences]", error);
    res.status(500).json({ error: "Error updating preferences" });
  }
});

export default router;
