const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

export function renderThread(events, context, anchorKind = 'see') {
  const anchorHash = anchorKind === 'see' ? context.seeHash : anchorKind === 'spec' ? context.specHash : anchorKind === 'send' ? context.activePost?.version : context.artifact;
  const spec = context.currentSpec || events.filter(event => event.type === 'specced' && event.body_hash === context.specHash).at(-1);
  const joined = key => (spec?.[key] || []).join('\n');
  const comments = events.filter(event => event.type === 'commented' && event.anchor_kind === anchorKind);
  const byParent = new Map();
  for (const comment of comments) {
    const key = comment.parent || '';
    const list = byParent.get(key) || [];
    list.push(comment); byParent.set(key, list);
  }
  const render = parent => `<ol>${(byParent.get(parent) || []).map(comment =>
    `<li id="comment-${escape(comment.body_hash)}"><p><strong>${escape(comment.actor)}</strong>${comment.kind === 'agent' ? ' (Effort, AI)' : ` (${escape(comment.kind)})`}: ${escape(comment.comment)}</p>` +
      `${!context.readOnly && (context.rules !== 3 || comment.post_id === context.activePost?.id) && context.steward && anchorKind === 'artifact' ? `<form data-adopt="true"><input type="hidden" name="source" value="${escape(comment.body_hash)}"><label>Builder instruction<textarea name="instruction" required maxlength="4000">${escape(comment.comment)}</textarea></label><button>Adopt as builder instruction</button></form>` : !context.readOnly && anchorKind !== 'send' && (context.rules !== 3 || comment.post_id === context.activePost?.id) && context.steward && comment.kind !== 'agent' ? (anchorKind === 'spec' ? `<form data-include="spec"><input type="hidden" name="comment" value="${escape(comment.body_hash)}"><input type="hidden" name="see_hash" value="${escape(context.specSeeHash)}"><input type="hidden" name="base_spec_hash" value="${escape(context.specHash)}"><label>Must do<textarea name="must" required maxlength="4000">${escape([...((spec?.must) || []), comment.comment].join("\n"))}</textarea></label><label>How we'll know<textarea name="how_we_know" required>${escape(joined("how_we_know"))}</textarea></label><label>Out of scope<textarea name="out_of_scope">${escape(joined("out_of_scope"))}</textarea></label><button name="mode" value="quoted">Include</button><button name="mode" value="paraphrased">Paraphrase</button></form>` : `<form data-include="see"><input type="hidden" name="comment" value="${escape(comment.body_hash)}"><label>Include in SEE<textarea name="text" required maxlength="4000"></textarea></label><button name="mode" value="quoted">Include</button><button name="mode" value="paraphrased">Paraphrase</button></form>`) : ''}` +
      `${!context.readOnly && context.steward && comment.kind === 'alternative' && (context.rules !== 3 || comment.post_id === context.activePost?.id) ? `<form data-event="commented"><input type="hidden" name="anchor_kind" value="${escape(anchorKind)}"><input type="hidden" name="anchor_hash" value="${escape(anchorHash)}"><input type="hidden" name="parent" value="${escape(comment.body_hash)}"><input type="hidden" name="kind" value="decline"><label>Why not (shown to everyone)<textarea name="comment" required maxlength="4000">I'm not taking this into the current plan.</textarea></label><button>Decline this alternative</button></form>` : ''}` +
      `${context.readOnly || (context.rules === 3 && comment.post_id !== context.activePost?.id) ? '' : `<form data-event="commented"><input type="hidden" name="anchor_kind" value="${escape(anchorKind)}"><input type="hidden" name="anchor_hash" value="${escape(anchorHash)}"><input type="hidden" name="parent" value="${escape(comment.body_hash)}"><input type="hidden" name="kind" value="comment"><label>Reply<textarea name="comment" required maxlength="4000"></textarea></label><button>Reply</button></form>`}${render(comment.body_hash)}</li>`
  ).join('')}</ol>`;
  return render('');
}
