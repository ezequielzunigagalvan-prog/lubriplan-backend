import { describe, it, expect } from "vitest";
import { canTransition, STATES } from "../../../src/modules/maintenance/workOrders/stateMachine.js";

describe("State Machine", () => {
  describe("Transition Permissions", () => {
    it("ADMIN can approve REQUESTED order", () => {
      const order = { status: STATES.REQUESTED, requestedBy: 1, assignedTo: null };
      const user = { id: 1, role: "ADMIN" };
      const result = canTransition(order, STATES.APPROVED, user);
      expect(result.allowed).toBe(true);
    });

    it("TECHNICIAN cannot approve REQUESTED order", () => {
      const order = { status: STATES.REQUESTED, requestedBy: 1, assignedTo: null };
      const user = { id: 1, role: "TECHNICIAN" };
      const result = canTransition(order, STATES.APPROVED, user);
      expect(result.allowed).toBe(false);
    });

    it("SUPERVISOR can reject REQUESTED order", () => {
      const order = { status: STATES.REQUESTED, requestedBy: 1, assignedTo: null };
      const user = { id: 1, role: "SUPERVISOR" };
      const result = canTransition(order, STATES.REJECTED, user);
      expect(result.allowed).toBe(true);
    });

    it("ADMIN can assign to APPROVED order", () => {
      const order = { status: STATES.APPROVED, requestedBy: 1, assignedTo: null };
      const user = { id: 1, role: "ADMIN" };
      const result = canTransition(order, STATES.ASSIGNED, user);
      expect(result.allowed).toBe(true);
    });

    it("Only assigned technician can move ASSIGNED to IN_PROGRESS", () => {
      const order = { status: STATES.ASSIGNED, assignedTo: 5, requestedBy: 1 };
      const assignedUser = { id: 5, role: "TECHNICIAN" };
      const otherUser = { id: 2, role: "TECHNICIAN" };

      const assignedResult = canTransition(order, STATES.IN_PROGRESS, assignedUser);
      const otherResult = canTransition(order, STATES.IN_PROGRESS, otherUser);

      expect(assignedResult.allowed).toBe(true);
      expect(otherResult.allowed).toBe(false);
    });

    it("Assigned technician can move IN_PROGRESS to FINISHED", () => {
      const order = { status: STATES.IN_PROGRESS, assignedTo: 5, requestedBy: 1 };
      const user = { id: 5, role: "TECHNICIAN" };
      const result = canTransition(order, STATES.FINISHED, user);
      expect(result.allowed).toBe(true);
    });

    it("ADMIN can validate FINISHED order", () => {
      const order = { status: STATES.FINISHED, assignedTo: 5, requestedBy: 1 };
      const user = { id: 1, role: "ADMIN" };
      const result = canTransition(order, STATES.VALIDATED, user);
      expect(result.allowed).toBe(true);
    });

    it("Cannot transition from terminal states (VALIDATED)", () => {
      const order = { status: STATES.VALIDATED, assignedTo: 5, requestedBy: 1 };
      const user = { id: 1, role: "ADMIN" };
      const result = canTransition(order, STATES.CANCELLED, user);
      expect(result.allowed).toBe(false);
    });

    it("Cannot transition from terminal states (CANCELLED)", () => {
      const order = { status: STATES.CANCELLED, assignedTo: 5, requestedBy: 1 };
      const user = { id: 1, role: "ADMIN" };
      const result = canTransition(order, STATES.APPROVED, user);
      expect(result.allowed).toBe(false);
    });

    it("Cannot transition from terminal states (REJECTED)", () => {
      const order = { status: STATES.REJECTED, assignedTo: null, requestedBy: 1 };
      const user = { id: 1, role: "ADMIN" };
      const result = canTransition(order, STATES.APPROVED, user);
      expect(result.allowed).toBe(false);
    });

    it("Both assigned and SUPERVISOR can move WAITING_PARTS to IN_PROGRESS", () => {
      const order = { status: STATES.WAITING_PARTS, assignedTo: 5, requestedBy: 1 };
      const assignedUser = { id: 5, role: "TECHNICIAN" };
      const supervisorUser = { id: 1, role: "SUPERVISOR" };

      const assignedResult = canTransition(order, STATES.IN_PROGRESS, assignedUser);
      const supervisorResult = canTransition(order, STATES.IN_PROGRESS, supervisorUser);

      expect(assignedResult.allowed).toBe(true);
      expect(supervisorResult.allowed).toBe(true);
    });

    it("ADMIN can cancel from any non-terminal state", () => {
      const states = [
        STATES.REQUESTED,
        STATES.APPROVED,
        STATES.ASSIGNED,
        STATES.IN_PROGRESS,
        STATES.WAITING_PARTS,
      ];

      const user = { id: 1, role: "ADMIN" };

      states.forEach((state) => {
        const order = { status: state, assignedTo: 5, requestedBy: 1 };
        const result = canTransition(order, STATES.CANCELLED, user);
        expect(result.allowed).toBe(true, `Should allow CANCEL from ${state}`);
      });
    });
  });

  describe("Invalid Transitions", () => {
    it("Cannot transition REQUESTED → IN_PROGRESS directly", () => {
      const order = { status: STATES.REQUESTED, assignedTo: null, requestedBy: 1 };
      const user = { id: 1, role: "ADMIN" };
      const result = canTransition(order, STATES.IN_PROGRESS, user);
      expect(result.allowed).toBe(false);
    });

    it("Cannot transition APPROVED → FINISHED directly", () => {
      const order = { status: STATES.APPROVED, assignedTo: null, requestedBy: 1 };
      const user = { id: 1, role: "ADMIN" };
      const result = canTransition(order, STATES.FINISHED, user);
      expect(result.allowed).toBe(false);
    });
  });
});
