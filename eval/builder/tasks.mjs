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
  {
    id: 'split',
    title: 'Split a bill to the cent',
    spec: {
      must: [
        'Number inputs with ids total (dollars), tip (percent) and people (a whole number), each with a label, and a button labeled Split it',
        'Clicking it shows the amount plus the tip, with two decimals, in an element with id grand',
        'It fills an ordered list with id shares with one share per person, two decimals each. The shares differ from each other by at most one cent and add up exactly to the grand amount, with any extra cents going to the first people in the list',
        'If people is not a whole number of at least 1, or total is not a number, put the words Check the numbers in an element with id error and leave the list empty',
        'Clicking again replaces the earlier result and clears an old error',
      ],
      how_we_know: ['100 with a 15 percent tip for 3 people gives 115.00 and shares 38.34, 38.33 and 38.33'],
      out_of_scope: ['Any network request', 'Saving anything'],
    },
    async accept(page, ck, url) {
      await page.goto(url);
      const go = async (total, tip, people) => { await page.locator('#total').fill(total); await page.locator('#tip').fill(tip); await page.locator('#people').fill(people); await page.getByRole('button', { name: 'Split it' }).click(); };
      await go('100', '15', '3');
      const shares = await page.locator('#shares li').allInnerTexts();
      ck('shows the grand amount 115.00', (await text(page, '#grand')).includes('115.00'));
      ck('gives three shares, 38.34 first and then 38.33 twice', shares.length === 3 && shares[0].includes('38.34') && shares[1].includes('38.33') && shares[2].includes('38.33'));
      ck('the shares add up to the grand amount in cents', Math.round(shares.reduce((n, t) => n + parseFloat(t.replace(/[^0-9.]/g, '')), 0) * 100) === 11500);
      await go('10', '0', '4');
      const second = await page.locator('#shares li').allInnerTexts();
      ck('a second click replaces the first result with 2.50 four times', second.length === 4 && second.every(t => t.includes('2.50')) && (await text(page, '#grand')).includes('10.00'));
      await go('10', '0', '0');
      ck('zero people shows Check the numbers and an empty list', (await text(page, '#error')).includes('Check the numbers') && (await page.locator('#shares li').count()) === 0);
      await go('10', '0', '3');
      ck('a good split afterwards clears the error', (await text(page, '#error')) === '' && (await page.locator('#shares li').count()) === 3);
    },
    oracle: {
      'index.html': '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Split a bill</title></head><body><main><h1>Split a bill</h1><label for="total">Total</label><input id="total" type="number" step="0.01"><label for="tip">Tip percent</label><input id="tip" type="number" step="any"><label for="people">People</label><input id="people" type="number"><button id="go" type="button">Split it</button><p id="grand"></p><p id="error"></p><ol id="shares"></ol></main><script src="app.js"></script></body></html>',
      'app.js': "document.getElementById('go').addEventListener('click', function () {\n  var total = parseFloat(document.getElementById('total').value); var tip = parseFloat(document.getElementById('tip').value || '0'); var people = Number(document.getElementById('people').value);\n  var list = document.getElementById('shares'); var err = document.getElementById('error'); list.textContent = ''; err.textContent = ''; document.getElementById('grand').textContent = '';\n  if (!isFinite(total) || !isFinite(tip) || !Number.isInteger(people) || people < 1) { err.textContent = 'Check the numbers'; return; }\n  var cents = Math.round(total * (1 + tip / 100) * 100); var base = Math.floor(cents / people); var extra = cents - base * people;\n  document.getElementById('grand').textContent = 'Grand: ' + (cents / 100).toFixed(2);\n  for (var i = 0; i < people; i++) { var li = document.createElement('li'); li.textContent = ((base + (i < extra ? 1 : 0)) / 100).toFixed(2); list.appendChild(li); }\n});",
    },
    broken: { patch: ['app.js', '(base + (i < extra ? 1 : 0))', '(base + 0)'] },
  },
  {
    id: 'checklist',
    title: 'An onboarding checklist that remembers',
    spec: {
      must: [
        'A text input with id item (with a label) and a button labeled Add item',
        'Adding puts a list item in an unordered list with id list, with a checkbox and the text. An empty or blank item adds nothing',
        'Checking a box marks that item done by giving its list item the class done. Unchecking removes it',
        'An element with id progress always says how many are done out of how many, written like 1 of 3 done',
        'A button labeled Clear done removes every checked item',
        'The items and which are checked are still there after the page is reloaded',
      ],
      how_we_know: ['Add three items, check one, reload the page: three items, one checked, and 1 of 3 done'],
      out_of_scope: ['Any network request', 'Anything saved outside the browser'],
    },
    async accept(page, ck, url) {
      await page.goto(url);
      const add = async value => { await page.locator('#item').fill(value); await page.getByRole('button', { name: 'Add item' }).click(); };
      await add('Badge'); await add('Laptop'); await add('   '); await add('Training');
      ck('three items were added and the blank one was ignored', (await page.locator('#list li').count()) === 3);
      ck('starts at 0 of 3 done', (await text(page, '#progress')).includes('0 of 3 done'));
      await page.locator('#list li').first().locator('input[type=checkbox]').check();
      ck('checking gives the item the class done and says 1 of 3 done', (await page.locator('#list li.done').count()) === 1 && (await text(page, '#progress')).includes('1 of 3 done'));
      await page.reload();
      ck('after a reload there are still three items, one of them done', (await page.locator('#list li').count()) === 3 && (await page.locator('#list li.done').count()) === 1 && (await page.locator('#list li input:checked').count()) === 1);
      ck('after a reload the progress still says 1 of 3 done', (await text(page, '#progress')).includes('1 of 3 done'));
      await page.getByRole('button', { name: 'Clear done' }).click();
      ck('Clear done removes the checked item and says 0 of 2 done', (await page.locator('#list li').count()) === 2 && (await text(page, '#progress')).includes('0 of 2 done'));
    },
    oracle: {
      'index.html': '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Checklist</title><link rel="stylesheet" href="style.css"></head><body><main><h1>Onboarding checklist</h1><label for="item">Item</label><input id="item" type="text"><button id="add" type="button">Add item</button><button id="clear" type="button">Clear done</button><p id="progress"></p><ul id="list"></ul></main><script src="app.js"></script></body></html>',
      'style.css': 'li.done span{text-decoration:line-through}',
      'app.js': "var KEY = 'checklist'; var items = [];\ntry { items = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { items = []; }\nfunction save() { localStorage.setItem(KEY, JSON.stringify(items)); }\nfunction draw() {\n  var list = document.getElementById('list'); list.textContent = '';\n  items.forEach(function (it, i) { var li = document.createElement('li'); if (it.done) li.className = 'done'; var box = document.createElement('input'); box.type = 'checkbox'; box.checked = it.done; box.addEventListener('change', function () { items[i].done = box.checked; save(); draw(); }); var span = document.createElement('span'); span.textContent = it.text; li.appendChild(box); li.appendChild(span); list.appendChild(li); });\n  document.getElementById('progress').textContent = items.filter(function (x) { return x.done; }).length + ' of ' + items.length + ' done';\n}\ndocument.getElementById('add').addEventListener('click', function () { var v = document.getElementById('item').value.trim(); if (!v) return; items.push({ text: v, done: false }); document.getElementById('item').value = ''; save(); draw(); });\ndocument.getElementById('clear').addEventListener('click', function () { items = items.filter(function (x) { return !x.done; }); save(); draw(); });\ndraw();",
    },
    broken: { patch: ['app.js', "items[i].done = box.checked; save(); draw();", "items[i].done = box.checked; draw();"] },
  },
  {
    id: 'compare',
    title: 'Compare two email lists',
    spec: {
      must: [
        'Two textareas with ids list-a and list-b, each with a label, one email per line, and a button labeled Compare',
        'Emails are compared ignoring capital letters and spaces around them. Blank lines are ignored and an email repeated within one list counts once',
        'Three unordered lists: only-a (in A but not B), only-b (in B but not A) and both. Each shows the emails in lower case, sorted A to Z',
        'An element with id counts says how many are in each, written like 1 only in A, 1 only in B, 2 in both',
        'Clicking again replaces the earlier result',
      ],
      how_we_know: ['List A is Ann@example.com, bob@example.com, a padded copy of bob@example.com and cara@example.com. List B is BOB@example.com, dan@example.com and cara@Example.com. The result is ann in only A, dan in only B, and bob and cara in both'],
      out_of_scope: ['Any network request', 'Checking that an email is real'],
    },
    async accept(page, ck, url) {
      await page.goto(url);
      await page.locator('#list-a').fill('Ann@example.com\nbob@example.com\n  bob@example.com  \ncara@example.com');
      await page.locator('#list-b').fill('BOB@example.com\ndan@example.com\ncara@Example.com\n\n');
      await page.getByRole('button', { name: 'Compare' }).click();
      const list = async id => (await page.locator(`#${id} li`).allInnerTexts()).map(t => t.trim());
      ck('only in A is just ann@example.com', JSON.stringify(await list('only-a')) === JSON.stringify(['ann@example.com']));
      ck('only in B is just dan@example.com', JSON.stringify(await list('only-b')) === JSON.stringify(['dan@example.com']));
      ck('both is bob@example.com and cara@example.com, sorted', JSON.stringify(await list('both')) === JSON.stringify(['bob@example.com', 'cara@example.com']));
      ck('the counts line says 1 only in A, 1 only in B, 2 in both', (await text(page, '#counts')).includes('1 only in A, 1 only in B, 2 in both'));
      await page.locator('#list-a').fill('zed@example.com');
      await page.locator('#list-b').fill('');
      await page.getByRole('button', { name: 'Compare' }).click();
      ck('a second click replaces the first result', JSON.stringify(await list('only-a')) === JSON.stringify(['zed@example.com']) && (await list('both')).length === 0 && (await text(page, '#counts')).includes('1 only in A, 0 only in B, 0 in both'));
    },
    oracle: {
      'index.html': '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Compare lists</title></head><body><main><h1>Compare two lists</h1><label for="list-a">List A</label><textarea id="list-a" rows="5"></textarea><label for="list-b">List B</label><textarea id="list-b" rows="5"></textarea><button id="go" type="button">Compare</button><p id="counts"></p><h2>Only in A</h2><ul id="only-a"></ul><h2>Only in B</h2><ul id="only-b"></ul><h2>Both</h2><ul id="both"></ul></main><script src="app.js"></script></body></html>',
      'app.js': "function parse(id) { var seen = {}; var out = []; document.getElementById(id).value.split('\\n').forEach(function (line) { var e = line.trim().toLowerCase(); if (e && !seen[e]) { seen[e] = true; out.push(e); } }); return out; }\nfunction fill(id, rows) { var ul = document.getElementById(id); ul.textContent = ''; rows.sort().forEach(function (r) { var li = document.createElement('li'); li.textContent = r; ul.appendChild(li); }); }\ndocument.getElementById('go').addEventListener('click', function () {\n  var a = parse('list-a'); var b = parse('list-b');\n  var onlyA = a.filter(function (x) { return b.indexOf(x) < 0; }); var onlyB = b.filter(function (x) { return a.indexOf(x) < 0; }); var both = a.filter(function (x) { return b.indexOf(x) >= 0; });\n  fill('only-a', onlyA); fill('only-b', onlyB); fill('both', both);\n  document.getElementById('counts').textContent = onlyA.length + ' only in A, ' + onlyB.length + ' only in B, ' + both.length + ' in both';\n});",
    },
    broken: { patch: ['app.js', "var e = line.trim().toLowerCase();", "var e = line;"] },
  },
  {
    id: 'due',
    title: 'A due-date list that flags what is overdue',
    spec: {
      must: [
        'A date input with id today (with a label), a text input with id task, a date input with id due, and a button labeled Add task',
        'Adding puts a list item in an unordered list with id tasks, showing the task and its due date. Nothing is added if the task text is empty or no due date is chosen',
        'The list is always in due-date order, earliest first. Two tasks with the same date stay in the order they were added',
        'A task whose due date is before the date in today gets the class overdue and shows the word Overdue',
        'Changing the today date updates which tasks are overdue straight away, without adding anything',
      ],
      how_we_know: ['With today set to 2026-03-10, tasks B due 2026-03-20, A due 2026-03-05 and C due 2026-03-10 list as A, C, B and only A is overdue'],
      out_of_scope: ['Any network request', 'Saving anything'],
    },
    async accept(page, ck, url) {
      await page.goto(url);
      await page.locator('#today').fill('2026-03-10');
      const add = async (name, due) => { await page.locator('#task').fill(name); await page.locator('#due').fill(due); await page.getByRole('button', { name: 'Add task' }).click(); };
      await add('B', '2026-03-20'); await add('A', '2026-03-05'); await add('C', '2026-03-10'); await add('', '2026-03-01'); await add('D', '');
      const rows = await page.locator('#tasks li').allInnerTexts();
      ck('three tasks, with the empty and the undated ones ignored', rows.length === 3);
      ck('they are in due-date order A, C, B', /^A/.test(rows[0].trim()) && /^C/.test(rows[1].trim()) && /^B/.test(rows[2].trim()));
      ck('only A is overdue when today is 2026-03-10', (await page.locator('#tasks li.overdue').count()) === 1 && /Overdue/.test(rows[0]) && !/Overdue/.test(rows[1]) && !/Overdue/.test(rows[2]));
      await page.locator('#today').fill('2026-03-25');
      ck('moving today to 2026-03-25 makes all three overdue straight away', (await page.locator('#tasks li.overdue').count()) === 3);
      await page.locator('#today').fill('2026-03-01');
      ck('moving today back to 2026-03-01 clears them all', (await page.locator('#tasks li.overdue').count()) === 0);
      await add('E', '2026-03-05');
      const after = await page.locator('#tasks li').allInnerTexts();
      ck('a later task with a tied date comes after the earlier one', /^A/.test(after[0].trim()) && /^E/.test(after[1].trim()));
    },
    oracle: {
      'index.html': '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Due dates</title></head><body><main><h1>Due dates</h1><label for="today">Today</label><input id="today" type="date"><label for="task">Task</label><input id="task" type="text"><label for="due">Due</label><input id="due" type="date"><button id="add" type="button">Add task</button><ul id="tasks"></ul></main><script src="app.js"></script></body></html>',
      'app.js': "var tasks = [];\nfunction draw() {\n  var today = document.getElementById('today').value; var ul = document.getElementById('tasks'); ul.textContent = '';\n  tasks.slice().sort(function (a, b) { return a.due < b.due ? -1 : a.due > b.due ? 1 : a.n - b.n; }).forEach(function (t) { var li = document.createElement('li'); var over = today && t.due < today; if (over) li.className = 'overdue'; li.textContent = t.text + ' (due ' + t.due + ')' + (over ? ' Overdue' : ''); ul.appendChild(li); });\n}\nvar counter = 0;\ndocument.getElementById('add').addEventListener('click', function () { var text = document.getElementById('task').value.trim(); var due = document.getElementById('due').value; if (!text || !due) return; tasks.push({ text: text, due: due, n: counter++ }); document.getElementById('task').value = ''; draw(); });\ndocument.getElementById('today').addEventListener('input', draw);\ndocument.getElementById('today').addEventListener('change', draw);",
    },
    broken: { patch: ['app.js', "a.due > b.due ? 1 : a.n - b.n", "a.due > b.due ? 1 : b.n - a.n"] },
  },
];
