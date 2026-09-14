# Screenshot parser reliability correction

Owner reported missing and incorrect legs in the first parser. The original OCR shrank the longest image edge to 1800px, destroying small text in tall screenshots. The text parser also assumed a single-line selection followed immediately by its market; missing subtitles could pull the next player's market into the wrong bet.

Changes:
- Read original-resolution, contrast-enhanced strips with overlap, preserving saturated blue text on charcoal. Do not OCR the compressed archive preview. Overlapping OCR lines are deduplicated by location; blank strips are safe. Stored previews preserve width/readability within the existing size cap.
- Parse player/selection/market blocks independently. Support wrapped player headers, market labels, directions and thresholds, compact `Over13.5`, repeated player subtitles, and inclusive N+ selections.
- Keep incomplete candidates with missing fields blank. Conflicting markets, broken numbers and low-confidence numeric text require correction, never an assumed market or decimal. Flag discrepancies when a printed leg count is available. No silent 25-leg truncation.
- Show an original screenshot crop for each detected leg. Mark unclear legs, require their fields to be completed and reviewed before saving. Crops and OCR diagnostics stay in the browser and are excluded from saved pick payloads.
- Split OCR and text parsing into dedicated browser files. Existing saved slips, assignments, grades, odds feeds and league competition are unchanged.

Validation: 150 backend tests; 341 existing logic/render checks; mobile/desktop upload, assignment, unresolved-field blocking and correction tests. Optional `node smoke/parlays-ocr.mjs` runs real Tesseract against deterministic standard (1083×1369) and tall (390×3100) blue-on-charcoal screenshots: all seven player/market/threshold combinations and source crops match. The previous implementation found zero legs on the same tall fixture; the revision finds seven. Includes separate parser regressions for wrapping, missing subtitles, unsupported markets and broken decimal text.

Limit: OCR still requires human review. There were no saved production slips to replay, so the exact unsuccessful upload was unavailable; tests use faithful layout/text fixtures, not a claim that every uploaded screenshot is now error-free. No paid provider or new account/binding was introduced.

## Follow-up: repeated subtitles and leading `y,`

Owner clarified that a title (`Kenneth Walker III Over +3.5`) and repeated-name market subtitle (`Kenneth Walker III - Total Receptions`) were becoming two legs, and OCR was inserting `y,` before names. Subtitle pairing now tolerates missing/misread Roman suffixes, separator variations and stray short logo tokens. Close spelling differences remain one candidate but require name review; clearly different players remain separate. A later same-player anytime-TD selection is still its own leg. Strip the leading single-letter-plus-comma marker without removing legitimate dotted initials such as J.K. or A.J. The original crop/text remains unchanged for comparison.

Regression cases cover exact title/subtitle pairing, suffix/logo/separator variations, split subtitles, spelling noise, `y,` in titles/subtitles/standalone names, different-player boundaries and separate same-player markets. Standard and tall real-OCR fixtures still return all seven correct legs.

### Logo fragments before player names
The owner identified jersey/team icons as the source of stray name prefixes. OCR now retains word bounding boxes and uses repeated subtitle names plus spatial separation, oversized glyphs or low-confidence graphic tokens to filter leading logo text before parsing. Short standalone icon text is also removed when positioned left of a corroborated player line. No blanket first-token deletion; initials, numeric thresholds and uncorroborated text are preserved.

Added a real Tesseract fixture with jersey silhouettes and circular team badges. It reproduced `Teo Kenneth Walker III` before the fix; all seven exact player names, markets and thresholds now pass, alongside standard and tall fixtures. Geometry regression cases preserve RJ/J.K. and detached numeric thresholds. Original image crops remain available for review. These are deterministic fixtures, not the owner's original image file; ambiguous OCR still needs review.
