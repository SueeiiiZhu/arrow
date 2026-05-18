import { defineConfig } from "vite";

export default defineConfig({
  // serve the workspace root so we can import levels_data/ from sibling dirs
  root: ".",
  server: { port: 5173, host: true },
  build: { target: "es2020" },
});
