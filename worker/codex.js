import { OpenCodeAdapter } from './opencode.js';

// Codex (OpenAI's agent CLI) as the builder, in the same locked container profile as OpenCode and Claude Code: no network
// except the metered gateway on a Unix socket, no provider key, a read-only root, dropped capabilities, one writable /work.
// It speaks OpenAI's Responses API; the gateway translates that to the provider the organization configured
// (gateway/responses.js), so every call is reserved, capped and settled like any other. Everything else (the run-bound
// capability, the bundle validator, the one repair pass, the wall clock) is the OpenCode adapter's, unchanged.
export class CodexAdapter extends OpenCodeAdapter {
  constructor(store, options = {}) {
    super(store, { imageFile: new URL('./codex-image.digest', import.meta.url), ...options });
  }
  name(id) { return `sss-codex-${id.slice(0, 24)}`; }
}
