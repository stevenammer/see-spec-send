# F4: historical forks and model-builder steering

Members can fork a selected SEE version, SPEC version, or delivered try, including a terminal parent. Selection binds the parent item, sequence, chain hash, event kind, and body hash. The selected point supplies the SEE and any starting spec. That spec is visibly an unapproved draft: the new item starts in SEE without a spec, approval, artifact, spend, or helpers. It needs its own SPEC, SEND, decision report, and independent leader approval.

Fork request keys are stable across retries. Reusing a key with a different reason or selection is refused. A rebuildable lineage table is verified against the event chains. Schema 9 populates it for existing forks; a schema-8 golden fixture checks backup, upgrade, and unchanged cached contexts.

Exports now include referenced frozen packets and delivered artifact bytes. Import restores parents before children regardless of ID sort order, verifies artifact hashes, and rejects cyclic or missing parents. A parent erasure does not break restoration of an earlier independent fork. New forks of an erased version copy its tombstone. Erasing a parent does not retroactively purge text already copied into an independent child; this is not claimed as a cross-branch privacy purge.

The real container builder now receives OP-adopted instructions and the approved structured scope. It does not receive raw comments, commenter identities, source-credit metadata, or unrelated discussion. Scope identifiers are proposals, not connections or access grants. Explicit steering scope can narrow approved sources/audiences, never expand them. New sources or audiences require a new spec and approval. Arbitrary prose is not treated as a sound authorization parser; the container still has no network and no added mounts.

Legacy three-list builder input remains supported. Optional instructions and scope remain JSON user data. The fixed system instruction and static-page validator preserve the existing sandbox boundary.

## Verification

- Real Docker acceptance: 9/9 passed using the pinned container and a local mock model, including OP adoption across two model-built iterations.
- Real Chrome: historical SPEC and terminal-parent SEE forks passed at 390px member width.
- The full suite passed 405/405 with zero skips on Node 22.23.4. Fork, HTTP, migration, page, builder, existing-regression, listener, public/demo and manual browser checks passed. All 17 focused mutation controls failed on their intended assertions; all 17 standard full-suite mutation gates also completed with exit code zero on the frozen `d4ab97a` checkpoint.
- No hosted vendor or paid API was called.

## Remaining work

Searchable work memory and contribution records are F5. The anonymous demo and optional mentoring are F6. No external research adapter, identity provider, or organization-specific source is enabled by this slice.
