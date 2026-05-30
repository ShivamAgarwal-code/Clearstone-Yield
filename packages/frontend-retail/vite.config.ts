import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import path from "path";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    nodePolyfills({
      include: ["buffer", "crypto"],
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "daisyui": path.resolve(__dirname, "node_modules/daisyui"),
      // Force vite-plugin-node-polyfills' Buffer shim to resolve via the
      // frontend's own node_modules, not the pnpm-linked workspace dep's.
      "vite-plugin-node-polyfills/shims/buffer": path.resolve(
        __dirname,
        "node_modules/vite-plugin-node-polyfills/shims/buffer"
      ),
      "vite-plugin-node-polyfills/shims/global": path.resolve(
        __dirname,
        "node_modules/vite-plugin-node-polyfills/shims/global"
      ),
      "vite-plugin-node-polyfills/shims/process": path.resolve(
        __dirname,
        "node_modules/vite-plugin-node-polyfills/shims/process"
      ),
    },
  },
  optimizeDeps: {
    // Pre-bundle the workspace SDK so vite-plugin-node-polyfills' Buffer
    // shim can be injected into a single optimized chunk instead of being
    // patched into each of the SDK's dist/*.js files at rollup time
    // (which fails to resolve its shim path from the pnpm-linked dir).
    include: ["@delta/calldata-sdk-solana"],
  },
});
