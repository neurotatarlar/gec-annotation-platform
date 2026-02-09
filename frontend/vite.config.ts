/**
 * Vite configuration for local dev server and production builds.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  envDir: path.resolve("."),
  plugins: [react()],
  server: {
    port: 5173,
    host: true
  },
  build: {
    outDir: "dist"
  }
});
