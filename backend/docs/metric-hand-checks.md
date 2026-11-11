# Metric hand-checks

Key values recomputed independently from the raw StatsBomb files with `backend/scripts/hand_check.py`
(Python standard library only, no Touchline code), then compared with the backend calculators.
**All 32 values match** (last run 2026-11-11).

```bash
python3 -I backend/scripts/hand_check.py backend/test/fixtures/statsbomb 3869685 8658
```

| Match | Team | Shots | Goals | xG (StatsBomb) | Passes | PPDA (opp passes / def. actions) | Shoot-out goals |
|---|---|---|---|---|---|---|---|
| 2022 World Cup final (Argentina 3-3 France, 4-2 pens) | Argentina | 20 | 3 | 2.758 | 693 | 368 / 37 = 9.95 | 4 |
| 2022 World Cup final (Argentina 3-3 France, 4-2 pens) | France | 10 | 3 | 2.273 | 570 | 441 / 36 = 12.25 | 2 |
| 2018 World Cup final (France 4-2 Croatia) | France | 8 | 4 | 1.098 | 292 | 341 / 13 = 26.23 | - |
| 2018 World Cup final (France 4-2 Croatia) | Croatia | 15 | 2 | 1.48 | 554 | 201 / 22 = 9.14 | - |

Notes:
- Shots, goals and xG exclude the penalty shoot-out (period 5); goals include "Own Goal For" events, which is why
  France's 2018 total of 4 includes Mandzukic's own goal.
- PPDA uses Touchline v1: opponent open-play passes starting at StatsBomb x <= 72.25 (63 m on the canonical pitch)
  divided by tackles (any outcome), interceptions and fouls committed at x >= 47.75 (42 m). Values differ from
  sites that include pressures or use other zones; that is expected and documented in the metric definition.
- The unit suite (`test/unit/analytics.spec.ts`) also checks a hand-built 17-event match with exact expected values.
