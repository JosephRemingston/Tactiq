/**
 * Canonical pitch geometry (metres). The acting team always attacks towards +x; y = 0 is the attacking team's left touchline.
 * All analytics read coordinates in this frame only.
 */
export const PITCH = {
  length: 105,
  width: 68,
  goalCentre: { x: 105, y: 34 },
  box: { minX: 88.5, minY: 13.84, maxY: 54.16 },
  sixYard: { minX: 99.5, minY: 24.84, maxY: 43.16 },
  thirds: { defensiveMaxX: 35, attackingMinX: 70 },
  halfway: 52.5,
} as const;

/** Five vertical lanes, 13.6 m each across the 68 m width. */
export const LANES = ['wide_left', 'halfspace_left', 'central', 'halfspace_right', 'wide_right'] as const;
export type Lane = (typeof LANES)[number];

export interface Point {
  x: number;
  y: number;
}

/** Piecewise-linear map between two sets of landmarks (both strictly increasing). */
function piecewise(from: readonly number[], to: readonly number[]) {
  return (v: number): number => {
    if (v <= from[0]!) return to[0]! + (v - from[0]!) * ((to[1]! - to[0]!) / (from[1]! - from[0]!));
    for (let i = 1; i < from.length; i++) {
      if (v <= from[i]!) {
        const t = (v - from[i - 1]!) / (from[i]! - from[i - 1]!);
        return to[i - 1]! + t * (to[i]! - to[i - 1]!);
      }
    }
    const n = from.length - 1;
    return to[n]! + (v - from[n]!) * ((to[n]! - to[n - 1]!) / (from[n]! - from[n - 1]!));
  };
}

/**
 * StatsBomb uses a 120 x 80 yard-like grid whose markings are not proportional to a real pitch.
 * Landmark mapping (goal lines, six-yard box, penalty spot, penalty box, halfway; box/six-yard/post widths)
 * keeps areas such as the penalty box aligned after conversion. Normalization v1.
 */
const SB_X = [0, 6, 12, 18, 60, 102, 108, 114, 120] as const;
const M_X = [0, 5.5, 11, 16.5, 52.5, 88.5, 94, 99.5, 105] as const;
const SB_Y = [0, 18, 30, 36, 40, 44, 50, 62, 80] as const;
const M_Y = [0, 13.84, 24.84, 30.34, 34, 37.66, 43.16, 54.16, 68] as const;
const sbX = piecewise(SB_X, M_X);
const sbY = piecewise(SB_Y, M_Y);
const round = (v: number) => Math.round(v * 100) / 100;

export const statsBombToCanonical = (x: number, y: number): Point => ({ x: round(sbX(x)), y: round(sbY(y)) });

export const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
export const distanceToGoal = (p: Point) => distance(p, PITCH.goalCentre);

export function laneOf(y: number): Lane {
  const idx = Math.min(4, Math.max(0, Math.floor(y / (PITCH.width / 5))));
  return LANES[idx]!;
}

export const inBox = (p: Point) => p.x >= PITCH.box.minX && p.y >= PITCH.box.minY && p.y <= PITCH.box.maxY;
export const inFinalThird = (p: Point) => p.x >= PITCH.thirds.attackingMinX;
export const inOwnThird = (p: Point) => p.x < PITCH.thirds.defensiveMaxX;
/** Touchline v1 zone 14: x in [70, 87.5), y in [22.67, 45.33). */
export const inZone14 = (p: Point) => p.x >= 70 && p.x < 87.5 && p.y >= 68 / 3 && p.y < (68 * 2) / 3;
export const thirdOf = (p: Point): 'defensive' | 'middle' | 'attacking' => (p.x < 35 ? 'defensive' : p.x < 70 ? 'middle' : 'attacking');
