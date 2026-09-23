import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: {
      ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      DATABASE_PATH: ":memory:",
      VINTED_MODE: "mock",
      DISABLE_WORKERS: "true",
      STORAGE_DIR: "/tmp/vinted-dashboard-test-uploads",
    },
  },
});
