import { defineConfig, loadEnv } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import { offlineShell } from "./build/offline-shell.ts";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  return {
    plugins: [tailwindcss(), solid(), offlineShell()],
    server: {
      port: Number(process.env.WEBAPP_PORT ?? "5173"),
      strictPort: true,
      proxy: {
        "/api": {
          target:
            process.env.VITE_BACKEND_URL ||
            env.VITE_BACKEND_URL ||
            "http://localhost:3000",
        },
        "/auth": {
          target:
            process.env.VITE_BACKEND_URL ||
            env.VITE_BACKEND_URL ||
            "http://localhost:3000",
        },
        "/sync": {
          target:
            process.env.VITE_BACKEND_URL ||
            env.VITE_BACKEND_URL ||
            "http://localhost:3000",
          ws: true,
        },
      },
    },
  };
});
