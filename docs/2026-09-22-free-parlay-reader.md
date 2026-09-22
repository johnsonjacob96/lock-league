# Full-screenshot parlay reader

The owner required no new API costs. This replaces the proposed paid vision service with a browser-only spatial reader. Tesseract remains the text-recognition engine; the strip-to-flat-text import path is replaced. There is no provider key, paid OCR endpoint, new subscription, or server inference dependency. Images are processed on the device and the archive preview is sent to Lock League only when the user saves.

## Recognition and review

The reader processes the complete screenshot in grayscale, color-enhanced, and thresholded views. Word positions remain attached to the text throughout extraction. Market labels anchor nearby aligned selection blocks, in either title-first or market-first order. Thresholded images are used for header metadata because they can erase colored selection text. This avoids the previous Cash Out stopping rule, required matchup heading, and fixed strip boundaries.

The reader compares semantic fields across the two detail readings, preserves unresolved selections, checks printed pick/leg/selection counts, and flags conflicting or low-confidence fields. The reads share an engine and are not independent proof of correctness. A pixel-based stroke check excludes visibly crossed-out odds; ambiguous prices remain blank. Prices are never calculated from boost percentages or payouts.

Review shows the whole screenshot with numbered highlights linked to editable legs. A printed-count mismatch requires explicit reconciliation. Original evidence positions survive editing but are excluded from the saved pick payload. Failed scans preserve the existing draft; a successful scan with no candidates does not accidentally reuse the previous screenshot's legs. Manual entry remains available.

Team spreads now have signed lines, validation against a team in the selected game, and final-score grading. Common selected-game aliases such as LA Rams resolve to Los Angeles Rams. Grades compare the selected team's score margin plus handicap; equality is a push. Live or unavailable scores do not settle the leg. The screenshot does not supply league member assignments or an event date, so those remain user-selected.

## Actual supplied-image acceptance gate

The three complete screenshots are stored as received in `smoke/assets/parlay-images/`, including the resolution made available by the chat attachment. The expected values are manually labeled separately from the OCR inputs. No synthetic header or cropped substitute is used for this gate.

| Image | Exact selections | Active odds | Result |
| --- | --- | --- | --- |
| DraftKings, Cash Out above details | 8/8, including LA Rams -6.5 and game Over 47.5 | +9100 | Pass |
| FanDuel expanded, repeated summary and boost | 8/8, including two separate Josh Allen selections | +38132 | Pass |
| FanDuel compact seven-leg slip | 7/7, preserving inclusive 15+ and 6+ | +10087 | Pass |

All 23 subject/market/direction/threshold tuples, all three active prices, and all evidence regions passed actual browser recognition with no leg-review warnings. Local execution took approximately 5–9 seconds per supplied screenshot with cached engine assets; mobile speed is not established by those measurements.

These three slips are the owner's requested release gate, not a representative accuracy study or evidence of 95% accuracy across all books. Unseen layouts, clipped/blurred images, unusual market language, and model limitations can still need correction. Images above 12 million pixels or browser dimension limits produce an explicit error instead of quietly downscaling unreadable text. This is not a general multi-game or multi-slip importer.

## Validation

- `npm run smoke:parlay-images`: real recognition of all three supplied complete images.
- `node --test smoke/parlays-layout.mjs`: replays actual OCR word/geometry captures and checks reordered fields, two columns, unsupported/missing markets, numeric disagreements, split decimals, count mismatches, and ambiguous/crossed prices.
- `npm test`: existing backend tests plus the new extraction and spread validation/grading cases.
- `node smoke/parlays-ui.mjs`: upload, assignments, save, signed spread fields, full-image links, count reconciliation, and evidence exclusion at 375px, 390px, and 1440px.
- Existing standard, tall, logo, cropped, and reconstructed expanded OCR fixtures remain covered. The reconstructed fixture may correctly flag unreadable combined odds; that is separate from the exact full-image gate above.
- `npm run smoke` and `npm run smoke:render`: wider application regression checks.

`ocr.json` contains recorded Tesseract output for deterministic tests, not hand-authored recognition output. Refresh it deliberately with `CAPTURE_PARLAY_OCR=smoke/assets/parlay-images/ocr.json npm run smoke:parlay-images`; expected answers must continue to match the images. The optional workflow OCR run includes the complete-image gate. Test-only CDN transport caches the exact engine resources using curl to work around local browser certificate/download failures; it does not stub recognition. Production continues to load the existing Tesseract CDN resources directly.
