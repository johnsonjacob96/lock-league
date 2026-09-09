# Article 10 — first Super Lock claim wins

Jacob confirmed that the same player, stat and Over/Under is the same Super Lock across sportsbooks and changing lines. The first successful save owns the bet. Different players, stats or directions remain distinct. A member may update their own line; changing/removing an unlocked pick releases the previous selection.

`functions/_shared/super-lock-claims.js` installs an immutable canonical-text function and a unique PostgreSQL index across season/week/selection for 2026 onward. The index covers existing picks and all writes; races cannot produce two owners. Canonical server text and common full-form custom wording normalize book names, prices, thresholds, capitalization, punctuation, player suffixes and word order. All supported prop stat names have matching regression cases. Free text still needs an identifiable player/team and bet; arbitrary prose or nicknames cannot be fully understood as a structured market.

The API catches the index conflict and returns `409 super-lock-taken` with a clear message. The existing confirmation panel displays it while keeping the draft. The full multi-pick transaction rolls back on conflict, preserving the losing member's old card. Historical 2023–25 picks, ordinary pick sharing, kickoff/cutoff protections and grading remain unchanged. No claim-owner name or other unrevealed picks are returned.

Regression coverage includes simultaneous submissions, existing ownership, different books/lines, common custom wording for every supported stat, opposite directions/stats, owner updates, removal/reclaim, full-card rollback, week scoping and historical/ordinary picks. The live predeployment audit found three distinct existing Super Locks; none needed removal.

## Final odds follow-up

Schedule retention now runs before ESPN supplementation as well as before rendering. An entire matchup omitted by Sharp can therefore receive an explicitly identified current DraftKings quote from ESPN. ESPN-only event IDs are not passed to the Sharp props endpoint. Missing or stale sources still remain explicit; this does not promise permanent sportsbook availability.
