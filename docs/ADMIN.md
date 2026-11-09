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
