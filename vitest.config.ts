import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Backend spawn + hot-swap tests start real child processes and poll for
    // readiness, so give each test room without being flaky.
    testTimeout: 20000,
    hookTimeout: 20000,
    // Child-process lifecycle tests must not run in parallel across files,
    // to keep port allocation and process accounting deterministic.
    fileParallelism: false,
  },
});
