import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // ML-DSA-87 and ML-KEM-1024 in pure JavaScript take tens of milliseconds per call.
    testTimeout: 30_000,
    // Never call a paid model from a test: the planners are the rules unless a test builds its own.
    env: { PEAL_BIDDER_PLANNER: "rules" },
  },
});
