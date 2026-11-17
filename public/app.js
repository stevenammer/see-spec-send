const value = form => Object.fromEntries(new FormData(form));
const scopeValue = input => ({ data_sources: String(input.scope_data_sources || '').split('\n').map(value => value.trim()).filter(Boolean), audiences: String(input.scope_audiences || '').split('\n').map(value => value.trim()).filter(Boolean) });
const sessionless = new Set(['/api/login', '/api/invite/redeem']);

// Say what went wrong in words a person can act on. Sign-in and invite failures stay vague on purpose, so nobody can
// use them to find out which IDs exist.
function explain(path, status) {
  if (path === '/api/login') return "That ID and password didn't work. If you just made a wrong try, wait about 10 seconds and try again, because each wrong try makes the next wait longer. Check that caps lock is off.";
  if (path === '/api/invite/redeem') return "That invite didn't work. Check that you copied all of it. It may have been used already, it may have expired, or that ID may be taken. If it keeps failing, ask whoever sent it for a new one.";
  if (path === '/api/stepup') return "That password didn't work, so nothing was changed. Check that caps lock is off and try again.";
  if (status === 409) return 'This post may have frozen or changed. Copy your draft and refresh before trying again.';
  if (status === 401 || status === 403) return "You may have been signed out, or you don't have permission to do this. Sign in again in a new tab, then come back and press the button again. What you typed is still here.";
  if (status === 413) return 'That is too long to send. Shorten it and try again.';
  if (status === 429) return 'Too many tries too fast. Wait a minute, then try again.';
  if (status >= 500) return 'Something went wrong on the server. Nothing you typed was lost. Try again in a moment.';
  return 'That did not go through. Check the form and try again.';
}

// A password prompt that hides what you type (the browser's built-in pop-up shows it in plain text).
function askPassword(message) {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    const label = document.createElement('label'); label.textContent = message;
    const input = document.createElement('input'); input.type = 'password'; input.autocomplete = 'current-password'; label.append(input);
    const ok = document.createElement('button'); ok.textContent = 'Confirm';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
    const form = document.createElement('form'); form.method = 'dialog'; form.append(label, ok, cancel); dialog.append(form);
    let answer = '';
    form.addEventListener('submit', () => { answer = input.value; });
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { dialog.remove(); resolve(answer); });
    document.body.append(dialog); dialog.showModal(); input.focus();
  });
}

