# Audit log

`node cli.js audit export --format jsonl` exports the sealed administrative audit chain. Add `--since 2026-01-01T00:00:00Z` to limit it. `--format cef` emits a compact CEF stream.

Start the server with `serve --audit-log FILE` to append operational security events. The service writes sign-in, step-up, erase, artifact export, workflow decision, approval, and scope-change attempts. It never writes request bodies, passwords, cookies, bearer tokens, or model text.

Each JSON line has `timestamp` (ISO-8601 UTC), `who` (person id or null), `what` (event class), `outcome` (`ok` or `refused`), and `request_id`. CLI export rows additionally have `sequence`, `seal`, and body-free `detail`. The file is opened with append mode and mode 0600. This is an append-only writer, not immutable storage: protect it with OS permissions and ship it to an append-only log system if tamper resistance is required.
