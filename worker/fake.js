// Adapter calls are short and synchronous. See docs/ADAPTER.md before adding an external adapter.
export class FakeAdapter {
  constructor(store) { this.db = store.db; }

  start(request) {
    const input = JSON.stringify(request);
    const prior = this.db.prepare('SELECT input FROM fake_jobs WHERE id=?').get(request.id);
    if (prior && prior.input !== input) throw new Error('run id reused with different input');
    const instructions = (request.instructions || []).map(row => String(row.instruction).replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value])).join('<br>');
    const html = `<!doctype html><title>Small try</title><h1>Small try</h1><p>Fixture builder. No model wrote this.</p><p>Approved spec: ${request.spec_hash}</p><p>${instructions}</p>`;
    this.db.prepare('INSERT OR IGNORE INTO fake_jobs VALUES(?,?,?,?)').run(request.id, input, html, 'ready');
  }

  status(id) {
    const row = this.db.prepare('SELECT status,html FROM fake_jobs WHERE id=?').get(id);
    return row ? { state: row.status, html: row.html } : { state: 'missing' };
  }

  stop(id) {
    // A tombstone fences a delayed start, including stop-before-start.
    this.db.prepare("INSERT INTO fake_jobs VALUES(?,'','', 'stopped') ON CONFLICT(id) DO UPDATE SET status='stopped'")
      .run(id);
    return { state: 'stopped' };
  }
}