// Every other POST needs the session's CSRF token, so fetch it first.
async function post(path, input, idempotencyKey) {
  const headers = { 'content-type': 'application/json' };
  const active = document.querySelector('[data-active-post]');
  if (active) { headers['x-post-id'] = active.dataset.activePost; headers['x-post-version'] = active.dataset.postVersion; }
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  if (!sessionless.has(path)) {
    const me = await (await fetch('/api/me')).json();
    headers['x-csrf-token'] = me.csrf;
  }
  let response;
  try { response = await fetch(path, { method: 'POST', headers, body: JSON.stringify(input) }); }
  catch { throw new Error("Couldn't reach the server. Check your connection, then try again. What you typed is still here."); }
  if (!response.ok) throw new Error(explain(path, response.status));
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

// Sign out ends the session on the server, then returns to the sign-in page.
document.addEventListener('click', async event => {
  if (!event.target.closest?.('[data-signout]')) return;
  try { await post('/api/logout', {}); } catch { /* already signed out: still go to the sign-in page */ }
  location.href = '/signin';
});

// Long boxes cut text off at their limit. Say so, instead of losing the end of a paste in silence.
function limitNote(field) {
  let note = field.parentElement.querySelector('.limit-note');
  if (!note) { note = document.createElement('small'); note.className = 'limit-note'; note.setAttribute('role', 'status'); field.insertAdjacentElement('afterend', note); }
  return note;
}
document.addEventListener('input', event => {
  const field = event.target;
  if (!field.matches?.('textarea[maxlength]')) return;
  const max = Number(field.maxLength), used = field.value.length;
  if (max >= 200 && used >= max * 0.8) limitNote(field).textContent = used >= max ? `${used.toLocaleString()} of ${max.toLocaleString()} characters. This is the limit.` : `${used.toLocaleString()} of ${max.toLocaleString()} characters.`;
  else field.parentElement.querySelector('.limit-note')?.remove();
});
document.addEventListener('paste', event => {
  const field = event.target;
  if (!field.matches?.('textarea[maxlength]')) return;
  const text = event.clipboardData?.getData('text') || '';
  const room = Number(field.maxLength) - (field.value.length - (field.selectionEnd - field.selectionStart));
  if (text.length > room) setTimeout(() => { limitNote(field).textContent = `What you pasted was longer than the ${Number(field.maxLength).toLocaleString()}-character limit, so the end was cut off. Shorten it or split it into two posts.`; }, 0);
});

document.addEventListener('submit', async event => {
  const form = event.target;
  if (!form.matches('form') || form.hasAttribute('data-quest-form')) return;
  if (form.closest?.('dialog')?.tagName === 'DIALOG') return;  // the password pop-up closes itself
  event.preventDefault();
  let release = () => {};
  if (form.dataset.busy) return;  // a second click or Enter while the first is still going
  try {
    const input = value(form);
    for (const field of form.querySelectorAll?.('textarea[required],input[type=text][required]') || []) {
      if (!field.value.trim()) { field.focus(); throw new Error('Write something in the box first. A blank answer cannot be sent.'); }
    }
    form.dataset.busy = '1';
    const buttons = [...(form.querySelectorAll?.('button') || [])].filter(button => !button.disabled);
    for (const button of buttons) button.disabled = true;
    release = () => { delete form.dataset.busy; for (const button of buttons) button.disabled = false; };
    if (typeof setTimeout === 'function') setTimeout(() => release(), 20000);
    if (form.dataset.admin) {
      const path = form.dataset.admin === 'person' ? '/api/admin/person' : form.dataset.admin === 'retention' ? '/api/admin/retention' : '/api/admin/hold';
      if (input.action === undefined && form.dataset.admin === 'hold') input.action = 'set';
      // A button's value is not part of the form data, so read it from the button that was pressed.
      if (input.action === undefined && form.dataset.admin === 'person') input.action = event.submitter?.value;
      const me = await (await fetch('/api/me')).json();
      if (me.auth_method === 'oidc') { if (!me.stepup_fresh) { location.href = '/api/oidc/stepup/start?next=/admin'; return; } }
      else {
        const password = await askPassword('Enter your password to confirm this administration change');
        if (!password) throw new Error('Nothing was changed, because no password was entered.');
        await post('/api/stepup', { password });
      }
      await post(path, input); location.reload(); return;
    }
    if (form.dataset.api) {
      const out = await post(form.dataset.api, input);
      location.href = form.dataset.nextItem ? `/items/${out.id}` : form.dataset.next;
      return;
    }
    const id = location.pathname.match(/^\/items\/([^/]+)/)?.[1] ?? location.pathname.split('/').at(-1);
    if (form.dataset.password) {
      try { await post('/api/stepup', { password: input.current }); } catch { throw new Error('The temporary password is not right. Type it exactly as it was given to you; capital letters matter.'); }
      try { await post('/api/password', { password: input.password }); } catch { throw new Error('That new password was refused. Use at least 12 characters and avoid common or easily guessed passwords.'); }
      location.href = '/';
      return;
    }
    if (form.dataset.approve) {
      if (input.password === undefined) {
        // Single sign-on: no fresh sign-in yet means go to the identity provider and come back to this page.
        if (!form.querySelector('[data-sso-ready]')) { location.href = `/api/oidc/stepup/start?next=${encodeURIComponent(location.pathname)}`; return; }
      } else await post('/api/stepup', { password: input.password });
      const approval = { type: 'approved', spec_hash: input.spec_hash,
        cap_usd: Number(input.cap_usd), quorum: Number(input.quorum) };
      if (input.max_iterations !== undefined) approval.max_iterations = Number(input.max_iterations);
      if (input.window_minutes !== undefined) approval.window_minutes = Number(input.window_minutes);
      if (input.packet_hash) Object.assign(approval, { packet_hash: input.packet_hash, reason: input.reason });
      else approval.expected_seq = Number(input.expected_seq);
      await post(`/api/items/${id}/events`, approval);
    } else if (form.dataset.decision) {
      const disposition = input.disposition;
      const fields = {
        return_for_revision: ['needed', 'next_reviewer'], defer: ['owner', 'review_by', 'trigger', 'interim_work'],
        redirect: ['destination', 'accepted', 'follow_up_owner'], resolve_without_build: ['alternative', 'action_owner'],
        decline: ['reconsider_if'], prohibited: ['policy_class'],
      }[disposition];
      const metadata = Object.fromEntries(fields.filter(key => input[key]?.trim())
        .map(key => [key, key === 'accepted' ? input[key] === 'true' : input[key].trim()]));
      await post(`/api/items/${id}/events`, { type: 'decided', disposition, reason_code: input.reason_code,
        reason: input.reason, metadata, spec_hash: input.spec_hash, packet_hash: input.packet_hash });
    } else if (form.dataset.specPrepare) {
      await post(`/api/items/${id}/spec-draft`, { see_hash: input.see_hash });
    } else if (form.dataset.research) {
      await post(`/api/items/${id}/research`, {});
    } else if (form.dataset.send) {
      await post(`/api/items/${id}/send`, { spec_hash: input.spec_hash, ...(input.estimate?.trim() ? { estimate: input.estimate.trim() } : {}) });
    } else if (form.dataset.fork || form.dataset.forkFrozen) {
      const from = !input.from ? undefined : input.from.startsWith('snapshot|')
        ? { kind: 'snapshot', post_id: input.from.split('|')[1], hash: input.from.split('|')[2] }
        : { kind: input.from.split(':')[0], hash: input.from.split(':')[1] };
      const request = { reason: input.reason, ...(from ? { from } : {}) };
      const requestBody = JSON.stringify(request);
      if (form.dataset.requestBody !== requestBody) {
        form.dataset.requestBody = requestBody;
        form.dataset.requestKey = crypto.randomUUID();
      }
      const out = await post(`/api/items/${id}/fork`, request, form.dataset.requestKey);
      location.href = `/items/${out.id}`;
      return;
    } else if (form.dataset.annexResponse) {
      await post(`/api/annexes/${form.dataset.annexResponse}/response`, { kind: event.submitter?.value });
    } else if (form.dataset.correction) {
      await post(`/api/knowledge/${form.dataset.correction}/correction`, { note: input.note });
    } else if (form.dataset.renew) {
      const out = await post(`/api/items/${id}/renew`, { annex: form.dataset.renew, what_is_new: input.what_is_new, reason: input.reason });
      location.href = `/items/${out.id}`;
      return;
    } else if (form.dataset.steer) {
      await post(`/api/items/${id}/steer`, { instruction: input.instruction });
    } else if (form.dataset.adopt) {
      await post(`/api/items/${id}/steer`, { instruction: input.instruction, source: input.source, mode: 'paraphrased' });
    } else if (form.dataset.include) {
      const mode = event.submitter?.value === 'quoted' ? 'quoted' : 'paraphrased';
      if (form.dataset.include === 'historical-spec') {
        const baseline = JSON.parse(input.baseline);
        await post(`/api/items/${id}/events`, { type: 'specced', see_hash: input.see_hash, base_spec_hash: input.base_spec_hash,
          ...baseline, must: [...baseline.must, input.source_text], credits: [{ comment: input.comment, mode }] });
      } else if (form.dataset.include === 'spec') {
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
      if (data.type === 'experiment_not_helpful') data.approval = Number(data.approval);
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
        if (input.estimate_dimension) {
          data.estimates = [{ dimension: input.estimate_dimension, low: Number(input.estimate_low), high: Number(input.estimate_high), unit: input.estimate_unit,
            basis: input.estimate_basis?.trim() ? [{ kind: input.estimate_basis_kind || 'author_judgment', ref: input.estimate_basis.trim() }] : [],
            unknowns: String(input.estimate_unknowns || '').split('\n').filter(Boolean), alternatives: String(input.estimate_alternatives || '').split('\n').filter(Boolean) }];
        }
        if (input.ledger_json) {
          const ledger = JSON.parse(input.ledger_json);
          data.ledger = ledger.map(entry => ({ ...entry, status: input[`ledger_status_${entry.id}`] || entry.status,
            refs: input[`ledger_ref_${entry.id}`] ? [...new Set([...(entry.refs || []), input[`ledger_ref_${entry.id}`]])] : entry.refs || [] }));
        }
        for (const key of ['estimate_dimension', 'estimate_low', 'estimate_high', 'estimate_unit', 'estimate_basis', 'estimate_basis_kind', 'estimate_unknowns', 'estimate_alternatives']) delete data[key];
        delete data.ledger_json;
        for (const key of Object.keys(data)) if (key.startsWith('ledger_status_') || key.startsWith('ledger_ref_')) delete data[key];
      }
      if (data.type === 'commented' && input.resolves_ledger_id) {
        data.resolves = { ledger_id: input.resolves_ledger_id, claim: input.resolves_claim };
        delete data.resolves_ledger_id; delete data.resolves_claim;
      }
      await post(`/api/items/${id}/events`, data);
    }
    location.reload();
  } catch (error) {
    release();
    showError(form, error.message || 'That did not go through. Check the form and try again.');
  }
});

