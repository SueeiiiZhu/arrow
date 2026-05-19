/** Stable arrow palette — first N visually distinct hues. Used so each arrow
 *  gets its own color in the absence of skin assets. Replace later with
 *  real sprites when you've drawn your own. */
const HUES = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#a855f7",
  "#f59e0b",
  "#10b981",
  "#0ea5e9",
  "#d946ef",
  "#84cc16",
];

export function colorFor(i: number): string {
  return HUES[i % HUES.length]!;
}
