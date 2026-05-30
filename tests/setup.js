// tests/setup.js — configuración global de tests
import { vi } from "vitest";

// Mock de Prisma para tests unitarios (no necesita BD real)
vi.mock("../src/prisma.js", () => ({
  default: {
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    userPlant: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    plant: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    execution: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    conditionReport: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    appSettings: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    $disconnect: vi.fn(),
  },
}));

// Suprimir logs durante tests
vi.mock("../src/config/logger.js", () => ({
  logger: {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Sentry no-op en tests
vi.mock("../src/config/sentry.js", () => ({
  initSentry: vi.fn(),
  Sentry: {
    captureException: vi.fn(),
    expressErrorHandler: () => (err, req, res, next) => next(err),
  },
}));
