# Machine

The table is the machine oracle. `open` means every state except `HELPS` and
`SHELVED`; a steward alternative requires that state to already have a steward.
Each event has an actor id, timestamp, and idempotency key. An event
never carries a role. The store resolves the actor from its authority table
before it calls the machine.

`member` is any registered person. `leader` is a registered person flagged as
a leader. The steward is state-derived: the person who made the first `checked`
event, until a leader makes `steward_changed` naming another registered person.
`gateway` and `run` are registered tokens scoped to exactly one item. An
`approver` below means the person recorded by `approved`, not an actor role.
People have no counters. Role checks marked with a condition are additional to
the listed role. `commented`, `steward_changed`, and `erased` preserve state.

| From | Event | Role | Next |
| --- | --- | --- | --- |
| SEEN | checked | member | CHECKED or SHELVED when verdict is already_have |
| CHECKED | specced | steward | SPECCED |
| SPECCED | specced | steward | SPECCED |
| SENDING | specced | steward | SPECCED |
| TRYING | specced | steward | SPECCED |
| SPECCED | approved | leader, not steward | SENDING |
| SPECCED | returned | leader | CHECKED |
| SENDING | charged | gateway | SENDING |
| SENDING | tried | run | TRYING |
| SENDING | failed | run | SPECCED |
| TRYING | failed | run | SPECCED |
| TRYING | helped | member, neither steward nor approver | TRYING or HELPS at frozen quorum |
| open | shelved | leader or steward | SHELVED |
| open | commented | member | unchanged |
| open | steward_changed | leader | unchanged |
| open | erased | leader or steward | unchanged |

`checked` requires `looked` with at least one entry, `found` as an array, and
`verdict` of `already_have`, `setting`, `free`, `pay`, or `build_needed`.
`specced` requires `must` and `out_of_scope` arrays and `how_we_know` with at
least one entry. `approved` requires a nonempty `spec_hash`, finite nonnegative
`cap_usd` with no more than six decimal places that fits in safe integer
micro-dollars, and integer `quorum` of at least one. `returned` and `shelved`
require a nonempty note or reason. `charged` requires finite nonnegative `usd`
with the same micro-dollar rule. The machine stores and compares budget values
as integer micro-dollars.
`tried` and `helped` require a nonempty artifact hash. The approval freezes its
cap and quorum. Helpers count only once each and only for the current artifact.
`helped` is refused for the steward and approver. `erased` names a body hash,
uses a steward or leader's actual timestamp, records its receipt, and then only
that item's body bytes may be removed. Body hashes include the item id.

Each `approved` event advances the item's approval counter. Its `build.start`
effect carries that counter, the approved spec hash, and the approved cap.
Every builder-originated `charged`, `tried`, and `failed` event must carry the
same `approval` counter and `spec_hash` as the current approval. A token from a
previous approval is refused and cannot charge the newer cap or deliver an
artifact.

There is no done event. `HELPS` and `SHELVED` are terminal.
