# Admin commands

Set `SSS_DB` to the database path. The CLI is the only administrator surface.

`node cli.js init --id leader` creates the first leader and prints a one-time password.
Save it before closing the terminal. It is never stored as plaintext.

`node cli.js invite create --role member --expires 24h` prints one redeemable invite.
Roles are `member` or `leader`.

`node cli.js person list` prints registered people and leader flags.

`node cli.js session revoke --person ID` removes every session for that person.

`node cli.js token create --kind gateway --item ID` and `--kind run` print an item-scoped
token once. Only its digest is stored.

`node cli.js verify` verifies each item's hash chain. `node cli.js export` prints JSONL.
`node cli.js backup --to FILE` checkpoints SQLite then copies its database file.

Import trusts the actor registry inside the JSONL before replaying events. Import is an
administrator action. Run it only on an export you made yourself.

`node cli.js serve --port 8080 --origin http://127.0.0.1:8080 --insecure-cookies` starts the web server.
Secure cookies are the default. `--insecure-cookies` is only for local HTTP development, and the
command prints a warning when it is used. For HTTPS, omit it and give the public HTTPS origin.

Old-format authority is captured once from the registry during migration. Its original
hashes are preserved, so those historical roles cannot be independently authenticated
from the old chain. Migration rebuilds the derived context cache in the same transaction.
Later registry edits and reopening do not recapture those roles.

New erasure receipts bind the replacement tombstone bytes. Unknown body metadata is
removed along with authored text; actor IDs and structural references remain. This does
not guarantee removal from backups or earlier copies of the database.
