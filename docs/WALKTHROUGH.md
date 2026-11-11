# Manual path

Start a fresh local workspace:

```sh
export SSS_DB=sss.db
node cli.js init --id leader
node cli.js invite create --role member --expires 24h
node cli.js serve --port 8080 --origin http://127.0.0.1:8080 --insecure-cookies
```

Save the one-time password from `init`. Open the printed URL, sign in as the leader, or redeem
the invite to join as a member.

The feed shows each problem, its stage, and the progress line. Post a problem gives one calm form:
write the thing people already know, then check what you have, pay for, can get free, or can change
with a setting. The steward writes the spec. A leader who isn't the steward decides by entering a cap, a quorum,
and their password again. A quorum of 1 is allowed, so one person saying `It helps` is enough. The steward or a leader delivers one HTML try. People other than the
steward and approver can open that try and choose `It helps`. When the quorum is met, the item reaches
Helps. A steward or leader can shelve any open item with a reason.

## Start alone with Vision Quest

From the signed-in work feed, choose **Start a Vision Quest**. Answer one question
at a time, confirm or correct the playback, then review the memo. You can keep or
export the draft without posting anything. Corrections retain earlier answers.
Choose **Post my checked problem** only after reviewing the account. This creates
a checked item, never an automatic spec or approval. A build proposal opens the spec
form with a first draft for the steward to edit. Existing-option and process-change
recommendations don't propose a build, and a parked one stays a memo.
See [VISION_QUEST.md](VISION_QUEST.md) for persistence, safety and current limits.
