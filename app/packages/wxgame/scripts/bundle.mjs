// Bundle the wx-game entry into a single CommonJS file suitable for
// dropping into a wx mini-game project. Produces:
//   dist/wxgame/game.js     bundled entry
//   dist/wxgame/game.json   wx-game manifest

import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");
const OUT_DIR = resolve(PKG_ROOT, "dist/wxgame");

await mkdir(OUT_DIR, { recursive: true });

await build({
  entryPoints: [resolve(PKG_ROOT, "src/main.ts")],
  bundle: true,
  platform: "browser",
  target: "es2020",
  format: "cjs",
  outfile: resolve(OUT_DIR, "game.js"),
  // wx + GameGlobal are runtime globals provided by the wx-game host.
  external: [],
  legalComments: "none",
  sourcemap: false,
  minify: false,
  logLevel: "info",
});

const gameJson = {
  deviceOrientation: "portrait",
  showStatusBar: false,
  networkTimeout: { request: 10000 },
};
await writeFile(
  resolve(OUT_DIR, "game.json"),
  JSON.stringify(gameJson, null, 2),
  "utf8",
);

console.log(`bundle written to ${OUT_DIR}`);
