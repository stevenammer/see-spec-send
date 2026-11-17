# Production handoff

After a build is approved and appears helpful, create a local change-request package:

```sh
node cli.js handoff export ITEM --actor PERSON --format json > change-request.json
node cli.js handoff export ITEM --actor PERSON --format md > change-request.md
```

`PERSON` is required because this is a local administrative command, not a browser session. The command refuses to export an item the named person can't read. It makes no network calls.

The package is shaped for a ServiceNow request, Jira ticket, or GitHub issue. It contains the recorded SEE, SPEC, decision and reason, bounded build bundle hash and file list when present, recorded evidence summary, item-scoped cost receipts, decision makers, and open assumptions/questions. It isn't an approval from any external change system.

Erased text is never included. If the required SEE, SPEC, or decision is erased or unavailable, export refuses rather than substituting text.
