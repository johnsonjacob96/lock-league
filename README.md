# Lock League

Modern bettor dashboard for the Lock League NFL pick group.

- **Members:** 8 (Brayden, Chase, Chris, Jack, Jacob, Jared, Mason, Tyler)
- **Seasons tracked:** 2023, 2024, 2025
- **Bet categories:** Favorite, Dog, Over, Under, Super 🔒
- **Source of truth:** Google Sheet (`Lock League`) — picks + W/L color-coded by cell fill

## Stack

- Single-page vanilla HTML/JS
- Data baked into `data/seasons.json` (extracted from the sheet's XLSX export)
- Hosted on GitHub Pages

## Updating data

When the source sheet changes, re-run the extractor:

```
python3 data/extract.py
```

(Expects `/tmp/lock-league/lock-league.xlsx` — re-export from Drive first.)

Cell colors map to outcomes:
- `93C47D` / `B6D7A8` → W (green)
- `E06666` → L (red)
- `FFD966` → P (push, yellow)
