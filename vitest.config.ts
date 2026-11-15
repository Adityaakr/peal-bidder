import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // ML-DSA-87 and ML-KEM-1024 in pure JavaScript take tens of milliseconds per call.
    testTimeout: 30_000,
  },
});
