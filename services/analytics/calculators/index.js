import { PassingCalculator } from "./passing.js";
import { PlayerCalculator } from "./player.js";
import { PossessionCalculator } from "./possession.js";
import { PressingCalculator } from "./pressing.js";
import { ProgressionCalculator, XtCalculator } from "./progression.js";
import { ShapeCalculator } from "./shape.js";
import { ShootingCalculator } from "./shooting.js";
import { TransitionCalculator } from "./transitions.js";
export const CALCULATORS = [
  new PossessionCalculator(),
  new PassingCalculator(),
  new ProgressionCalculator(),
  new XtCalculator(),
  new PressingCalculator(),
  new TransitionCalculator(),
  new ShootingCalculator(),
  new ShapeCalculator(),
  new PlayerCalculator(),
];
/** Runs every calculator whose coverage requirement the match meets (PDF: data availability is a runtime capability). */
export function runCalculators(ctx, calculators = CALCULATORS) {
  const drafts = [];
  const ran = {};
  const skipped = [];
  for (const c of calculators) {
    const missing = ["events", "lineups", "freezeFrames", "tracking"].filter(
      (k) =>
        c.requires[k] &&
        !ctx.coverage[
          k === "events" ? "hasEvents" : k === "lineups" ? "hasLineups" : k === "freezeFrames" ? "hasFreezeFrames" : "hasTracking"
        ],
    );
    if (missing.length) {
      skipped.push({ key: c.key, reason: `missing ${missing.join(", ")}` });
      continue;
    }
    drafts.push(...c.compute(ctx));
    ran[c.key] = c.version;
  }
  return { drafts, ran, skipped };
}
