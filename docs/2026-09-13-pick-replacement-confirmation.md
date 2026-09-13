# Pick replacement confirmation

Replacing a saved Favorite, Dog, Over, Under, or Super Lock now opens a confirmation with the current and new bet, sportsbook, and odds. Keep current pick is focused by default; cancel/Escape never submits a write. First selections still save directly.

Board selection matching includes the saved line and price, so the same team at a moved quote is treated as a replacement instead of the old pick's toggle. Duplicate board clicks are ignored while confirming/saving. Existing server kickoff, cutoff, quote validation and Super Lock exclusivity remain in force.

Validation: dedicated mocked-write browser checks at 390/1440px cover comparison content, cancel, Escape, focus, duplicate clicks, confirmed payload, first selection, and cancellation through all three Super Lock paths. Added this script to CI. Existing picker tests explicitly accept replacements. No production picks were submitted during testing.
