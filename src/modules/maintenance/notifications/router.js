import { Router } from "express";
import { logger } from "../../../config/logger.js";
import {
  getUserNotifications,
  markNotificationAsRead,
  getUnreadCount,
  runAllAlertChecks,
  getOrCreatePreferences,
  updatePreferences,
} from "./service.js";

const router = Router();

// GET /api/maintenance/notifications
router.get("/", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const userId = req.user.id;
    const { limit = 50 } = req.query;

    const notifications = await getUserNotifications(plantId, userId, parseInt(limit));
    res.json(notifications);
  } catch (error) {
    logger.error("[GET /notifications]", error);
    res.status(500).json({ error: "Error fetching notifications" });
  }
});

// GET /api/maintenance/notifications/unread-count
router.get("/unread-count", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const userId = req.user.id;

    const count = await getUnreadCount(plantId, userId);
    res.json({ unreadCount: count });
  } catch (error) {
    logger.error("[GET /notifications/unread-count]", error);
    res.status(500).json({ error: "Error fetching unread count" });
  }
});

// PATCH /api/maintenance/notifications/:id/read
router.patch("/:id/read", async (req, res) => {
  try {
    const plantId = req.currentPlantId;
    const notif = await markNotificationAsRead(parseInt(req.params.id), plantId);

    if (!notif) {
      return res.status(404).json({ error: "Notification not found" });
    }

    res.json(notif);
  } catch (error) {
    logger.error("[PATCH /notifications/:id/read]", error);
    res.status(500).json({ error: "Error marking notification as read" });
  }
});

// POST /api/maintenance/notifications/check-alerts
router.post("/check-alerts", async (req, res) => {
  try {
    const plantId = req.currentPlantId;

    const result = await runAllAlertChecks(plantId);
    res.json(result);
  } catch (error) {
    logger.error("[POST /notifications/check-alerts]", error);
    res.status(500).json({ error: "Error checking alerts" });
  }
});

// ============================================================
// PREFERENCES
// ============================================================

// GET /api/maintenance/notifications/preferences
router.get("/preferences", async (req, res) => {
  try {
    const userId = req.user.id;
    const plantId = req.currentPlantId;

    const prefs = await getOrCreatePreferences(userId, plantId);
    res.json(prefs);
  } catch (error) {
    logger.error("[GET /notifications/preferences]", error);
    res.status(500).json({ error: "Error fetching preferences" });
  }
});

// PATCH /api/maintenance/notifications/preferences
router.patch("/preferences", async (req, res) => {
  try {
    const userId = req.user.id;
    const plantId = req.currentPlantId;

    const updated = await updatePreferences(userId, plantId, req.body);
    res.json(updated);
  } catch (error) {
    logger.error("[PATCH /notifications/preferences]", error);
    res.status(500).json({ error: "Error updating preferences" });
  }
});

export default router;
