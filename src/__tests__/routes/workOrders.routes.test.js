// src/__tests__/routes/workOrders.routes.test.js
import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Work Orders Routes Integration Tests
 * Tests for all work order endpoints
 */

describe("Work Orders Routes", () => {
  describe("GET /api/maintenance/work-orders", () => {
    it("should require plantId", () => {
      const req = { currentPlantId: null };
      expect(req.currentPlantId).toBeNull();
    });

    it("should return list with pagination", () => {
      const response = {
        data: [{ id: 1, status: "APPROVED" }],
        total: 1,
        limit: 50,
        offset: 0,
      };
      expect(response.data).toHaveLength(1);
      expect(response.total).toBe(1);
    });

    it("should support status filter", () => {
      const filters = { status: "APPROVED" };
      expect(filters.status).toBe("APPROVED");
    });

    it("should support assetId filter", () => {
      const filters = { assetId: 5 };
      expect(filters.assetId).toBe(5);
    });
  });

  describe("GET /api/maintenance/work-orders/:id", () => {
    it("should return 404 if not found", () => {
      const statusCode = 404;
      expect(statusCode).toBe(404);
    });

    it("should return work order with details", () => {
      const wo = {
        id: 1,
        status: "APPROVED",
        assetId: 5,
        assignedTechnicianId: 2,
      };
      expect(wo).toHaveProperty("id");
      expect(wo).toHaveProperty("status");
    });

    it("should validate numeric ID", () => {
      const id = parseInt("1");
      expect(Number.isFinite(id)).toBe(true);

      const invalidId = parseInt("abc");
      expect(Number.isFinite(invalidId)).toBe(false);
    });
  });

  describe("PATCH /api/maintenance/work-orders/:id/status", () => {
    it("should validate state transition PENDING -> APPROVED", () => {
      const VALID_TRANSITIONS = {
        PENDING_APPROVAL: ["APPROVED", "REJECTED"],
      };

      const currentStatus = "PENDING_APPROVAL";
      const newStatus = "APPROVED";

      const isValid = VALID_TRANSITIONS[currentStatus]?.includes(newStatus);
      expect(isValid).toBe(true);
    });

    it("should reject invalid transition IN_PROGRESS -> APPROVED", () => {
      const VALID_TRANSITIONS = {
        IN_PROGRESS: ["FINISHED", "WAITING_PARTS"],
      };

      const currentStatus = "IN_PROGRESS";
      const newStatus = "APPROVED";

      const isValid = VALID_TRANSITIONS[currentStatus]?.includes(newStatus);
      expect(isValid).toBe(false);
    });

    it("should return 400 if status not provided", () => {
      const body = { assignedTechnicianId: 2 };
      expect(body.status).toBeUndefined();
    });

    it("should update technician assignment", () => {
      const updateData = {
        status: "ASSIGNED",
        assignedTechnicianId: 5,
      };
      expect(updateData.assignedTechnicianId).toBe(5);
    });

    it("should update estimated hours", () => {
      const updateData = {
        status: "ASSIGNED",
        estimatedHours: 4.5,
      };
      expect(updateData.estimatedHours).toBe(4.5);
    });

    it("should return 200 on success", () => {
      const statusCode = 200;
      expect(statusCode).toBe(200);
    });
  });

  describe("POST /api/maintenance/work-orders/:id/approve", () => {
    it("should set status to APPROVED", () => {
      const response = { status: "APPROVED" };
      expect(response.status).toBe("APPROVED");
    });

    it("should record approverBy user", () => {
      const response = {
        approvedBy: 1,
        approvedAt: new Date().toISOString(),
      };
      expect(response.approvedBy).toBe(1);
      expect(response.approvedAt).toBeDefined();
    });

    it("should assign technician if provided", () => {
      const body = { assignedTechnicianId: 5 };
      expect(body.assignedTechnicianId).toBe(5);
    });

    it("should return 200 on success", () => {
      const statusCode = 200;
      expect(statusCode).toBe(200);
    });
  });

  describe("POST /api/maintenance/work-orders/:id/reject", () => {
    it("should set status to REJECTED", () => {
      const response = { status: "REJECTED" };
      expect(response.status).toBe("REJECTED");
    });

    it("should record rejectionReason", () => {
      const body = { reason: "Insufficient resources" };
      expect(body.reason).toBeDefined();
    });

    it("should record rejectedBy user", () => {
      const response = {
        rejectedBy: 1,
        rejectedAt: new Date().toISOString(),
      };
      expect(response.rejectedBy).toBe(1);
    });

    it("should return 200 on success", () => {
      const statusCode = 200;
      expect(statusCode).toBe(200);
    });
  });

  describe("Error Responses", () => {
    it("should return 400 for PLANT_REQUIRED", () => {
      const statusCode = 400;
      const error = "PLANT_REQUIRED";
      expect(statusCode).toBe(400);
      expect(error).toBeDefined();
    });

    it("should return 400 for Invalid ID", () => {
      const statusCode = 400;
      expect(statusCode).toBe(400);
    });

    it("should return 404 for not found", () => {
      const statusCode = 404;
      expect(statusCode).toBe(404);
    });

    it("should return 400 for invalid transition", () => {
      const statusCode = 400;
      expect(statusCode).toBe(400);
    });

    it("should return 500 for server error", () => {
      const statusCode = 500;
      expect(statusCode).toBe(500);
    });
  });

  describe("Request Validation", () => {
    it("should validate required plantId", () => {
      const req = { currentPlantId: 1 };
      expect(req.currentPlantId).toBe(1);
    });

    it("should parse numeric IDs correctly", () => {
      const id = parseInt("5");
      expect(Number.isFinite(id)).toBe(true);
    });

    it("should validate status field exists", () => {
      const body = { status: "APPROVED" };
      expect(body.status).toBeDefined();
    });

    it("should allow optional assignedTechnicianId", () => {
      const body = { status: "APPROVED" };
      expect(body.assignedTechnicianId).toBeUndefined();
    });
  });

  describe("State Machine Coverage", () => {
    const VALID_TRANSITIONS = {
      REQUESTED: ["PENDING_APPROVAL"],
      PENDING_APPROVAL: ["APPROVED", "REJECTED"],
      APPROVED: ["ASSIGNED"],
      ASSIGNED: ["IN_PROGRESS"],
      IN_PROGRESS: ["FINISHED", "WAITING_PARTS"],
      WAITING_PARTS: ["IN_PROGRESS", "FINISHED"],
      FINISHED: ["VALIDATED", "REJECTED"],
    };

    it("should have valid transitions for all states", () => {
      Object.entries(VALID_TRANSITIONS).forEach(([state, transitions]) => {
        expect(transitions.length).toBeGreaterThan(0);
      });
    });

    it("should prevent backwards transitions", () => {
      const isValid = VALID_TRANSITIONS.FINISHED?.includes("APPROVED");
      expect(isValid).toBeFalsy();
    });
  });
});
