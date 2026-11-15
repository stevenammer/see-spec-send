# F5: workspace memory with evidence and attribution

Signed-in members can search literal words, open immutable source records, discover related work, and inspect a person's contribution records. Results and records are evidence, never scores, rankings, deduplication decisions, approval, or proof of independent agreement. Similar SEEs remain independent.

SQLite FTS5 and contribution tables are derived from the event chains in the append transaction. Verification recomputes both; rebuilding restores them. Erasure removes target text from search and dependent credit while retaining authored metadata as an erased-content tombstone. This does not claim to purge independent copies, frozen decision snapshots, or older backups.

Search and contribution SQL contain the enabled-person visibility predicate. Agents, scoped tokens, missing people and disabled viewers receive no records. FTS operators in user input are quoted literal words. Source text is escaped on every new page. Acknowledgements bind an unerased source event in the same item to its actual author; AI cannot issue a human credit note. A credit note changes no workflow authority or helpers, even after an item closes.

Internal prior-work research remains off until an operator enables it:

```sh
node cli.js research status
node cli.js research enable --source this_workspace
node cli.js research disable --source this_workspace
```

When enabled, the connector searches only visible workspace records and reports its query, source event identities, coverage, and missing external sources. Retrieved records enter Effort's bounded user JSON as labeled evidence, never the fixed system instruction. A planted request to approve or spend produces one AI comment and no authority event.

Schema 10 creates the indexes and keeps cached workflow contexts unchanged, tested through a schema-9 golden fixture. Derived indexes are not included in event exports.

The runtime minimum is now Node 22.19 with FTS5. An actual official Node 22.13 binary lacks the FTS5 module and correctly refuses memory initialization. Node 22.19 and 22.23.4 pass the memory tests; this is a tested minimum, not a claim about the first release to support FTS5.

## Verification

Focused memory/HTTP tests, the phone-width Chrome journey, schema upgrade, old story parity and ten substantive mutation controls are verified. Full-suite, public-file, listener and exact mutation campaign results are recorded at release; focused kills alone do not claim those longer gates finished.

## Remaining work

The anonymous demo and optional private mentoring are F6. Executive analysis follows trustworthy workspace memory. No external research provider, hosted model or paid API call was enabled by this slice.
