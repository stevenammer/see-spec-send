const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

export function renderThread(events, context) {
  const comments = events.filter(event => event.type === 'commented' && event.anchor_kind === 'see');
  const byParent = new Map();
  for (const comment of comments) {
    const key = comment.parent || '';
    const list = byParent.get(key) || [];
    list.push(comment); byParent.set(key, list);
  }
  const render = parent => `<ol>${(byParent.get(parent) || []).map(comment =>
    `<li><p><strong>${escape(comment.actor)}</strong> (${escape(comment.kind)}): ${escape(comment.comment)}</p>` +
      `<form data-event="commented"><input type="hidden" name="anchor_kind" value="see"><input type="hidden" name="anchor_hash" value="${escape(context.seeHash)}"><input type="hidden" name="parent" value="${escape(comment.body_hash)}"><input type="hidden" name="kind" value="comment"><label>Reply<textarea name="comment" required maxlength="4000"></textarea></label><button>Reply</button></form>${render(comment.body_hash)}</li>`
  ).join('')}</ol>`;
  return render('');
}
