import { OpenCodeAdapter } from './opencode.js';

// Claude Code (Anthropic's agent CLI) as the builder, in the same locked container profile as OpenCode: no network except
// the metered gateway on a Unix socket, no provider key, a read-only root, dropped capabilities, one writable /work. It
// speaks Anthropic's Messages API; the gateway translates that to the provider the organization configured (gateway/
// anthropic.js), so every call is reserved, capped and settled like any other. Everything else (the run-bound capability,
// the bundle validator, the one repair pass, the wall clock) is the OpenCode adapter's, unchanged.
export class ClaudeCodeAdapter extends OpenCodeAdapter {
  constructor(store, options = {}) {
    super(store, { imageFile: new URL('./claudecode-image.digest', import.meta.url), ...options });
  }
  name(id) { return `sss-claudecode-${id.slice(0, 24)}`; }
}
