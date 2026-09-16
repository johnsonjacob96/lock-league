# Better-line push audit

Jacob reported seeing Lions/Bills Under improve from53.5 to54.5 in My Card without a phone alert, and no remembered notifications since installation.

Production read-only findings:
- Jacob has two stored subscriptions: Apple Web Push and Google/desktop, both created August7. All notification categories default enabled; none opted out.
- All eight subscription encryption keys and the VAPID signing pair pass local validation. This does not prove delivery or display on a physical phone.
- Cloudflare's deployed scheduler schedule/configuration is present. Scheduler → app health and line-move dry runs both return200. No historical per-device delivery receipts exist to prove the earlier alert attempt.
- Line checks ran only at16:00/23:00UTC (11am/6pmCDT). My Card reads live odds separately; a visible improvement does not trigger an immediate push.
- The current saved Under is already54.5 with alert_lineNULL, so the present dry run finds no improvement. The original53.5 selection was replaced and cannot be reconstructed from the current row.
- Code marked every candidate alert_line after sending, including failed deliveries and members without opted-in devices. That could permanently suppress a later retry.

Changes:
- Single15-minute Cloudflare trigger for better-line checks; original reminder/kickoff slots preserved. Existing cutoff, started-game, half-point threshold and dedupe guards remain. Uses existing board cache/provider budget; no new odds service.
- Only members with at least one push-service-accepted delivery consume the alert threshold. Failed/unsubscribed/opted-out recipients remain eligible. Guard the update against a changed game/side/line while sending.
- Bounded10second push request,10second board read and30second scheduler request. Aggregate status counts logged without endpoints/keys; scheduler observability enabled.
- Test button distinguishes rejection from absent devices, and reports partial device failures.

Limits: push-service acceptance is not proof that iOS displayed a notification. One successful device stops member-level retries to avoid duplicating desktop alerts; it cannot prove the second device received it. Existing weekly result/reminder send claims are unchanged. Phone-test permission requested separately; no real test/league notifications were manually sent during this audit.

Validation: mocked transport tests cover successful/failed/expired/opted-out devices, retry eligibility, guarded marker update and quarter-hour/original reminder dispatch. Worker must deploy separately from Pages after merge.
