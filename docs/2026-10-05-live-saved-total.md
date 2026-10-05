# Live tracker used 49 instead of a saved 46.5

Jacob’s Week 4 pick 2461 is saved as `Denver Broncos / San Francisco 49ers O46.5`, line 46.5, side over. The Live UI’s unbounded, case-insensitive O/U regex matched `o 49` inside `Francisco 49ers` before reaching the actual O46.5 token. Both the progress bar and dropdown used this parser. Grading uses the database’s saved line and was unaffected. No production records changed.

The warroom API now includes the revealed pick’s original line and side. A shared client helper prefers those saved fields (including numeric strings and zero), then structured Super Lock metadata. Legacy text fallback requires a separate O/U token at the end. Invalid saved fields stay unresolved. Both progress and dropdown use this helper. Spread parsing also requires its numeric token at the end, preventing the same 49ers team-name issue.

Regression coverage includes the exact incident, either team order, Over/Under, a saved line overriding display text, game-total Super Locks, zero/invalid lines, 47 points crossing 46.5, and 49ers spreads. Existing result colors, layout, and provider polling are unchanged.
