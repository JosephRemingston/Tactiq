import { PITCH } from "../../utils/pitch.js";
import file from "../../data/xt_grid_karun_singh_12x8_v1.json" with { type: "json" };

export const XT_GRID_ID = file.id;
/** Expected threat of a location (canonical metres), from the static 12 x 8 grid. */
export function xtAt(x, y) {
  const col = Math.min(file.cols - 1, Math.max(0, Math.floor((x / PITCH.length) * file.cols)));
  const row = Math.min(file.rows - 1, Math.max(0, Math.floor((y / PITCH.width) * file.rows)));
  return file.grid[row][col];
}
/** xT added by moving the ball from start to end. */
export const xtDelta = (x0, y0, x1, y1) => xtAt(x1, y1) - xtAt(x0, y0);
