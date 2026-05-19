// Decode the compact wxgame level format back to the @ea/core RawLevelFile
// shape. Kept inside `wxgame/` because the compact form is wxgame-internal;
// nothing in core needs to know about it.

import type { RawLevelFile } from "@ea/core";

export type CompactLevel = [number, number, number[][]];

const DIRS: Array<[number, number]> = [
  [1, 0], // 0: +x
  [0, 1], // 1: +y
  [-1, 0], // 2: -x
  [0, -1], // 3: -y
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
