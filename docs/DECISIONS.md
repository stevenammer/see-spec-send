# Decisions

Settled choices and the reason in one line. Newer rows replace older ones where noted.

| Date | Decision | Why | Replaces |
| --- | --- | --- | --- |
| 2026-11 | Build the forum first as the complete product. Other channels follow. | One set of rules proven end to end before adapting them. | Earlier chat-first ordering |
| 2026-11 | Nine decision outcomes: approve, return, defer, redirect, resolve without build, decline, prohibited, experiment did not help, author withdrew. | Different reasons need different next steps. | One generic no |
| 2026-11 | A decision is one immutable record, shown on its own and referenced from the build. A deferral needs a review date or a trigger. No automatic reminders. | Accountability without nagging. | |
| 2026-11 | A fork needs a real disagreement. It opens when the steward moves on without including the alternative, when 14 days pass, or when the steward declines it. A fork inherits no approval or spending. | Give people time to agree. | Forking at any time |
| 2026-11 | A quiet branch can change stewards instead of forking. A leader decides, work is stopped and a fresh approval is required. | Keep work going without inheriting authority. | |
| 2026-11 | Records created under rules 3 are additive. Older records keep their original behavior and hashes. | Never rewrite history. | |
| 2026-11 | Closeout reports are deterministic extracts that point back to source records. | No invented summaries. | |
| 2026-11 | Free and local models only for now, with an offline fallback for every AI step. | Keep cost at zero while the design settles. | |
| 2026-11 | Reanalysis starts with internal results only. | Prove the loop before adding outside sources. | |
| 2026-11 | At most one reanalysis notice per person per day. | Avoid noise. | |
| 2026-11 | Reflection after a decision is private and local to the person's device. | The system should have nothing to report about it. | |
| 2026-11 | Mentoring stays between people and is not tracked or analyzed. | Trust. | An AI mentor-matching idea |
| 2026-11 | The first coding-agent trial is one MIT-licensed open-source agent behind the metered proxy. | Measure before choosing a default. | |
| 2026-11 | "Public" means the appropriate audience inside the organization. | Confidential cases need narrower channels. | |
| 2026-11 | Model-built pages that need scripts run on a separate, isolated origin. Without one, testers get a script-free page. | A build's code is untrusted and must not reach the app's cookies or data. | Script-free only |
| 2026-11 | A later result that touches an earlier decision becomes a dated, linked update. The earlier record never changes, and asking for a new decision opens a separate case. | Nobody is asked to change their mind, only to decide again on new information. | |
| 2026-11 | A derived record can be challenged by anyone who can read it, and erasing a source removes what was built on it. The source is never edited. | Correctable memory without rewriting history. | |
| 2026-11 | Questions to the organization are saved with their sources and criteria so anyone with the same access can re-run and contest them. Ranking or motive questions get criteria, outcomes and unknowns. | The same evidence standard at every level, with no scoring of people. | |
| 2026-11 | Restricted work shows other people only that it exists and who to ask. | Departments need boundaries that hold before anything is retrieved. | Workspace-wide reading |
| 2026-11 | A model answer that is malformed, invents a citation, or only repeats the template is refused and the person sees the sources with a note saying why. The question, objectives and constraints always come from the human's request. | The model must never restate or drop what the person asked. | |
| 2026-11 | Sign-in through an identity provider proves who someone is and nothing more. People are provisioned as members only if an operator turns that on, and leaders are made only by the admin CLI. | Authentication must not become authority. | |
| 2026-11 | Content may flow from one case into another's audience (updates, comments, digests) only if everyone who can read the target can read the source. | A summary must not become a leak. | |
| 2026-11 | An import never carries current leader authority; leaders are promoted again on purpose. Exports can be signed and an import can require the signature. | A file is not an authority: it can name anyone. | |
| 2026-11 | Erasing text removes it from stored packets, closing reports, saved answers, the ledger and source copies, not only from the page. | Erased means gone from this database, with older backups the one stated exception. | |
| 2026-11-17 | Retention for the pilot: keep everything, and review once a year. The tool still deletes nothing on its own; a leader can set a period and review proposals. | The record is the point: what worked and what didn't keeps compounding. Deleting it early costs more than keeping it. | Owner decision. Revisit if a customer's policy says otherwise. |
| 2026-11-17 | A legal hold beats an erasure request. The person is told the request is under review and when the hold releases. | It's the legally safer outcome and it's what the code already does. | Owner decision. The wording of that message is the organization's, with its counsel. |
| 2026-11-17 | When an author has left, a leader reassigns the post. Their credit stays on it. | One accountable person decides, using the steward handoff that already exists (a leader can reassign after 14 days of inactivity, with a public note). | Owner decision. An admin "mark as left" shortcut that skips the 14 days isn't built. |
| 2026-11-17 | A leader is someone an administrator names, from a short list. | It's explicit, auditable and already built (promote and demote, with a fresh sign-in check). | Owner decision. Titles and rotating panels are not built. |
