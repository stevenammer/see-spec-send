# Vision Quest

Vision Quest is a guided session you can do alone. It takes a "why do we still do it
this way?" problem and turns it into a checked problem and a decision memo. Sometimes
the memo says don't build anything: change a setting, use something you already have,
or change how the work is done.

No-model mode is the default. It asks fixed questions in a fixed order and never calls
a model or outside service. A person can run the whole thing, and nothing is posted
until they say so.

## Optional model and portable modes

An organization can export one portable prompt file and paste it into a chat tool it
already uses. Pasting the memo back only succeeds when it matches the deterministic
memo from this same Quest schema. A chat tool can't change the recommendation, facts,
or workflow state through that import.

An administrator can choose a reviewed provider. Before a call, the provider layer
exposes the exact prompt packet, model, input bound and worst-case micro-dollar cost.
The caller must explicitly approve that packet. The response is labeled model output,
review required, and it isn't authority. It can't approve, post, change a spec, or
establish a fact. The standard no-model guide remains available.

## How to run a session

1. Sign in and choose **Start a Vision Quest** on the work feed.
2. Answer one question at a time. It starts with the last time the problem got in
   your way, not with your favorite fix.
3. After you describe the problem, it reads it back small, so you can correct it.
   You confirm the playback before any recommendation. If you change an early answer
   later, you confirm the playback again.
4. It asks what you've checked: something your team has, a tool it pays for, a free
   option, a setting or a bad field. Then it asks you to argue against yourself from
   three seats (the person defending the priority, the person doing the work, and a
   skeptic), and for the strongest reason not to go ahead.
5. Review the memo. **Compact** restates where you are. **Squirrel?** shows the signal
   score. Posting is a separate, explicit step with a checkbox.
6. Choose **Start another quest** for a fresh session. Earlier drafts, including stopped
   and posted sessions, stay in browser history and can be exported.

Everything you type is your own account. The memo says so. A confirmed playback means
"that's what I meant", not "that's true".

## What the recommendations mean

- **CONFIGURE**: you reported that a setting or a bad field could solve it. No build.
- **BUY OR USE**: you reported that something you already have, pay for or can get free
  could solve it. No build.
- **PROCESS CHANGE**: the first test you chose is a change to how the work is done.
  No build.
- **BUILD**: you checked all four options without finding a fix, the signal is strong
  enough, and you didn't call the risk high.
- **KILL**: park it. The signal is weak, you haven't checked the existing options, the
  risk is high, or you chose to stop.

The signal score ("Squirrel Test") adds up four answers from zero to four: impact 40,
recurrence 30, control 20, evidence 10, scaled to 100. Under 60, it says this may be a
distraction when no existing solution was reported. A reported setting or existing
solution takes priority over a weak score. Choosing to stop or reporting high risk
still parks the test for the decision owner. **These weights and the 60 threshold are provisional defaults.** I carried
over 40/30/20/10 from an earlier version and haven't re-derived them. They live in one
constant, `SQUIRREL_WEIGHTS`, in `public/vision-quest.js`.

The safety stop is a limited English keyword screen for reports such as harassment
(including common misspelling and invisible separators), assault, racist comments,
bullying, threats to hurt the speaker, abuse, retaliation, self-harm, suicide, overdose,
medical concerns and disciplinary decisions. An ordinary medical-records field problem
does not stop on the word "medical" alone. It halts the ordinary questions and points you to a person. It
only catches its listed English patterns, can miss paraphrases or other languages,
and can still stop benign text. It isn't a safety assessment. A fresh quest doesn't
remove the stopped session from history.

## What posting does

Posting makes one `checked` event, as you, and nothing more. The server rebuilds the
event from your answers in the request and ignores any recommendation or memo the
browser sends. Only the derived checked fields, memo and proposed spec are saved.
The raw turns are used transiently for validation and are not saved to the item.
You can't post for someone else, and the session can't skip a step, approve, deliver
or count as a helper.

- **BUILD** lands in CHECKED. The steward's spec form opens with the session's
  draft already filled in (what to try, how we'll know, what's out of scope). It's a
  first draft. The steward edits it and saves the spec by hand, as always.
- **CONFIGURE** and **PROCESS CHANGE** land in CHECKED with the verdict `setting`. The
  core has no process-only verdict, so a process change is filed under the nearest one.
  The item page shows the memo with its real label, and offers no spec form.
- **BUY OR USE** files `already_have`, `free` or `pay`. `already_have` shelves the item.
- **KILL** is memo only. It isn't posted, and you can keep or export it.

## Drafts and privacy

Each answer is saved before the next question appears. The browser stores a revision,
reads it back, checks its SHA-256, and only then moves the active pointer. A
half-finished session comes back after a reload or a browser restart. Corrections add
a turn and keep the original. If another tab changed the draft, the stale tab is
refused instead of overwriting it. You can export a draft and restore your own file.

Limits: 2000 characters per answer or note, 120 turns, 120,000 bytes in all. Anything
bigger, or in the wrong shape, is refused before anything is written.

Drafts are stored in this browser for your signed-in ID. A draft written for another
ID isn't offered to you and can't be restored under yours. They aren't encrypted, so
anyone with your browser profile and its developer tools can read them. Don't use a
shared browser for private drafts. A hash check detects changed bytes. It doesn't
prove the content is true, and you could rewrite and rehash your own file.

When you post, anyone who can read the item can read the derived memo. That memo
includes selected reported answers such as the occurrence, baseline, challenges,
decision owner and stop condition. Review it before posting. Raw turns and corrections
stay in this browser at rest. Posting sends them temporarily to this app's server so
it can derive the memo itself; it doesn't send them to any model or outside service.
Exports of browser drafts include the raw conversation. Shared item exports include
only the derived memo. Imported older records that already contain raw turns are not
retroactively rewritten by this change.

Retries of the same quest by the same person return the same item, including after a
restart and when JSON object keys are reordered. A deterministic receipt is scoped to
the signed-in person and the full quest. A fresh quest gets a new identity. Posted
sessions show a link to the item instead of another Post button; failed posts keep the
draft available for a safe retry. Changing answers creates a different submission.
Starting another quest keeps earlier durable revisions and an exportable history.
Sign-out clearing and a shelved event for a KILL memo remain follow-ups.

## What's tested, what isn't

`npm test` covers the guide, the posting route, storage failures, the limits, the
authority cases, escaping and the no-network check, and `npm run check:mutants` breaks
the controls on purpose. `test/e2e/vision-quest.e2e.mjs` drives the pages in a real
browser and needs a Playwright install. It isn't part of `npm test`.

## What isn't built

- **The portable prompt runtime**, the same session as one prompt you paste into any AI.
- **A standalone browser demo**, with a fictional organization and no sign-in.
- **The model-assisted runtime**, and the contract test that would stop a model from
  recommending before the playback is confirmed. That test doesn't apply here.
- The "state your assumptions every two or three exchanges" move. The guide has one
  playback and a checkpoint note every five turns, not a repeated assumption check.
- A re-derived Squirrel Test, and a safety screen beyond a keyword list.
