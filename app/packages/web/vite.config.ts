import { defineConfig } from "vite";

// Production build is published to GitHub Pages under
// https://sueeiiizhu.github.io/arrow/, so all asset URLs need the /arrow/
// prefix. Dev server stays at /. Override with the BASE_PATH env var when
// publishing to a different path (e.g. a fork or a custom domain).
const BASE_PATH = process.env.BASE_PATH ?? "/arrow/";

export default defineConfig(({ command }) => ({
  root: ".",
  base: command === "build" ? BASE_PATH : "/",
  server: { port: 5173, host: true },
  build: { target: "es2020" },
}));
