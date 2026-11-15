let currentPackage = null;
const lines = value => String(value || '').split('\n').map(line => line.trim()).filter(Boolean);
const node = (tag, text) => { const element = document.createElement(tag); element.textContent = text; return element; };
function error(form, message) {
  let box = form.querySelector('[role=alert]');
  if (!box) { box = node('p', ''); box.setAttribute('role', 'alert'); form.append(box); }
  box.textContent = message;
}
async function post(path, body) {
  const me = await (await fetch('/api/me')).json();
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': me.csrf }, body: JSON.stringify(body) });
  if (!response.ok) throw Error('Request refused');
  return response.json();
}
document.addEventListener('submit', async event => {
  const form = event.target;
  if (!form.matches('form')) return;
  event.preventDefault();
  try {
    const input = Object.fromEntries(new FormData(form));
    if (form.hasAttribute('data-analysis-package')) {
      currentPackage = null;
      document.querySelector('[data-analysis-export]').hidden = true;
      document.querySelector('[data-analysis-answer]').hidden = true;
      const request = { question: input.question, objectives: lines(input.objectives), constraints: lines(input.constraints), items: lines(input.items),
        from: new Date(input.from + 'Z').toISOString(), to: new Date(input.to + 'Z').toISOString() };
      currentPackage = await post('/api/intelligence/package', request);
      document.querySelector('[data-analysis-prompt]').value = JSON.stringify(currentPackage, null, 2);
      document.querySelector('[data-analysis-export]').hidden = false;
    } else if (form.hasAttribute('data-analysis-review') && currentPackage) {
      document.querySelector('[data-analysis-answer]').hidden = true;
      const result = await post('/api/intelligence/review', { request: currentPackage.request, package_hash: currentPackage.hash, answer: input.answer });
      const panel = document.querySelector('[data-analysis-answer]'); panel.replaceChildren(node('h2', 'Review the model answer'), node('p', result.label));
      const answer = result.answer;
      panel.append(node('h3', 'Question'), node('p', answer.question));
      for (const key of ['objectives', 'constraints', 'coverage_notes', 'tradeoffs', 'missingness']) {
        panel.append(node('h3', key.replaceAll('_', ' '))); const list = node('ul', ''); for (const line of answer[key]) list.append(node('li', line)); panel.append(list);
      }
      for (const finding of answer.findings) {
        panel.append(node('h3', `${finding.status}: ${finding.claim}`));
        const citations = node('ul', '');
        for (const ref of finding.citations) { const li = node('li', ''), link = node('a', `Source ${ref.item}, version ${ref.hash}`); link.href = `/items/${encodeURIComponent(ref.item)}/record/${encodeURIComponent(ref.hash)}`; li.append(link); citations.append(li); }
        panel.append(citations);
        for (const key of ['alternatives', 'uncertainty', 'next_investigation']) { panel.append(node('h4', key.replaceAll('_', ' '))); for (const line of finding[key]) panel.append(node('p', line)); }
      }
      panel.append(node('h3', 'Correction path'), node('p', answer.correction_path)); panel.hidden = false;
    }
    form.querySelector('[role=alert]')?.remove();
  } catch {
    error(form, 'This could not be checked. Use observable work questions, complete objectives and constraints, existing item IDs, and a past UTC range. Answers need the exact supplied format and source hashes. If sources changed, prepare a fresh packet.');
  }
});
document.addEventListener('click', async event => {
  if (!event.target.closest?.('[data-analysis-copy]') || !currentPackage) return;
  const status = document.querySelector('[data-analysis-copy-status]');
  try { await navigator.clipboard.writeText(document.querySelector('[data-analysis-prompt]').value); status.textContent = 'Copied. Review the data before pasting into your chosen AI.'; }
  catch { status.textContent = 'Select the packet text and copy it manually.'; }
});
