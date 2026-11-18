// The scripted play-through. It runs through the same engine a visitor uses, so every "refused" below is the real
// machine saying no, not a recording. Each step says what it is about to do before it happens.
export const story = [
  { who: 'nick', say: 'Nick is in support. They\'re tired of copying every refund into a spreadsheet by hand, so they post it.',
    run: d => d.post('nick', 'We copy every refund into a spreadsheet by hand, and every month somebody pastes one twice.') },
  { who: 'steven', say: 'Steven sees it and adds what they know.',
    run: d => d.comment('steven', 'It gets worse when two of us edit the sheet at the same time. Rows go missing.') },
  { who: 'cleo', say: 'Cleo asks the question that ends a lot of problems early.',
    run: d => d.comment('cleo', 'Does the billing tool already have an export for refunds?') },
  { who: 'nick', say: 'Nick checks, finds it doesn\'t, and brings Steven\'s point into the problem with their name on it.',
    run: d => d.include('nick', d.state().events.find(e => e.type === 'commented' && e.actor === 'steven').body_hash) },
  { who: 'nick', say: 'Nick writes what the fix has to do.',
    run: d => d.spec('nick', 'Show each refund once.\nCatch a refund pasted twice.\nTwo people can work at the same time.', 'Nobody opens the spreadsheet anymore.') },
  { who: 'nick', say: 'They send it for a decision.', run: d => d.send('nick') },
  { who: 'jose', say: 'Jose is a leader who didn\'t write it. They read exactly what was sent, then decide to spend on a small try.',
    run: d => d.approve('jose', 'Small enough to try, and the spec is clear. Let\'s see if it helps.', 2) },
  { who: 'effort', say: 'A small version gets built in a locked box.', run: d => d.deliver() },
  { who: 'nick', say: 'Now the part that matters. Nick wrote the spec and tries to say it helps.', refuse: 'Nick tries to say it helps.', action: 'helps',
    run: d => d.helps('nick') },
  { who: 'jose', say: 'Jose approved it, and tries too.', refuse: 'Jose tries to say it helps.', action: 'helps', run: d => d.helps('jose') },
  { who: 'nick', say: 'Someone tries to mark it done by hand.', refuse: 'Nick tries to mark it done.', action: 'done', run: d => d.done('nick') },
  { who: 'steven', say: 'Steven didn\'t shape the spec or approve it. They tried it and it helped.', run: d => d.helps('steven') },
  { who: 'cleo', say: 'Cleo tries it too. That\'s two people who do the work, so it counts.', run: d => d.helps('cleo') },
];
