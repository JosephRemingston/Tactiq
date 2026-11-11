"""Independent recomputation of key metrics from raw StatsBomb files (stdlib only, no Touchline code).

    python3 -I scripts/hand_check.py test/fixtures/statsbomb 3869685 8658

PPDA thresholds are the StatsBomb-grid equivalents of Touchline's 63 m / 42 m lines under the landmark mapping:
x <= 72.25 (opponent's own 60%) and x >= 47.75 (our pressing zone).
"""
import json
import sys

SET_PIECES = {"Corner", "Free Kick", "Throw-in", "Goal Kick", "Kick Off"}


def check(root, match_id):
    events = json.load(open(f"{root}/events/{match_id}.json"))
    teams = []
    for e in events:
        if e["team"]["name"] not in teams:
            teams.append(e["team"]["name"])
    out = {}
    for team in teams:
        opp = next(t for t in teams if t != team)
        reg = [e for e in events if e["period"] <= 4]
        shots = [e for e in reg if e["type"]["name"] == "Shot" and e["team"]["name"] == team]
        goals = sum(1 for s in shots if s["shot"]["outcome"]["name"] == "Goal")
        own_for = sum(1 for e in reg if e["type"]["name"] == "Own Goal For" and e["team"]["name"] == team)
        xg = sum(s["shot"].get("statsbomb_xg", 0) for s in shots)
        passes = sum(1 for e in reg if e["type"]["name"] == "Pass" and e["team"]["name"] == team)
        opp_passes = sum(
            1
            for e in reg
            if e["type"]["name"] == "Pass"
            and e["team"]["name"] == opp
            and e["pass"].get("type", {}).get("name") not in SET_PIECES
            and e["location"][0] <= 72.25
        )
        def_actions = sum(
            1
            for e in reg
            if e["team"]["name"] == team
            and "location" in e
            and e["location"][0] >= 47.75
            and (
                (e["type"]["name"] == "Duel" and e["duel"].get("type", {}).get("name") == "Tackle")
                or e["type"]["name"] in ("Interception", "Foul Committed")
            )
        )
        pens = [e for e in events if e["period"] == 5 and e["type"]["name"] == "Shot" and e["team"]["name"] == team]
        out[team] = {
            "shots": len(shots),
            "goals": goals + own_for,
            "xg": round(xg, 3),
            "passes": passes,
            "ppda_num": opp_passes,
            "ppda_den": def_actions,
            "ppda": round(opp_passes / def_actions, 2) if def_actions else None,
            "shootout_goals": sum(1 for p in pens if p["shot"]["outcome"]["name"] == "Goal") if pens else None,
        }
    return out


if __name__ == "__main__":
    root = sys.argv[1]
    print(json.dumps({m: check(root, m) for m in sys.argv[2:]}, indent=1))
