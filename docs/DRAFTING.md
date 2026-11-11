# Optional drafting, fixture-only

Drafting is not an approval path. `preflightDraft` shows the exact immutable
fixture packet, conservative input bound, and worst-case micro-dollar cost before
any gateway call. `sendDraft` refuses unless its caller passes explicit `true`.
It then calls the existing gateway contract with only `fixture:text-v1` and labels
the returned text **Model output, review required**. A draft has no machine event,
cannot approve, deliver, vote, or alter quorum.

This repository does not wire a browser form to send a draft or configure a real
provider. A UI integration must display this packet and require an intentional
approval click, then mint the existing scoped gateway capability for a current
run. No network or paid provider is used by this slice.
