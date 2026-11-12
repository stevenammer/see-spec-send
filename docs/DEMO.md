# The demo site

A small site in `demo/` that lets anyone try the main rule without installing anything. It's plain files. There's no build step, no dependencies, no accounts and no cookies. After it loads, it makes no network requests, and a Content-Security-Policy in the page enforces that.

It isn't live yet. When I publish it, it'll be at https://stevenammer.github.io/see-spec-send/.

## Run it locally

Any static file server works. This one needs only Python 3:

```sh
python3 -m http.server 8080 --directory demo
```

Then open http://127.0.0.1:8080/. It can't run from a `file://` address, because browsers block module scripts there.

## What's real

- **The state machine.** `demo/lib/machine.js` is a generated copy of `core/machine.js`. Run `npm run sync:demo` to regenerate it. `npm run check:demo` fails if the copy has drifted, and CI runs it.
- **The refusals.** When the author or the approver says "it helps", or anyone tries to mark it done, the machine refuses. The page says which rule fired. The same sequence as [WATCH_IT_REFUSE.md](WATCH_IT_REFUSE.md) plays at one click, and a test checks that it matches that file.
- **Vision Quest, no model.** A fictional Quest memo is derived in the browser from the same deterministic guide copied from `public/vision-quest.js`. It makes no calls and isn't authority.

## What's close, but smaller

- **The log.** `demo/lib/log.js` follows `core/store.js`: append-only events, the same hash-chain shape with SHA-256 from WebCrypto, authority looked up from a fixed roster, and a verify that recomputes the chain. It lives in memory. If you tick the box, it's saved in your browser's local storage, and a saved log is only restored if its chain still verifies. `test/demo-parity.test.mjs` replays every story in `test/stories/` through both the real store and this log, and compares the refusals, the states and the chain hashes.
- **Explaining the refusal.** The machine only says "event not allowed". `demo/lib/rules.js` works out which rule fired, from the same state. It describes a decision. It never makes one.

## What's not here

- Sign-in, invites, sessions, CSRF protection and rate limits.
- The SQLite store and exports.
- The leader password step-up before approving.
- A playable try. In the demo, a try is a short note, so nothing a visitor types can run.
- Builder runs, the cost gateway, provider configuration, and model calls.
- Sending a spec back, changing the steward, and erasing text. The machine has them. The demo doesn't.
- More than one item at a time.

The people are invented: Maya, Lena, Ben, Cleo, Omar and Priya. Lena and Omar are leaders. Anything a visitor types is shown as text, never as markup, and input lengths are bounded.

## Checks

```sh
npm test               # includes the drift, parity, and safety tests
npm run check:demo     # only the drift check
```

I also ran it once in headless Chrome at 320, 390 and 1440 pixels. It checked for console errors, outside requests and sideways scrolling. That was a manual pass, not part of `npm test`. The screenshots are `docs/screens/demo-390.png` and `docs/screens/demo-1440.png`.
