const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

export function renderThread(events, context, anchorKind = 'see') {
  const anchorHash = anchorKind === 'see' ? context.seeHash : anchorKind === 'spec' ? context.specHash : context.artifact;
  const comments = events.filter(event => event.type === 'commented' && event.anchor_kind === anchorKind);
  const byParent = new Map();
  for (const comment of comments) {
    const key = comment.parent || '';
    const list = byParent.get(key) || [];
    list.push(comment); byParent.set(key, list);
  }
  const render = parent => `<ol>${(byParent.get(parent) || []).map(comment =>
    `<li><p><strong>${escape(comment.actor)}</strong>${comment.kind === 'agent' ? ' (Effort, AI)' : ` (${escape(comment.kind)})`}: ${escape(comment.comment)}</p>` +
      `${context.steward && anchorKind === 'artifact' ? `<form data-adopt="true"><input type="hidden" name="source" value="${escape(comment.body_hash)}"><label>Builder instruction<textarea name="instruction" required maxlength="4000">${escape(comment.comment)}</textarea></label><button>Adopt as builder instruction</button></form>` : context.steward ? `<form data-include="true"><input type="hidden" name="comment" value="${escape(comment.body_hash)}"><label>Include in SEE<textarea name="text" required maxlength="4000"></textarea></label><button>Include</button></form>` : ''}` +
      `<form data-event="commented"><input type="hidden" name="anchor_kind" value="${escape(anchorKind)}"><input type="hidden" name="anchor_hash" value="${escape(anchorHash)}"><input type="hidden" name="parent" value="${escape(comment.body_hash)}"><input type="hidden" name="kind" value="comment"><label>Reply<textarea name="comment" required maxlength="4000"></textarea></label><button>Reply</button></form>${render(comment.body_hash)}</li>`
  ).join('')}</ol>`;
  return render('');
}
