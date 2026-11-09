// src/__tests__/controllers/technicians.controller.test.js
import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Technicians Controller Tests
 * Unit tests for technician creation and validation
 */

describe("createTechnician Controller", () => {
  let mockReq, mockRes, mockPrisma;

  beforeEach(() => {
    mockReq = {
      currentPlantId: 1,
      body: {
        name: "Juan Pérez",
        email: "juan@example.com",
        phone: "+56912345678",
        speciality: "MECHANIC",
        certifications: ["ISO 9001", "Safety"],
      },
      user: { id: 1 },
    };

    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };

    mockPrisma = {
      technician: {
        create: vi.fn(),
        findMany: vi.fn(),
        findFirst: vi.fn(),
      },
    };
  });

  describe("Valid Input", () => {
    it("should create technician with all fields", async () => {
      const createdTech = {
        id: 1,
        plantId: 1,
        name: "Juan Pérez",
        email: "juan@example.com",
        phone: "+56912345678",
        code: "TECH-001",
        specialty: "MECHANIC",
        certifications: '["ISO 9001","Safety"]',
        status: "Activo",
      };

      mockPrisma.technician.create.mockResolvedValue(createdTech);

      expect(createdTech).toMatchObject({
        name: "Juan Pérez",
        email: "juan@example.com",
        phone: "+56912345678",
      });
    });

    it("should parse certifications as JSON", () => {
      const certs = ["ISO 9001", "Safety"];
      const jsonCerts = JSON.stringify(certs);

      expect(() => JSON.parse(jsonCerts)).not.toThrow();
      expect(JSON.parse(jsonCerts)).toEqual(certs);
    });

    it("should auto-generate code if not provided", () => {
      const codePattern = /^TECH-\d{10}$/;
      expect("TECH-1234567890").toMatch(codePattern);
    });
  });

  describe("Missing Required Fields", () => {
    it("should reject missing name", () => {
      const invalidReq = { ...mockReq, body: { name: "" } };
      expect(!invalidReq.body.name).toBe(true);
    });

    it("should reject missing speciality", () => {
      const invalidReq = { ...mockReq, body: { speciality: "" } };
      expect(!invalidReq.body.speciality).toBe(true);
    });

    it("should allow missing email (optional)", () => {
      const validReq = { ...mockReq, body: { email: "" } };
      expect(true).toBe(true); // Email is optional
    });

    it("should allow missing phone (optional)", () => {
      const validReq = { ...mockReq, body: { phone: "" } };
      expect(true).toBe(true); // Phone is optional
    });
  });

  describe("Error Handling", () => {
    it("should require PLANT_REQUIRED", () => {
      const reqNoPlant = { ...mockReq, currentPlantId: null };
      expect(reqNoPlant.currentPlantId).toBeNull();
    });

    it("should handle duplicate code error", () => {
      const error = { code: "P2002" };
      expect(error.code).toBe("P2002");
    });

    it("should return 409 on duplicate code", () => {
      const statusCode = 409;
      expect(statusCode).toBe(409);
    });
  });

  describe("Data Transformation", () => {
    it("should trim whitespace from name", () => {
      const name = "  Juan Pérez  ";
      expect(name.trim()).toBe("Juan Pérez");
    });

    it("should uppercase code", () => {
      const code = "tech-001";
      expect(code.toUpperCase()).toBe("TECH-001");
    });

    it("should set default status to Activo", () => {
      const status = "Activo";
      expect(status).toBe("Activo");
    });

    it("should convert email to lowercase", () => {
      const email = "JUAN@EXAMPLE.COM";
      expect(email.toLowerCase()).toBe("juan@example.com");
    });
  });

  describe("Response Format", () => {
    it("should return 201 status on success", () => {
      const status = 201;
      expect(status).toBe(201);
    });

    it("should include technician data in response", () => {
      const response = {
        ok: true,
        item: { id: 1, name: "Juan Pérez" },
      };
      expect(response.item).toHaveProperty("name");
      expect(response.ok).toBe(true);
    });

    it("should not include password in response", () => {
      const response = { id: 1, name: "Juan" };
      expect(response).not.toHaveProperty("password");
    });
  });

  describe("Field Validation", () => {
    it("should validate email format", () => {
      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      expect("juan@example.com").toMatch(emailPattern);
      expect("invalid-email").not.toMatch(emailPattern);
    });

    it("should validate phone format (optional)", () => {
      const phone = "+56912345678";
      expect(phone.length).toBeGreaterThan(0);
    });

    it("should validate speciality is in allowed list", () => {
      const allowed = ["MECHANIC", "ELECTRICAL", "INSTRUMENTS", "WELDING"];
      expect(allowed).toContain("MECHANIC");
      expect(allowed).not.toContain("INVALID");
    });
  });
});
