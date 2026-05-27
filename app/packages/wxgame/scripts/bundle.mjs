// Build the wxgame distribution:
//   dist/wxgame/game.js               main bundle (esbuild)
//   dist/wxgame/game.json             wx-game manifest, declares subpackages
//   dist/wxgame/packN/game.js         each subpackage's level data (plain JS,
//                                     sets globalThis.__EA_PACK_DATA[N]).
//                                     File MUST be named `game.js` — wxgame
//                                     DevTools' compile pass refuses to build
//                                     if `<subpackage-root>/game.js` is absent.
//
// The subpackage JS files are pure data: no imports, no esbuild pass.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chunkLevels, readAllLevels } from "./_encode.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");
const OUT_DIR = resolve(PKG_ROOT, "dist/wxgame");

await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });

// --- main bundle ------------------------------------------------------------

await build({
  entryPoints: [resolve(PKG_ROOT, "src/main.ts")],
  bundle: true,
  platform: "browser",
  target: "es2020",
  format: "cjs",
  outfile: resolve(OUT_DIR, "game.js"),
  external: [],
  legalComments: "none",
  sourcemap: false,
  minify: false,
  logLevel: "info",
});

// --- subpackages: emit plain-JS data files ---------------------------------

const all = await readAllLevels();
const { packs } = chunkLevels(all);

for (let p = 0; p < packs.length; p++) {
  const dir = resolve(OUT_DIR, `pack${p}`);
  await mkdir(dir, { recursive: true });
  const data = packs[p].map((e) => ({ key: e.key, data: e.encoded }));
  const body =
    `// AUTO-GENERATED — wxgame subpackage ${p}, ${packs[p].length} levels.\n` +
    `(globalThis.__EA_PACK_DATA = globalThis.__EA_PACK_DATA || {})[${p}] = ${JSON.stringify(
      data,
      null,
      0,
    )};\n`;
  await writeFile(resolve(dir, "game.js"), body, "utf8");
}

// --- manifest ---------------------------------------------------------------

const gameJson = {
  deviceOrientation: "portrait",
  showStatusBar: false,
  networkTimeout: { request: 10000 },
  subpackages: packs.map((_, p) => ({ name: `pack${p}`, root: `pack${p}/` })),
};
await writeFile(resolve(OUT_DIR, "game.json"), JSON.stringify(gameJson, null, 2), "utf8");

console.log(`bundle written to ${OUT_DIR}: 1 main bundle + ${packs.length} subpackages`);
