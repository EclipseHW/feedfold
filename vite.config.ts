import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/echovale/",
  plugins: [react()],
  root: ".",
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  server: {
    host: "0.0.0.0",
    proxy: {
      "/echovale/api": {
        target: "http://127.0.0.1:3000",
        rewrite: (path) => path.replace(/^\/echovale/, ""),
      },
      "/echovale/health": {
        target: "http://127.0.0.1:3000",
        rewrite: (path) => path.replace(/^\/echovale/, ""),
      },
    },
  },
});
