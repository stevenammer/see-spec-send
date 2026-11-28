# The exhaustive rule check

`test/exhaustive-rules.test.mjs` runs the real `core/machine.js` through every sequence of events a small cast can produce, up to 8 events deep (about 480,000 distinct states and 15 million attempted transitions, about 20 seconds), and checks these rules on every state it reaches:

- Nobody who shaped the work counts toward "it helps": the poster, any steward, the spec author, the approver, or whoever delivered the try by hand.
- Only a `helped` event reaches HELPS, only at quorum, and only with a try in place. Nobody can mark it done by hand.
- A build starts only on approval by a leader who isn't an author.
- Spending never passes the approved cap.
- Only a leader can change the steward. Integrations, agents, the gateway and the build run never get person authority.
- A terminal state (HELPS, SHELVED) is never left, and a fork never inherits an approval.

The cast: three members, two leaders, a gateway, a build run, an integration and an agent. Candidate events include forgeries on purpose: a stale artifact, a forged spec hash, and person moves made by non-person principals.

## What it is and isn't

It's a bounded model check, not a proof. It covers every ordering of these event types for this cast up to the depth, which scenario tests can't, but a bug that needs a longer sequence or more people could still hide. Raise the depth with `RULE_CHECK_DEPTH=9` (much slower).

The check is itself checked: three tests run it against deliberately broken machines (no helper eligibility, any person can approve, no spending cap) and require it to catch each one.

A machine-checked proof of the same rules (for example in Lean) is the next step, and only worth doing because this check shows the rules are written down correctly.
