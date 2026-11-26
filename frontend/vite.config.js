import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { resolveDemoMode } from "./src/auth/demoAuth.js";

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const enabled =
    process.env.VITE_ENABLE_DEMO_MODE ?? env.VITE_ENABLE_DEMO_MODE;
  const password = process.env.VITE_DEMO_PASSWORD ?? env.VITE_DEMO_PASSWORD;
  const demoModeEnabled = resolveDemoMode({
    command,
    mode,
    enabled,
  });

  return {
    plugins: [react()],
    define: {
      __KRISTALLBALL_DEMO_MODE__: JSON.stringify(demoModeEnabled),
      __KRISTALLBALL_DEMO_PASSWORD__: JSON.stringify(
        demoModeEnabled && typeof password === "string" ? password : "",
      ),
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
    },
  };
});
