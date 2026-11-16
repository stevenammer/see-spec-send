# Stage posts: rules 3 contract

Rules 3 gives each active SEE, SPEC, SEND review, and TRY/artifact discussion a post identity and version. The append-only event log remains the source of truth. `stage_posts` and `closeout_jobs` are derived projections rebuilt from that log.

## Active post and version binding

- Each rules 3 item has at most one active conversational post. The active post is recorded in the reconstructed context as `{ id, kind, version }`.
- A comment or revision must carry the active `post_id` and exact `post_version`. Comments must also target the active post kind. A spec submission must bind to the active SEE or SPEC as allowed by the transition.
- The server requires the browser’s rendered `x-post-id` and `x-post-version` binding for rules 3 writes. The core state machine checks the event binding again; hiding a stale form is not the security boundary.
- If a submitted write refers to an old post or version, it is refused with HTTP 409 and `frozen or superseded post`. Workers also reject stale queued replies instead of moving them to a newer post.

## Transition, snapshot, and close-out queue

When an event advances a rules 3 item, the store transaction updates the event log and projections together:

1. Close the prior post at its final event sequence and bind it to that event’s hash as `snapshot_hash`.
2. Create the successor post with a link to its predecessor. A formal decision event also gets its own frozen decision identity.
3. Queue an idempotently keyed close-out row for the frozen post and snapshot hash.
4. Commit all of the above atomically. If projection or close-out insertion fails, the event append and transition roll back, leaving the prior post active.

The close-out row starts as pending work. The deterministic close-out consumer can produce a hash-addressed, source-linked frozen-post report and mark that row done. It does not provide model extraction, citation review, a searchable knowledge record, or a human correction workflow. A pending job is not evidence that a report was produced.

The current decision projection follows existing event types and workflow. It does not yet implement the complete proposed NO disposition/reason taxonomy. Likewise, SEE/SPEC/SEND and TRY lifecycle protection does not itself authorize a build, grant spend, or define a production deployment permission.

## Frozen history and forks

- A frozen post remains readable through stage history and its hash-bound snapshot. Its thread has no active comment or revision controls. The steward may credit an unerased historical comment when explicitly adopting it into the current SPEC; that changes the active SPEC, not the frozen source. Replies must remain within their own post.
- A fork from a frozen stage must identify both the exact `post_id` and `snapshot_hash`, plus a reason. This prevents a shared event hash from ambiguously selecting a different post identity.
- Fork history stops at that selected snapshot. The child is a new item/branch with independent authority: prior approval, spend, HELPS eligibility, or permission is not inherited.
- History export/import and projection rebuild preserve the post IDs, parent/successor links, exact frozen hashes, and queued close-out state. Erasure changes the source representation under the existing audited erasure behavior; it is not ordinary editing of frozen history.
- A frozen packet copy, an exported copy, and an operator backup can outlive an erasure. The trace identifies that limit; erasure tombstones derived views and future delivery, but it doesn't claim to rewrite copies outside the live store.

## Stewardship transfer on inactivity

- Stewardship stays on the same item and branch. It preserves the original author's attribution and does not inherit or broaden approval, spend, helper, or tool authority.
- A person with their own `unresolved_after_window` alternative may file a visible `transfer_request` comment only when the current steward has had no authoring event on the active stage for the same 14-day reconciliation window. The response reports the active-stage inactivity date and eligibility.
- A request is not a transfer and silence is not consent. The request route cannot change the steward. A leader records any actual transfer through the existing, reasoned `steward_changed` event, whose server-side validation also applies active-stage inactivity unless the steward recorded consent.
- Different direction alone is not grounds for transfer. A real unresolved disagreement remains the only reason to fork.

## Legacy compatibility

Rules 3 stage projections are reconstructed from rules 3 events. Older rules 1/2 histories remain readable and replayable; their historical transitions did not record stage-post identities or freeze snapshots, so the migration does not invent those missing historical posts. The UI identifies legacy records accordingly. Existing event hashes, approvals, charges, artifacts, comments, and fork lineage must continue to verify after migration and import.

## Verification scope and limits

Active-thread reanalysis replies are out of scope for this slice. The matcher targets frozen posts only; linked updates render outside the frozen thread.

`test/stage-freeze.test.mjs` covers stale post/version writes, server-side 409 refusal, old-thread read-only rendering, atomic rollback on close-out queue failure, delayed Effort refusal, exact snapshot forks, migration/export-import rebuild, and frozen TRY/HELPS behavior. These tests validate lifecycle state and queue integrity; they do not prove an E.F.F.O.R.T. close-out worker or broad organizational-intelligence behavior exists.
