# Threat Watch

`scripts/threat-watch.mjs` checks what your team runs against public vulnerability feeds and files each new problem as a See, through the same signed inbound route as any other integration ([INTEGRATIONS.md](INTEGRATIONS.md)).

It's an example integration, not part of the server. It has no dependencies, needs no account or key for the feeds, and never fixes, approves or votes on anything.

## What it does

1. Reads what you point it at: npm `package-lock.json` files, Python requirements with exact pins (`name==1.2.3`), and any extra packages you name (`--package Go:github.com/ollama/ollama@v0.30.11`). Ranges like `requests>=2` are skipped and counted, never guessed.
2. Asks [OSV.dev](https://osv.dev) which known advisories apply (npm, PyPI, Go and the GitHub advisories, in one query).
3. Marks anything on CISA's [Known Exploited Vulnerabilities](https://www.cisa.gov/known-exploited-vulnerabilities-catalog) list as exploited in the wild. Those are filed whatever their severity.
4. Files one See per new advisory at `--min-severity` or above (default `moderate`). The See says what's wrong, where, the advisory IDs, and the advisory's own fixed version. It's labeled `documented` and lands in the Seen stage, so a person checks it before it moves.
5. Remembers what it filed (`--state`, default `.threat-watch.json`), so each advisory is filed once.

## Run it

Dry run first. It prints what it would file and changes nothing:

```sh
node scripts/threat-watch.mjs --lock path/to/package-lock.json --requirements path/to/requirements.txt
```

Then add a source on your server and send for real:

```sh
SSS_INBOUND_SECRET='at-least-16-random-characters' node cli.js integration source add --name threat-watch --secret-env SSS_INBOUND_SECRET
SSS_INBOUND_SECRET='...' node scripts/threat-watch.mjs --lock package-lock.json --send --url https://sss.example.com --source threat-watch
```

Run it from your scheduler every few hours. `--send` needs an `https` URL (plain `http` only for `localhost`) and refuses redirects. Each source is rate limited to 30 requests a minute by the server, so a first run on a large codebase may need a couple of passes; anything not filed is tried again next run.

## What it won't do

- Decide anything. Whether to upgrade, wait, or accept the risk is the team's call, made on the See like any other.
- Read your code or send it anywhere. OSV only receives package names and versions. CISA's list is a public download.
- Cover what isn't in a lockfile: operating system packages, container images and services. Use an image scanner (CI here runs one) for those.
