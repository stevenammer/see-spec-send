const value = form => Object.fromEntries(new FormData(form));
const sessionless = new Set(['/api/login', '/api/invite/redeem']);

// Every other POST needs the session's CSRF token, so fetch it first.
async function post(path, input) {
  const headers = { 'content-type': 'application/json' };
  if (!sessionless.has(path)) {
    const me = await (await fetch('/api/me')).json();
    headers['x-csrf-token'] = me.csrf;
  }
  const response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(input) });
  if (!response.ok) throw new Error('That did not go through.');
  return response.status === 204 ? {} : response.json();
}

// Show a problem next to the form, not in a blocking pop-up.
function showError(form, message) {
  let box = form.querySelector('[role=alert]');
  if (!box) {
    box = document.createElement('p');
    box.setAttribute('role', 'alert');
    box.className = 'error';
    form.append(box);
  }
  box.textContent = message;
}

document.addEventListener('submit', async event => {
  const form = event.target;
  if (!form.matches('form') || form.hasAttribute('data-quest-form')) return;
  event.preventDefault();
  try {
    const input = value(form);
    if (form.dataset.api) {
      const out = await post(form.dataset.api, input);
      location.href = form.dataset.nextItem ? `/items/${out.id}` : form.dataset.next;
      return;
    }
    const id = location.pathname.split('/').at(-1);
    if (form.dataset.approve) {
      await post('/api/stepup', { password: input.password });
      const approval = { type: 'approved', spec_hash: input.spec_hash,
        cap_usd: Number(input.cap_usd), quorum: Number(input.quorum) };
      if (input.packet_hash) Object.assign(approval, { packet_hash: input.packet_hash, reason: input.reason });
      else approval.expected_seq = Number(input.expected_seq);
      await post(`/api/items/${id}/events`, approval);
    } else if (form.dataset.send) {
      await post(`/api/items/${id}/send`, { spec_hash: input.spec_hash });
    } else if (form.dataset.fork) {
      const out = await post(`/api/items/${id}/fork`, { reason: input.reason });
      location.href = `/items/${out.id}`;
      return;
    } else if (form.dataset.steer) {
      await post(`/api/items/${id}/steer`, { instruction: input.instruction });
    } else if (form.dataset.include) {
      await post(`/api/items/${id}/events`, { type: 'revised', text: input.text,
        base_hash: form.closest('main').querySelector('form[data-event="revised"] input[name="base_hash"]').value,
        credits: [{ comment: input.comment, mode: 'paraphrased' }] });
    } else if (form.dataset.artifact) {
      await post(`/api/items/${id}/artifact`, { html: input.html });
    } else {
      const data = { type: form.dataset.event, ...input };
      if (data.type === 'specced') {
        for (const key of ['must', 'how_we_know', 'out_of_scope']) {
          data[key] = String(data[key] ?? '').split('\n').filter(Boolean);
        }
      }
      await post(`/api/items/${id}/events`, data);
    }
    location.reload();
  } catch {
    showError(form, 'That did not go through. Check the form and try again.');
  }
});
