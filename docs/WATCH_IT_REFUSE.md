# Watch it refuse

The rule is that nothing counts until other people say it helps. Here's the real server enforcing it.
The names are invented. Nick wrote the spec, Jose is a leader who approved it, Steven and Cleo are other members.

Run it yourself: `node scripts/watch-it-refuse.mjs`. It starts the server on a free local port with a
throwaway in-memory database, so it touches nothing on disk. This is its output:

```text
nick   post a problem                               201 accepted item is CHECKED
nick   write the spec                               201 accepted item is SPECCED
jose   approve, cap $5, quorum 2                    201 accepted item is SENDING
nick   deliver one playable try                     201 accepted item is TRYING (0 of 2 helpers)

nick   say it helps (they wrote the spec)           409 refused  item is TRYING (0 of 2 helpers)
jose   say it helps (they approved it)              409 refused  item is TRYING (0 of 2 helpers)
nick   make up a "done" event                       409 refused  item is TRYING (0 of 2 helpers)
steven say it helps                                 201 accepted item is TRYING (1 of 2 helpers)
cleo   say it helps                                 201 accepted item is HELPS
```

What happened:

- Nick wrote the spec, so their "it helps" is refused (409). The item stays at 0 of 2.
- Jose approved the spec, so their "it helps" is refused (409). Being a leader doesn't override the rule.
- A made-up "done" event is refused (409). The machine has no such event.
- Steven says it helps (1 of 2). Cleo says it helps (2 of 2). Now the item reaches HELPS.

`test/watch-it-refuse.test.mjs` runs the same script and fails if any refusal stops happening,
or if the output above stops matching what the script prints.
