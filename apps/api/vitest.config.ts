import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./test/support/setup.ts"],
    env: {
      ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      DATABASE_PATH: ":memory:",
      DISABLE_WORKERS: "true",
      STORAGE_DIR: "/tmp/vinted-dashboard-test-uploads",
    },
  },
});
