// Three synthetic workplace tasks for judging a builder. Each has the spec a leader would approve, a browser check
// that decides pass or fail from what the page does (not from what it looks like), a hand-written good bundle (the
// oracle) and a deliberately broken one. Nothing here is real data.

const text = async (page, selector) => (await page.locator(selector).first().innerText().catch(() => '')).trim();

export const tasks = [
  {
    id: 'refunds',
    title: 'Clean up a pasted refund list',
    spec: {
      must: [
        'A textarea with id refunds-in where someone pastes one refund per line, written like A100, 25.50 (an order ID, a comma, an amount)',
        'A button labeled Clean up',
        'Clicking it fills an ordered list with id refunds-out with each order ID once, the first line winning when an ID repeats, and puts the sum of those amounts with two decimals in an element with id total',
        'Blank lines are ignored. A line whose amount is not a number goes in a list with id problems and is left out of the total',
        'Clicking again replaces the earlier result instead of adding to it',
      ],
      how_we_know: ['Paste six lines with one repeated ID, one bad amount and one blank line, and the lists and total match what a person would work out by hand'],
      out_of_scope: ['Any network request', 'Saving anything'],
    },
    async accept(page, ck, url) {
      await page.goto(url);
      await page.locator('#refunds-in').fill('A100, 25.50\nB200, 10\nA100, 99.99\n\nC300, abc\nD400, 4.5');
      await page.getByRole('button', { name: 'Clean up' }).click();
      const rows = await page.locator('#refunds-out li').allInnerTexts();
      ck('lists each order ID once, in the order first seen', rows.length === 3 && /A100/.test(rows[0]) && /B200/.test(rows[1]) && /D400/.test(rows[2]));
      ck('shows the total as 40.00', (await text(page, '#total')).includes('40.00'));
      const problems = await page.locator('#problems li').allInnerTexts();
      ck('puts the bad line in the problem list and keeps it out of the results', problems.length === 1 && /C300/.test(problems[0]) && !rows.join(' ').includes('C300'));
      await page.locator('#refunds-in').fill('Z900, 1');
      await page.getByRole('button', { name: 'Clean up' }).click();
      ck('a second click replaces the first result', (await page.locator('#refunds-out li').count()) === 1 && (await text(page, '#total')).includes('1.00') && (await page.locator('#problems li').count()) === 0);
    },
    oracle: {
      'index.html': '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Refund cleanup</title><link rel="stylesheet" href="style.css"></head><body><main><h1>Refund cleanup</h1><label for="refunds-in">Refunds</label><textarea id="refunds-in" rows="8"></textarea><button id="go" type="button">Clean up</button><h2>Refunds</h2><ol id="refunds-out"></ol><p>Total: <span id="total"></span></p><h2>Problems</h2><ul id="problems"></ul></main><script src="app.js"></script></body></html>',
      'style.css': 'body{font-family:system-ui,sans-serif;margin:2rem}textarea{width:100%}',
      'app.js': "document.getElementById('go').addEventListener('click', function () {\n  var seen = {}; var out = document.getElementById('refunds-out'); var bad = document.getElementById('problems'); var total = 0;\n  out.textContent = ''; bad.textContent = '';\n  document.getElementById('refunds-in').value.split('\\n').forEach(function (line) {\n    if (!line.trim()) return;\n    var parts = line.split(','); var id = parts[0].trim(); var amount = Number(parts[1]);\n    if (!id || parts.length < 2 || parts[1].trim() === '' || !isFinite(amount)) { var b = document.createElement('li'); b.textContent = line.trim(); bad.appendChild(b); return; }\n    if (seen[id]) return; seen[id] = true; total += amount;\n    var li = document.createElement('li'); li.textContent = id + ' ' + amount.toFixed(2); out.appendChild(li);\n  });\n  document.getElementById('total').textContent = total.toFixed(2);\n});\n",
    },
    broken: { patch: ['app.js', "if (seen[id]) return; seen[id] = true; total += amount;", "total += amount;"] },
  },
  {
    id: 'swaps',
    title: 'A shift swap board that remembers',
    spec: {
      must: [
        'A text input with id name, a date input with id date and a text input with id note, each with a label, and a button labeled Post swap',
        'Posting adds a card as a list item in an unordered list with id board, newest first, showing the name, date and note',
        'If the name is empty nothing is added',
        'Each card has a button labeled Remove that deletes just that card',
        'The board is still there after the page is reloaded, with the cards in the same order as before (newest first)',
      ],
      how_we_know: ['Post two swaps, reload, remove one, reload again, and the board always matches, in the same order each time'],
      out_of_scope: ['Any network request', 'Accounts or sign-in'],
    },
    async accept(page, ck, url) {
      await page.goto(url);
      const post = async (name, date, note) => { await page.locator('#name').fill(name); await page.locator('#date').fill(date); await page.locator('#note').fill(note); await page.getByRole('button', { name: 'Post swap' }).click(); };
      await post('Nick', '2026-12-01', 'need nights'); await post('Steven', '2026-12-03', 'trade for days');
      const cards = await page.locator('#board li').allInnerTexts();
      ck('adds a card per post, newest first', cards.length === 2 && /Steven/.test(cards[0]) && /Nick/.test(cards[1]) && /trade for days/.test(cards[0]));
      await page.reload();
      const reloaded = await page.locator('#board li').allInnerTexts();
      ck('keeps the board after a reload', reloaded.length === 2);
      ck('keeps the same order after a reload (newest first)', reloaded.length === 2 && /Steven/.test(reloaded[0]) && /Nick/.test(reloaded[1]));
      await post('', '2026-12-05', 'nobody');
      ck('ignores a post with no name', (await page.locator('#board li').count()) === 2);
      await page.locator('#board li', { hasText: 'Steven' }).getByRole('button', { name: 'Remove' }).click();
      const left = await page.locator('#board li').allInnerTexts();
      ck('removes only the card it belongs to', left.length === 1 && /Nick/.test(left[0]) && !/Steven/.test(left[0]));
      await page.reload();
      ck('keeps the removal after a reload', (await page.locator('#board li').count()) === 1);
    },
    oracle: {
      'index.html': '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Swap board</title></head><body><main><h1>Swap board</h1><div><label for="name">Name</label><input id="name" type="text"><label for="date">Date</label><input id="date" type="date"><label for="note">Note</label><input id="note" type="text"><button id="post" type="button">Post swap</button></div><ul id="board"></ul></main><script src="app.js"></script></body></html>',
      'app.js': "var KEY = 'swaps'; var cards = JSON.parse(localStorage.getItem(KEY) || '[]');\nfunction save() { localStorage.setItem(KEY, JSON.stringify(cards)); }\nfunction draw() {\n  var board = document.getElementById('board'); board.textContent = '';\n  cards.forEach(function (card, i) {\n    var li = document.createElement('li'); li.textContent = card.name + ' ' + card.date + ' ' + card.note + ' ';\n    var b = document.createElement('button'); b.type = 'button'; b.textContent = 'Remove';\n    b.addEventListener('click', function () { cards.splice(i, 1); save(); draw(); });\n    li.appendChild(b); board.appendChild(li);\n  });\n}\ndocument.getElementById('post').addEventListener('click', function () {\n  var name = document.getElementById('name').value.trim(); if (!name) return;\n  cards.unshift({ name: name, date: document.getElementById('date').value, note: document.getElementById('note').value });\n  save(); draw();\n});\ndraw();\n",
    },
    broken: { patch: ['app.js', "function save() { localStorage.setItem(KEY, JSON.stringify(cards)); }", "function save() {}"] },
  },
  {
    id: 'triage',
    title: 'A five-question escalation checklist',
    spec: {
      must: [
        'Five questions, each with two radio buttons named q1 to q5 with values yes and no, and a button labeled Get result',
        'An element with id result shows exactly Escalate to a leader when the answer to question 1 or question 2 is yes',
        'Otherwise, when every question is answered, it shows exactly Handle it yourself',
        'If any question is unanswered it shows exactly Answer every question',
      ],
      how_we_know: ['Try all no, only question 3 yes, only question 1 yes, only question 2 yes, and one question left blank'],
      out_of_scope: ['Any network request', 'Saving anything'],
    },
    async accept(page, ck, url) {
      const run = async answers => { await page.goto(url); for (const [q, v] of Object.entries(answers)) await page.locator(`input[name=${q}][value=${v}]`).check(); await page.getByRole('button', { name: 'Get result' }).click(); return text(page, '#result'); };
      const none = { q1: 'no', q2: 'no', q3: 'no', q4: 'no', q5: 'no' };
      ck('all no gives Handle it yourself', (await run(none)) === 'Handle it yourself');
      ck('only question 3 yes still gives Handle it yourself', (await run({ ...none, q3: 'yes' })) === 'Handle it yourself');
      ck('question 1 yes gives Escalate to a leader', (await run({ ...none, q1: 'yes' })) === 'Escalate to a leader');
      ck('question 2 yes gives Escalate to a leader', (await run({ ...none, q2: 'yes' })) === 'Escalate to a leader');
      const missing = { ...none }; delete missing.q5;
      ck('an unanswered question gives Answer every question', (await run(missing)) === 'Answer every question');
    },
    oracle: {
      'index.html': '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Escalate?</title></head><body><main><h1>Escalate?</h1>' + [1, 2, 3, 4, 5].map(n => `<div><p>Question ${n}</p><label><input type="radio" name="q${n}" value="yes"> Yes</label><label><input type="radio" name="q${n}" value="no"> No</label></div>`).join('') + '<button id="go" type="button">Get result</button><p id="result"></p></main><script src="app.js"></script></body></html>',
      'app.js': "document.getElementById('go').addEventListener('click', function () {\n  var answers = {}; var missing = false;\n  for (var n = 1; n <= 5; n++) { var picked = document.querySelector('input[name=q' + n + ']:checked'); if (!picked) missing = true; else answers['q' + n] = picked.value; }\n  var out = document.getElementById('result');\n  if (missing) out.textContent = 'Answer every question';\n  else if (answers.q1 === 'yes' || answers.q2 === 'yes') out.textContent = 'Escalate to a leader';\n  else out.textContent = 'Handle it yourself';\n});\n",
    },
    broken: { patch: ['app.js', "answers.q1 === 'yes' || answers.q2 === 'yes'", "answers.q1 === 'yes' || answers.q3 === 'yes'"] },
  },
];
