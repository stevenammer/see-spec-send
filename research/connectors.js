// Connectors are operator-supplied code, never names or URLs supplied by a post.
// No source is connected by default. A connector receives workspace data only.
export const RESEARCH_SOURCES = Object.freeze([
  'internal tools and licenses', 'internal prior work', 'configuration options',
  'open source', 'commercial options', 'process change',
]);

export async function researchRecord({ connectors = {}, input, at } = {}) {
  const sources = {};
  for (const source of RESEARCH_SOURCES) {
    if (typeof connectors[source] !== 'function') {
      sources[source] = { status: 'not connected', finding: 'nothing checked', checkedAt: null };
      continue;
    }
    try {
      const finding = await connectors[source](input);
      if (typeof finding !== 'string' || !finding.trim() || finding.length > 2000)
        throw new Error('invalid connector result');
      sources[source] = { status: 'checked', finding, checkedAt: at };
    } catch {
      sources[source] = { status: 'failed', finding: 'source failed; no result verified', checkedAt: at };
    }
  }
  return sources;
}
