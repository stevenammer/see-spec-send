# Data map

What is stored, where, who can read it, how long it stays, and how erasure reaches it. Rows marked **not decided** are policy choices the owner has not made; the project does not invent them.

| Data class | Where | Who can read it | Retention today | Erasure |
| --- | --- | --- | --- | --- |
| Accounts (id, password hash, role) | `users` table | Admins through the CLI; the person for their own account | Until the person is removed | Disable or remove by CLI. **Not decided:** a retention period after someone leaves. |
| Work posts, comments, specs, decisions | `events` and `bodies` | Anyone allowed to read the item (workspace-wide, or the audience group for restricted work) | Indefinite | Author or steward erase removes the body text; the chain keeps hashes. |
| Restricted-work existence | `events` first record | Anyone, as "a restricted case exists, ask its steward" | Indefinite | Same as above. |
| Reflection notes | The person's own browser only | Only that person, on that device | Until the person deletes them | The person deletes or exports them. The server holds nothing. |
| Mentoring requests and check-ins | Separate mentoring tables | Only the two participants | Indefinite | Not reachable by erase of work posts; **not decided:** a retention rule. Nothing else reads these tables. |
| Search index (words from records) | `search_docs` | Rebuilt from events; scoped to the viewer | Follows the posts | Rebuilt when a body is erased. |
| Knowledge log: results, impacts, updates, receipts | `knowledge_log` (hash-chained) | Scoped by the source and target read rules | Indefinite | Records built from an erased source (results, updates, saved question answers, the ledger, closing reports) are tombstoned and their text is removed from this database in the same step. Their hashes stay so the chain still verifies. Earlier backups and exports are not changed. |
| Corrections and challenges | `knowledge_log` | Anyone who can read the target | Indefinite | They are attributed notes, not edits; they follow the target. |
| Digest entries and ping log | `digest_entries`, `ping_log` | The recipient only | Indefinite | Removed with the update when its source is erased. **Not decided:** a retention rule. |
| Model gateway receipts | `gateway_*` tables | Operators | Indefinite | Not erased with posts: they hold counts and hashes only, no text. |
| Analysis receipts | `knowledge_log` | Anyone with the same read scope as the cited sources | Indefinite | Follow the cited sources. |
| Build bundles and tries | Artifact store | Anyone who can read the item | Indefinite | Erased with the item body; frozen packet copies can remain. |
| Exports | A file you write with `export` | Whoever can read that file | Operator's choice | Contains everything readable at export time, including restricted work and group membership. Erased text is left out of the file. Treat it like a backup. |
| Backups | Where the operator puts them | Whoever can read that location | Operator's choice | Not changed by an erase. This is the main place erased text can survive. |
| Logs | Standard error, wherever the operator sends it | Operators | Operator's choice | Contains person ids and route templates, no content. |
| External messages | Nothing today | n/a | n/a | n/a |

**Knobs that would be needed for decisions not yet made:** an account retention period, a mentoring retention period, an automatic digest retention period, a backup retention policy, and a rule for how long frozen packet copies may keep erased text.
