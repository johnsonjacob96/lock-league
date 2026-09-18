# Saying it out loud when a Super Lock is gone

A member tried to lock Ja'Marr Chase anytime TD after someone else had already claimed it. The save was correctly refused, but the panel appeared to do nothing: the tap produced no message, so the app looked broken rather than strict.

The rejection was in fact reported. `409 super-lock-taken` was written into `#mycard-sl-msg`, which sat at the very bottom of the scrolling prop list in muted hint grey, while the lock button lives in a bar pinned below that scroll container. The reply landed a few hundred pixels below the fold, under a list nobody scrolls after tapping Lock. A toast could not have rescued it either — the panel is a top-layer `<dialog>`, so a toast paints behind its backdrop.

The message now lives in `superLockState`, is rendered by `slPanelHtml`, and is lifted out of the scrolling body to sit directly above the lock button, styled as an alert rather than a hint. It survives the panel's re-renders, and every rejection routes through it: an already-claimed bet, a moved line, a passed cutoff, a started game, a failed network call. Changing the selection clears it; closing the panel clears it.

An already-claimed bet gets its own message naming the bet in plain English ("Jalen Hurts Over 50.5 rushing yards"), not the canonical `o50.5 rush yds` text the claim key is built from, and it states the rule: first lock wins, at any book and any line. The browser also remembers the claim. `slClaimKey` mirrors the server's `ll_super_lock_key`, so the same bet is recognised at any book, any line and any wording: the side reads "Already picked" in the prop list, its alternate lines are marked, the opposite direction stays lockable, and the lock button goes dead with "Already picked — choose another bet" instead of accepting a tap that cannot succeed. The unique index remains the only arbiter — the client key is an early warning, so a near-miss costs a hint, never a wrong save.

`smoke/super-lock-panel.mjs` covers the new copy, the message's placement beside the lock button, the disabled button, the marked sides and alternates, the untouched opposite direction, and the message clearing on a new selection.
