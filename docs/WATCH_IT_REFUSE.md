# Watch it refuse

The rule is that nothing counts until other people say it helps. Here's the real server enforcing it.
The names are invented. Maya wrote the spec, Lena is a leader who approved it, Ben and Cleo are other members.

Run it yourself: `node scripts/watch-it-refuse.mjs`. It starts the server on a free local port with a
throwaway in-memory database, so it touches nothing on disk. This is its output:

```text
maya  post a problem                               201 accepted item is CHECKED
maya  write the spec                               201 accepted item is SPECCED
lena  approve, cap $5, quorum 2                    201 accepted item is SENDING
maya  deliver one playable try                     201 accepted item is TRYING (0 of 2 helpers)

maya  say it helps (she wrote the spec)            409 refused  item is TRYING (0 of 2 helpers)
lena  say it helps (she approved it)               409 refused  item is TRYING (0 of 2 helpers)
maya  make up a "done" event                       409 refused  item is TRYING (0 of 2 helpers)
ben   say it helps                                 201 accepted item is TRYING (1 of 2 helpers)
cleo  say it helps                                 201 accepted item is HELPS
```

What happened:

- Maya wrote the spec, so her "it helps" is refused (409). The item stays at 0 of 2.
- Lena approved the spec, so her "it helps" is refused (409). Being a leader doesn't override the rule.
- A made-up "done" event is refused (409). The machine has no such event.
- Ben says it helps (1 of 2). Cleo says it helps (2 of 2). Now the item reaches HELPS.

`test/watch-it-refuse.test.mjs` runs the same script and fails if any refusal stops happening,
or if the output above stops matching what the script prints.
