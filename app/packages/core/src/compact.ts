// Compact wire format used by the wxgame subpackages and the H5 lazy-pack
// loader. The encoder lives in tooling (`packages/wxgame/scripts/_encode.mjs`)
// because it runs only at build time; the decoder ships in core so any
// host can hydrate a compact tuple back into a RawLevelFile.
//
//   level   := [W, H, arrows[]]
//   arrow   := [fdir, ...cellIdx]
//   fdir    := 0 (+x), 1 (+y), 2 (-x), 3 (-y)
//   cellIdx := y*W + x

import type { RawLevelFile } from "./types.js";

export type CompactLevel = [number, number, number[][]];

const DIRS: Array<[number, number]> = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

export function decodeCompact(c: CompactLevel): RawLevelFile {
  const [W, H, arrows] = c;
  return {
    width: W,
    height: H,
    coord_system: "row-major, origin top-left, y-down",
    arrows: arrows.map((a) => {
      const fdir = a[0]!;
      const [fx, fy] = DIRS[fdir]!;
      const path: Array<[number, number]> = [];
      for (let i = 1; i < a.length; i++) {
        const idx = a[i]!;
        path.push([idx % W, Math.floor(idx / W)]);
      }
      const start: [number, number] = path[0]!;
      return { start, facing: [fx, fy], path };
    }),
  };
}
