# A cold walk through the app

On Nov 17, 2026 I played a first-time user: no instructions, a phone-sized screen and a desktop one. I joined with an invite, posted a problem, commented, wrote a spec, sent it, and signed in as a leader to decide. At each step I captured the screen and everything a newcomer could see (headings, buttons, links, form labels). This page says what confused me, what I changed, and what I haven't looked at.

## What was confusing, and what changed

| What I hit | What I did |
| --- | --- |
| The landing page was a bare "Sign in" form. Nothing said what this is. Signed-out visitors also saw Search, Investigate and Mentoring links. | Two plain sentences on what the product is. Signed-out pages show only the product name. |
| The invite page didn't say what an invite is or what the password rules are. | It says an invite comes from whoever runs the workspace, that your ID is the name others see, and that the password needs 12 characters. A link back to sign in. |
| "That did not go through" was the only message when a password change failed. | Two specific messages: the temporary password is wrong, or the new one was refused and why. |
| The item page opened with the problem text five times, an accounting block with dollar figures, `see_first`, a 64-character hash, a "0 of 2 people have said it helps" line before anything existed, and seven forms. The conversation was about 6,000 pixels down. | A one-sentence "Next:" box for that person and that stage, then the conversation. The accounting, the original post and versions, and the expert fields are collapsed. The helps counter appears only once something is delivered. Stage history and Effort's status read in plain words. |
| A long hash widened the page past the phone screen. | Long text now wraps. |
| After writing the spec there was no clear next step, and after sending it there was none either. A leader opening the spec saw no way to decide. | Both the item page and the spec page say what happens next and link to where a leader decides. |
| The approval form used build jargon ("Maximum additional build turns") with no explanation. | Each limit says what it does in plain words. |
| A member opening Admin got raw JSON. | A short explanation, still refused. |
| The new-post form said only "What happened?". | It says what to write and to check first whether something you already have solves it, with an example. |
| The feed showed "0 of 2 people have said it helps" for everything. | It says where each problem stands in plain words, and what a Vision Quest is. |

All of this is pinned by `test/ui-clarity.test.mjs` and 14 mutants. The real-browser journeys pass with the new wording.

## What I haven't looked at

- **Search, Investigate and Mentoring** only on first screen. Investigate is the roughest: "evidence packet", "Run with Effort", "sources-only answer", "Work item IDs" (people don't know IDs) and UTC date fields.
- **The Vision Quest** beyond its first screen.
- **The leader's other decision forms.** "Record another decision" has a long outcome list and reason codes I didn't walk.
- **Real users.** I read this as a stranger would, but I am not one. Watching two or three real people try it, with no help, will find things I can't.
