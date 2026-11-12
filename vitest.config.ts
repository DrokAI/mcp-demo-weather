import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Hermetic by construction: every upstream response is injected via a
    // fake fetch. CI must never need the network.
  },
});
