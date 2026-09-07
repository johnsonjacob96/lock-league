# Venmo collections and season payouts

All season entries, weekly buy-ins, and payouts now use Venmo through the configured banker (Jared). Obsolete payment-provider references were removed from the app, rules data, APIs, and readiness documentation.

- Season entries ($100) have a separate ledger from existing weekly buy-ins ($90). Existing weekly records are preserved.
- End-of-season prizes default to $500/$200/$100. The banker confirms recipients after final standings/ties are resolved, then opens each recipient's Venmo payment link. Recipients must save their own handle in Account.
- Only the banker can assign recipients. The banker or assigned recipient can record payment/receipt or undo it. Paid awards cannot be reassigned without undoing payment status; duplicate recipients and stale recipient updates are rejected.
- Opening a link does not mark a payment paid or move funds automatically. No money or test payments were sent.
- Jared still needs to enter his Venmo handle in Account before collection links can open his payment destination.

Validation: 68 backend tests; 139 logic/browser checks including payment destinations, amounts, permissions, separate ledgers, and 390px layout. New ledgers are created by idempotent migrations. The unused legacy URL database column is left inert to avoid destructive schema changes.
