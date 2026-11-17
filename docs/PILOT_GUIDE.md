# Pilot guide

This is a four-week, one-department pilot. It is a way to learn whether the workflow fits the department. It doesn't promise faster decisions, better outcomes, or productivity gains.

## Before week 1

Choose one department, one leader who can make bounded decisions, several members who do the work, and one operator who runs the service. Agree on the pilot's read scope, retention choice, and whether real work or only synthetic examples will be used.

For a ten-minute walk-through, start with a new database:

```sh
node cli.js pilot seed --departments 1 --people 4
```

Create the database first with `node cli.js init --id <leader>` (the seed adds its people next to that first leader). The seed uses only clearly synthetic people and records. It refuses a non-empty database. `--force-empty` is an explicit destructive option that erases the current database first. `node cli.js pilot reset --confirm-erase-everything` erases only a database marked by this seeder.

## Roles

- Members post SEE records and comments, and can challenge or add context.
- The department leader stewards items and records decisions with reasons.
- The operator manages people, groups, backups, access, and the end of the pilot. The operator doesn't rank participants.

## Four weeks

Week 1: set the read scope, show the short workflow, and post a few real, bounded problems. Check that everyone knows how to add context and how to ask for access.

Week 2: turn the clearest problems into SPECs. Record what would show help, what is out of scope, assumptions, and unanswered questions. Do not start a build without a recorded decision.

Week 3: make a small number of bounded decisions. If a build is approved, run it through the normal review and evidence path. Review disagreements and any reanalysis annexes as new information, not as a revision of history.

Week 4: review the database report together, collect voluntary qualitative feedback outside individual performance review, and decide whether to stop, extend, or adopt a narrow next step.

## What to measure

Run `node cli.js pilot report`. It reads counts and timestamps from the database and reports posts, comments, decisions, time to decision, forks, reanalysis annexes, and activity by department. It deliberately has no individual rankings or per-person productivity scores.

Use the report to ask modest questions: Were decisions recorded? Did the group use comments and forks when needed? How long did recorded decisions take? Counts don't prove quality, causation, or effort.

## Success and stop criteria

Set these before beginning. A reasonable success signal is that the department can record a few real problems, decisions, and reasons without the process getting in the way. A stop signal is a read-scope mistake, a security concern, a team member feeling pressured to participate, or the process consuming more attention than it returns. Stop immediately for an access incident, preserve evidence, and follow the incident steps in RUNBOOK.md.

## Data and privacy

The database holds item text, comments, decisions, account and group records, artifacts, and logs described in SECURITY.md. It doesn't collect individual productivity scores, rankings, private reflection text, or model prompts unless an operator deliberately enables an optional model lane. Logs contain ids and route/status data, not request bodies.

## End the pilot

Stop new work, run `node cli.js backup --to <path>`, verify the backup, and use `node cli.js export > pilot-export.jsonl` if the organization needs a portable record. To erase a selected body from the live store, use the erase procedure in RUNBOOK.md. Backups and frozen copies may retain older material, as documented there. To erase an entirely synthetic seeded database, use `node cli.js pilot reset --confirm-erase-everything`; it refuses databases not marked by the pilot seeder.
