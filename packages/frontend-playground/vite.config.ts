import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss(), nodePolyfills({ include: ["buffer", "crypto"] })],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    // Proxy Solstice's instructions API so the browser doesn't hit CORS.
    // Mirrors the frontend-institutional setup. Without this every
    // RequestMint / Lock / Unlock / RequestRedeem call fails the preflight
    // (browser surfaces it as "unauthorized" because the failed OPTIONS
    // request never carries the x-api-key forward).
    proxy: {
      "/api/solstice": {
        target: "https://instructions.solstice.finance",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/solstice/, "/v1/instructions"),
      },
    },
  },
});
