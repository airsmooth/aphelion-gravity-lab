import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: path.join(projectRoot, "desktop"),
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@": projectRoot,
    },
  },
  build: {
    outDir: path.join(projectRoot, "desktop-dist"),
    emptyOutDir: true,
    target: "chrome130",
    sourcemap: false,
  },
});
