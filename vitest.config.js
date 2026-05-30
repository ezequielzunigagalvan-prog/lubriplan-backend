import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.js"],
      exclude: ["src/index.js", "src/prisma.js"],
    },
    // Los tests de integración que necesiten DB real se marcan con .integration.test.js
    // Los unitarios corren siempre
    include: ["tests/**/*.test.js"],
    setupFiles: ["tests/setup.js"],
  },
});
