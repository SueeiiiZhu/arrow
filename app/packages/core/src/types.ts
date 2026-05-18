/**
 * Engine-neutral level types. Coordinate system:
 *   - origin top-left, +x right, +y down
 *   - cell index (row-major) = y * width + x
 *
 * Mirrors the original game's `XSize/YSize/Arrows[X,Y,Dx,Dy,Indices,BendCount]`
 * but in a flat (col,row) form so renderers/solvers stay coordinate-agnostic.
 */

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export interface ArrowData {
  /** start cell; equals path[0] */
  readonly start: Vec2;
  /** arrow facing (== negation of first path step); not a movement direction */
  readonly facing: Vec2;
  /** 4-neighbor sequence of cells, path[0] === start */
  readonly path: ReadonlyArray<Vec2>;
}

export interface LevelData {
  readonly width: number;
  readonly height: number;
  readonly arrows: ReadonlyArray<ArrowData>;
}

/** Raw on-disk format we ship with the bundle (engine-neutral export). */
export interface RawLevelFile {
  width: number;
  height: number;
  coord_system: string;
  arrows: Array<{
    start: [number, number];
    facing: [number, number];
    path: Array<[number, number]>;
  }>;
}

/** Original APK JSON shape — kept here only for the importer. */
export interface OriginalLevelFile {
  XSize: number;
  YSize: number;
  Arrows: Array<{
    X: number;
    Y: number;
    Dx: number;
    Dy: number;
    Indices: number[];
    BendCount: number;
  }>;
}
