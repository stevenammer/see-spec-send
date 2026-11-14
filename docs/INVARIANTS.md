# See / Spec / Send invariants

Rules 2 keeps one current authorization chain: the SEE hash binds the SPEC's `see_hash`; the SPEC hash and packet hash bind SEND and approval; approval plus iteration binds each run, charge, artifact and HELP vote. A revised SEE after SEND supersedes that chain, stops its run and requires a new SPEC, SEND and approval. Comments and check-ins do not supersede it. HTTP rejects stale anchors, the worker retires stale iterations, and replay verifies the same machine rules.

Effort is always given a reserved, honest first-slot status when a SEE or SPEC is posted. It can be thinking, unavailable/retrying, or answered, but never has authority to approve, include, steer, spend outside its gateway limits, or rewrite a human comment.
