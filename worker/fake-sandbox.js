import { defaultBuilderPolicy, enforceBuilderAttempt, validateBuilderPolicy } from './policy.js';
export class FakeSandbox {
  constructor({ policy = defaultBuilderPolicy, kill = () => {} } = {}) { this.policy = validateBuilderPolicy(policy); this.kill = kill; this.killed = false; }
  attempt(attempt) { return enforceBuilderAttempt(this.policy, attempt, reason => { this.killed = true; this.kill(reason); }); }
}
