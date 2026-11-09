# Machine

The table is the machine oracle. `open` means every state except `HELPS` and
`SHELVED`. Role checks marked with a condition are additional to the listed
role. `commented`, `steward_changed`, and `erased` preserve the state.

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
| open | erased | member | unchanged |

`checked` requires `looked` with at least one entry, `found` as an array, and
`verdict` of `already_have`, `setting`, `free`, `pay`, or `build_needed`.
`specced` requires `must` and `out_of_scope` arrays and `how_we_know` with at
least one entry. `approved` requires a nonempty `spec_hash`, finite nonnegative
`cap_usd`, and integer `quorum` of at least one. `returned` and `shelved`
require a nonempty note or reason. `charged` requires finite nonnegative usd.
`tried` and `helped` require a nonempty artifact hash. The approval freezes its
cap and quorum. Helpers count only once each and only for the current artifact.

There is no done event. `HELPS` and `SHELVED` are terminal.
