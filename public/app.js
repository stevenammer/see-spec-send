const value = form => Object.fromEntries(new FormData(form));
const scopeValue = input => ({ data_sources: String(input.scope_data_sources || '').split('\n').map(value => value.trim()).filter(Boolean), audiences: String(input.scope_audiences || '').split('\n').map(value => value.trim()).filter(Boolean) });
const sessionless = new Set(['/api/login', '/api/invite/redeem']);

// Every other POST needs the session's CSRF token, so fetch it first.
async function post(path, input, idempotencyKey) {
  const headers = { 'content-type': 'application/json' };
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
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

document.addEventListener('click', event => {
  const button = event.target.closest?.('[data-spec-draft]');
  if (!button) return;
  const form = document.querySelector('form[data-event="specced"]');
  if (!form) return;
  try {
    const draft = JSON.parse(button.dataset.specDraft);
    for (const key of ['must', 'how_we_know', 'out_of_scope', 'assumptions', 'open_questions']) {
      if (!Array.isArray(draft[key]) || !draft[key].every(line => typeof line === 'string')) throw Error('Invalid draft');
      form.elements[key].value = draft[key].join('\n');
    }
    form.dataset.draftSource = button.dataset.source;
    form.scrollIntoView({ block: 'center' }); form.elements.must.focus();
  } catch { showError(form, 'This draft could not be read. You can write the spec yourself.'); }
});

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
    const id = location.pathname.match(/^\/items\/([^/]+)/)?.[1] ?? location.pathname.split('/').at(-1);
    if (form.dataset.password) {
      await post('/api/stepup', { password: input.current });
      await post('/api/password', { password: input.password });
      location.href = '/';
      return;
    }
    if (form.dataset.approve) {
      await post('/api/stepup', { password: input.password });
      const approval = { type: 'approved', spec_hash: input.spec_hash,
        cap_usd: Number(input.cap_usd), quorum: Number(input.quorum) };
      if (input.max_iterations !== undefined) approval.max_iterations = Number(input.max_iterations);
      if (input.window_minutes !== undefined) approval.window_minutes = Number(input.window_minutes);
      if (input.packet_hash) Object.assign(approval, { packet_hash: input.packet_hash, reason: input.reason });
      else approval.expected_seq = Number(input.expected_seq);
      await post(`/api/items/${id}/events`, approval);
    } else if (form.dataset.specPrepare) {
      await post(`/api/items/${id}/spec-draft`, { see_hash: input.see_hash });
    } else if (form.dataset.research) {
      await post(`/api/items/${id}/research`, {});
    } else if (form.dataset.send) {
      await post(`/api/items/${id}/send`, { spec_hash: input.spec_hash, ...(input.estimate?.trim() ? { estimate: input.estimate.trim() } : {}) });
    } else if (form.dataset.fork) {
      const from = input.from ? { kind: input.from.split(':')[0], hash: input.from.split(':')[1] } : undefined;
      const request = { reason: input.reason, ...(from ? { from } : {}) };
      const requestBody = JSON.stringify(request);
      if (form.dataset.requestBody !== requestBody) {
        form.dataset.requestBody = requestBody;
        form.dataset.requestKey = crypto.randomUUID();
      }
      const out = await post(`/api/items/${id}/fork`, request, form.dataset.requestKey);
      location.href = `/items/${out.id}`;
      return;
    } else if (form.dataset.steer) {
      await post(`/api/items/${id}/steer`, { instruction: input.instruction });
    } else if (form.dataset.adopt) {
      await post(`/api/items/${id}/steer`, { instruction: input.instruction, source: input.source, mode: 'paraphrased' });
    } else if (form.dataset.include) {
      const mode = event.submitter?.value === 'quoted' ? 'quoted' : 'paraphrased';
      if (form.dataset.include === 'spec') {
        const scopeForm = form.closest('main').querySelector('form[data-event="specced"]');
        const scopeInput = scopeForm ? value(scopeForm) : null;
        await post(`/api/items/${id}/events`, { type: 'specced', see_hash: input.see_hash, base_spec_hash: input.base_spec_hash,
          must: String(input.must).split('\n').filter(Boolean), how_we_know: String(input.how_we_know).split('\n').filter(Boolean),
          out_of_scope: String(input.out_of_scope).split('\n').filter(Boolean),
          ...(scopeInput && Object.hasOwn(scopeInput, 'scope_data_sources') ? { scope: scopeValue(scopeInput) } : {}),
          ...Object.fromEntries(['assumptions', 'open_questions'].filter(key => scopeInput && Object.hasOwn(scopeInput, key)).map(key => [key, String(scopeInput[key]).split('\n').filter(Boolean)])), credits: [{ comment: input.comment, mode }] });
      } else await post(`/api/items/${id}/events`, { type: 'revised', text: input.text,
        base_hash: form.closest('main').querySelector('form[data-event="revised"] input[name="base_hash"]').value,
        credits: [{ comment: input.comment, mode }] });
    } else if (form.dataset.artifact) {
      await post(`/api/items/${id}/artifact`, { html: input.html });
    } else {
      const data = { type: form.dataset.event, ...input };
      if (['returned', 'not_built'].includes(data.type)) {
        for (const key of ['restricted_evidence', 'pivot_note']) if (!data[key]?.trim()) delete data[key];
      }
      if (data.type === 'checked_in' && Object.hasOwn(data, 'consent')) data.consent = data.consent === 'true';
      if (data.type === 'specced') {
        if (form.dataset.draftSource) data.credits = [{ comment: form.dataset.draftSource, mode: 'paraphrased' }];
        if (Object.hasOwn(input, 'scope_data_sources') || Object.hasOwn(input, 'scope_audiences')) data.scope = scopeValue(input);
        delete data.scope_data_sources; delete data.scope_audiences;
        for (const key of ['must', 'how_we_know', 'out_of_scope', ...['assumptions', 'open_questions'].filter(key => Object.hasOwn(input, key))]) {
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
