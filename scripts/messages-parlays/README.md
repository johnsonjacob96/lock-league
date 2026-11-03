# Monday / Thursday Messages import

Local macOS automation for the league owner's existing Messages conversation.
This is separate from the Cloudflare app scheduler: the cloud cannot read this
Mac's Messages database. No website or pick behavior changes.

The LaunchAgent checks at 7:30 PM America/Chicago each Monday/Thursday, with one
retry no earlier than 8:30 PM (and at least an hour after the first attempt).
Quarter-hour wakeups do only a local due-date check outside those windows. It
catches up after sleep/login, including missed dates since installation. It
requires this Mac, a logged-in user session, synced Messages attachments, network
access, and valid existing Codex/Cloudflare OAuth sessions.

## What gets imported

- The first **placed receipt** for that date, not a builder or later replacement.
- Actual receipt lines, boosted odds, and screenshot; plus assignments evidenced
  by the originating pick thread. Contacts resolves message authors to members.
- Only included legs: an absent member gets no pick, not a synthetic loss. Jack
  was absent October 8; he is not excluded from future slips.
- `6+` / `180+` are `atleast`, not `over`. Game totals, team spreads/moneylines,
  and the app's supported player markets use the app's normal validation.
- Normal parlay refresh handles live stats and final grading after import.

Existing nightly imports are skipped without model usage. A stable receipt UUID,
local process lock, database transaction lock and guarded insert prevent repeats.
No existing slip, league pick, wager, payment or group-chat message is modified.
Ambiguous owners, missing/cropped legs, unreadable earlier images, unsupported
markets and validation failures require review rather than guesses. Two failed
attempts generate an own-device notification. A privacy block does not consume
attempts; imports resume after access is enabled.

## Installation

1. Existing prerequisites: Node, Python 3.9+, npm, Wrangler CLI OAuth login, Codex
   CLI ChatGPT login, and Contacts/ Messages synced on this Mac.
2. Private configuration lives at
   `~/Library/Application Support/LockLeagueParlay/config.json`. Required keys:
   `start_date` (YYYY-MM-DD), exact Messages `chat_identifier`, `self_member`,
   Cloudflare `account_id`, executable paths `node`, `wrangler`, `codex`, and
   `contact_members` mapping verified full Contact names to app member names.
   Do not commit that file, phone numbers, Messages excerpts or receipt images.
3. Run `python3 scripts/messages-parlays/install.py`. It copies versioned scripts
   and app validation helpers to the private runtime, installs the pinned Neon
   client, and loads `com.lockleague.parlay-import` in the user's LaunchAgents.
4. In macOS Settings → Privacy & Security → Full Disk Access, add the **actual**
   Python executable printed by `python3 -c 'import sys; print(sys.executable)'`.
   On the owner's Mac this is
   `/Library/Developer/CommandLineTools/usr/bin/python3`.
   This privacy change requires the owner. Do not edit TCC databases or bypass it.
5. Test from launchd, not only an interactive terminal: the latter can inherit
   permission from the coding app. Use the same LaunchAgent executable with
   `run.py --probe`, then restore the scheduled arguments. The probe only reads
   this group's Messages, Contacts mappings, app members and that day's games.

The model receives only the bounded group context/images and public app metadata.
It runs `codex exec --ignore-user-config --sandbox read-only --ephemeral` with a
strict JSON schema and a no-tools extraction instruction. A separate deterministic
bridge gets the database URL in memory from Cloudflare's existing OAuth session;
the extraction prompt never contains credentials. OAuth renewal uses Wrangler.
No API key, GitHub token or new hosted service is required. Codex usage counts
against the owner's existing plan. See [official non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode).

## Operations

Runtime directory is owner-only (0700); state, run context, extracted JSON and
private JPEGs stay there. They are not committed or publicly hosted. `state.json`
records each scheduled date, `health.json` records permission blocks, and macOS
notifications flag review/failure. Notifications depend on this Mac's settings.
The app's authenticated slip image storage contains only the selected receipt.

```sh
# Synthetic regression checks, safe in CI (no Messages, model or production access)
python3 -m unittest discover -s scripts/messages-parlays -p 'test_*.py'
node --test scripts/messages-parlays/test_publish.mjs

# Read-only replay, including live extraction; never writes the app by default
python3 "$HOME/Library/Application Support/LockLeagueParlay/scripts/messages-parlays/run.py" --date 2026-10-08

# Check registration / stop the schedule
launchctl print "gui/$(id -u)/com.lockleague.parlay-import"
launchctl bootout "gui/$(id -u)/com.lockleague.parlay-import"
```

After correcting an ambiguity or login problem, replay the date without `--save`
and inspect its result first. `--date YYYY-MM-DD --save` explicitly enables import
and still uses duplicate guards. To retry an exhausted scheduled date, remove only
that date's entry from `state.json`; do not delete existing production slips.

## October 12 validation

24 synthetic scheduler/import guardrail tests and 26 existing app parlay tests
passed. Full October 8 screenshot/thread replay independently recovered the first
seven-leg +45000 receipt, every exact threshold and owner, with Jack absent. The
production duplicate guard returned `already_exists`; no row was changed.
The interactive health probe passed (eight members, one Monday game). The launchd
probe exposed macOS's separate Full Disk Access requirement; scheduling is
installed, but unattended access must be enabled and verified before calling the
automation fully ready.
