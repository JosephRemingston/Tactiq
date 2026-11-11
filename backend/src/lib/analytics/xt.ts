import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PITCH } from '../pitch';

interface XtGridFile {
  id: string;
  rows: number;
  cols: number;
  grid: number[][];
}

const file = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'data', 'xt_grid_karun_singh_12x8_v1.json'), 'utf8')) as XtGridFile;
export const XT_GRID_ID = file.id;

/** Expected threat of a location (canonical metres), from the static 12 x 8 grid. */
export function xtAt(x: number, y: number): number {
  const col = Math.min(file.cols - 1, Math.max(0, Math.floor((x / PITCH.length) * file.cols)));
  const row = Math.min(file.rows - 1, Math.max(0, Math.floor((y / PITCH.width) * file.rows)));
  return file.grid[row]![col]!;
}

/** xT added by moving the ball from start to end. */
export const xtDelta = (x0: number, y0: number, x1: number, y1: number): number => xtAt(x1, y1) - xtAt(x0, y0);
