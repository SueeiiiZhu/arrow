import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  server: { port: 5173, host: true },
  build: { target: "es2020" },
});
