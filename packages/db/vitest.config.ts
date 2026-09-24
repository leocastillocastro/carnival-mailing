import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    // Every test file here hits the same real Postgres database. Existing
    // tests get away with Vitest's default parallel-file execution only by
    // scoping every read to their own uniquely-named rows — a test that
    // asserts on a raw aggregate across the whole table (e.g. a global
    // subscriber count) has no such scoping available and is genuinely
    // racy against whatever contact/campaign fixtures another file inserts
    // or deletes in the same instant. Sequential file execution trades a
    // small amount of wall-clock time (this suite is small) for that class
    // of test never being flaky again.
    fileParallelism: false,
  },
});
