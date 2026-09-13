# Live records show settled results only

Owner rejected score-based projections: an under looks like a win early simply because the game is unfinished. The live API now keeps all unfinished game picks pending; only final results enter W/L/P. Stored grades and final-score grading remain unchanged.

The Live leaderboard and league cards rank/display fW/fL/fP, including when a previously cached response still has projected W/L/P. Projection badges/copy are removed. Open counts include unfinished and unrevealed slots. Score, clock, player stats, progress, participant selection, and final result styling remain.

Validation: 122 backend tests and 341 logic/render checks. New backend cases cover live scores above/below/equal to lines and final W/L/P; ranking fixture deliberately contains a conflicting projected record to prove only settled results determine rank. No additional odds API calls or services.
