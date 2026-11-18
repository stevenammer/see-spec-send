# Pilot guide

This is a four-week, one-department pilot. It is a way to learn whether the workflow fits the department. It doesn't promise faster decisions, better outcomes, or productivity gains.

## Before week 1

Choose one department, one leader who can make bounded decisions, several members who do the work, and one operator who runs the service. Agree on the pilot's read scope, retention choice, and whether real work or only synthetic examples will be used.

For a ten-minute walk-through, start with a new database:

```sh
node cli.js pilot seed --departments 1 --people 4
```

Create the database first with `node cli.js init --id <leader>` (the seed adds its people next to that first leader). The seed uses only clearly synthetic people and records. It refuses a non-empty database. `--force-empty` is an explicit destructive option that erases the current database first. `node cli.js pilot reset --confirm-erase-everything` erases only a database marked by this seeder.

## The smallest honest pilot

If you only do one thing, do this. It's what I'd run first, and it's what I'd tell a company the tool can honestly support today.

- **Who:** one team of 6 to 12 people who do the work, two leaders, and one operator who isn't one of the approving leaders. Four weeks.
- **Accounts:** company sign-in only if you can set it up (it's tested against a reference provider, not yet against Okta, Entra or Google, so test yours first). Otherwise make every invite for a named person: `node cli.js invite create --role member --for <their id>`. The rule that the author, the approver and whoever hand-delivers a try can't say it helped counts accounts, so who gets an account is the control.
- **Quorum:** the approving leader sets how many people must say a try helped. Agree before week 1 that it's never less than 2, and that the people counted can't include anyone who shaped the SPEC or the try.
- **What goes in:** non-sensitive problems only. Restricting a post to a group is possible (see ADMIN.md) but opt-in, and the post form doesn't have a field for it yet, so don't plan around it.
- **The AI:** leave the AI builder off for the first pass, or put it behind one priced provider with the run limits set. Without a model, Effort doesn't reply, and a try is a page someone pastes in. Say that plainly to the team. See AGENT_HARNESSES.md for what has and hasn't been proven.
- **Backups:** run a daily backup yourself (the tool doesn't schedule one). For example, a cron line such as `15 2 * * * node cli.js backup --to /backups/sss-$(date +\%F).db`, and check one restore before week 1.
- **Review:** the operator and a leader read the feed together once a week for a read-scope mistake, a surprising spend, or anything someone is uncomfortable with.
- **What to measure:** decisions recorded with reasons, not fixes shipped. Counts don't prove quality or causation.
- **What nobody gets:** there's no notification when something is waiting for a decision or a try is ready, there's no "doesn't help" button (say it in a comment), and votes are visible. Tell the team so nobody waits for a ping that won't come.

## Roles

- Members post SEE records and comments, and can challenge or add context.
- Members steward their own items. Whoever posts a problem is its steward and writes its SPEC.
- Leaders record decisions with reasons. A steward can't approve their own item, so a pilot needs **at least two leaders**. If a leader posts a problem, the other leader decides it.
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

## Four policies to set before week 1

These are the organization's calls, not the tool's. These are the defaults I'd start a pilot with. Change them if your policy says otherwise.

| Question | Default for the pilot | What to know |
| --- | --- | --- |
| How long do we keep comments, closeout reports and spend receipts? | Keep everything and review once a year. | The tool deletes nothing on its own. A leader can set a period and review proposals. |
| Someone asks to erase their words, but the item is under a legal hold. | The hold wins. Tell them the request is under review and when the hold releases. | The tool already refuses erasure on held items. The wording of the message is yours, with your counsel. |
| The person who posted a problem has left. | A leader reassigns the post. Their credit stays on it. | A leader can reassign after 14 days of inactivity, with a public note. There's no "mark as left" shortcut yet. |
| Who counts as a leader? | An administrator names a short list. | Leaders can't approve their own specs. Promote and demote need a fresh sign-in check. |

## Data and privacy

The database holds item text, comments, decisions, account and group records, artifacts, and logs described in SECURITY.md. It doesn't collect individual productivity scores, rankings, private reflection text, or model prompts unless an operator deliberately enables an optional model lane. Logs contain ids and route/status data, not request bodies.

## End the pilot

Stop new work, run `node cli.js backup --to <path>`, verify the backup, and use `node cli.js export > pilot-export.jsonl` if the organization needs a portable record. To erase a selected body from the live store, use the erase procedure in RUNBOOK.md. Backups and frozen copies may retain older material, as documented there. To erase an entirely synthetic seeded database, use `node cli.js pilot reset --confirm-erase-everything`; it refuses databases not marked by the pilot seeder.
