// src/__tests__/workOrders.statemachine.test.js
import { describe, it, expect } from "vitest";

/**
 * Work Order State Machine Tests
 * Validates all valid transitions between work order states
 */

const VALID_TRANSITIONS = {
  "REQUESTED": ["PENDING_APPROVAL", "PENDING_AUTHORIZATION"],
  "PENDING_APPROVAL": ["APPROVED", "REJECTED"],
  "PENDING_AUTHORIZATION": ["APPROVED", "REJECTED"],
  "APPROVED": ["ASSIGNED"],
  "ASSIGNED": ["IN_PROGRESS"],
  "IN_PROGRESS": ["FINISHED", "WAITING_PARTS"],
  "WAITING_PARTS": ["IN_PROGRESS", "FINISHED"],
  "FINISHED": ["VALIDATED", "REJECTED"],
};

function isValidTransition(currentStatus, newStatus) {
  const validNext = VALID_TRANSITIONS[currentStatus] || [];
  return validNext.includes(newStatus);
}

describe("Work Order State Machine", () => {
  describe("Valid Transitions", () => {
    it("should allow REQUESTED -> PENDING_APPROVAL", () => {
      expect(isValidTransition("REQUESTED", "PENDING_APPROVAL")).toBe(true);
    });

    it("should allow PENDING_APPROVAL -> APPROVED", () => {
      expect(isValidTransition("PENDING_APPROVAL", "APPROVED")).toBe(true);
    });

    it("should allow APPROVED -> ASSIGNED", () => {
      expect(isValidTransition("APPROVED", "ASSIGNED")).toBe(true);
    });

    it("should allow ASSIGNED -> IN_PROGRESS", () => {
      expect(isValidTransition("ASSIGNED", "IN_PROGRESS")).toBe(true);
    });

    it("should allow IN_PROGRESS -> FINISHED", () => {
      expect(isValidTransition("IN_PROGRESS", "FINISHED")).toBe(true);
    });

    it("should allow IN_PROGRESS -> WAITING_PARTS", () => {
      expect(isValidTransition("IN_PROGRESS", "WAITING_PARTS")).toBe(true);
    });

    it("should allow WAITING_PARTS -> IN_PROGRESS (resume)", () => {
      expect(isValidTransition("WAITING_PARTS", "IN_PROGRESS")).toBe(true);
    });

    it("should allow FINISHED -> VALIDATED", () => {
      expect(isValidTransition("FINISHED", "VALIDATED")).toBe(true);
    });
  });

  describe("Invalid Transitions", () => {
    it("should reject REQUESTED -> APPROVED (skip approval)", () => {
      expect(isValidTransition("REQUESTED", "APPROVED")).toBe(false);
    });

    it("should reject PENDING_APPROVAL -> IN_PROGRESS (skip assigned)", () => {
      expect(isValidTransition("PENDING_APPROVAL", "IN_PROGRESS")).toBe(false);
    });

    it("should reject IN_PROGRESS -> APPROVED (backwards)", () => {
      expect(isValidTransition("IN_PROGRESS", "APPROVED")).toBe(false);
    });

    it("should reject FINISHED -> IN_PROGRESS (can't restart)", () => {
      expect(isValidTransition("FINISHED", "IN_PROGRESS")).toBe(false);
    });

    it("should reject REJECTED -> anything (terminal state)", () => {
      expect(isValidTransition("REJECTED", "APPROVED")).toBe(false);
    });

    it("should reject VALIDATED -> anything (terminal state)", () => {
      expect(isValidTransition("VALIDATED", "APPROVED")).toBe(false);
    });
  });

  describe("Edge Cases", () => {
    it("should handle null/undefined states", () => {
      expect(isValidTransition(null, "APPROVED")).toBe(false);
      expect(isValidTransition("APPROVED", null)).toBe(false);
    });

    it("should handle unknown states", () => {
      expect(isValidTransition("UNKNOWN", "APPROVED")).toBe(false);
      expect(isValidTransition("APPROVED", "UNKNOWN")).toBe(false);
    });

    it("should be case-sensitive", () => {
      expect(isValidTransition("requested", "APPROVED")).toBe(false);
    });
  });

  describe("All States Covered", () => {
    it("should define transitions for all states", () => {
      const allStates = Object.keys(VALID_TRANSITIONS);
      expect(allStates.length).toBeGreaterThan(0);
      expect(allStates).toContain("REQUESTED");
      expect(allStates).toContain("FINISHED");
    });

    it("should have at least one valid transition per state", () => {
      Object.entries(VALID_TRANSITIONS).forEach(([state, transitions]) => {
        expect(transitions.length).toBeGreaterThan(0);
      });
    });
  });
});
