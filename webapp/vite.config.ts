import { defineConfig, loadEnv } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  return {
    plugins: [tailwindcss(), solid()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": env.VITE_BACKEND_URL || "http://localhost:3000",
      },
    },
  };
});
