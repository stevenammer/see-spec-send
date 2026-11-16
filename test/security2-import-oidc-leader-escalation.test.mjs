import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../core/store.js';
import { Auth } from '../app/auth.js';
import { FakeOidcProvider, OidcLogin } from '../app/oidc.js';

async function oidcLogin(auth, provider, subject, binder) {
  const authorization = new URL(auth.beginOidc(binder));
  const code = provider.issue({
    codeChallenge: authorization.searchParams.get('code_challenge'),
    nonce: authorization.searchParams.get('nonce'),
    subject,
  });
  return auth.completeOidc({ state: authorization.searchParams.get('state'), code, binder });
}

test('security review: importing an untrusted registry cannot pre-promote a future OIDC subject', async t => {
  const issuer = 'https://idp.example.test';
  const redirect = 'https://sss.example.test/api/oidc/callback';
  const provider = new FakeOidcProvider({ issuer });
  const source = new Store(); t.after(() => source.close());
  const sourceAuth = new Auth(source, { oidc: new OidcLogin(provider.configuration(redirect)) });
  await oidcLogin(sourceAuth, provider, 'attacker-subject', 'source-browser');
  const oidcId = source.db.prepare("SELECT id FROM actors WHERE id LIKE 'oidc-%'").get().id;

  // An attacker can make a self-consistent JSONL file and change only mutable
  // registry authority. Event hashes do not cover the registry row.
  const forged = source.exportJsonl().trim().split('\n').map(line => {
    const row = JSON.parse(line);
    if (row.registry?.id === oidcId) row.registry.leader = 1;
    return JSON.stringify(row);
  }).join('\n');
  const target = new Store(); t.after(() => target.close());
  target.importJsonl(`${forged}\n`);

  const targetProvider = new FakeOidcProvider({ issuer });
  const targetAuth = new Auth(target, { oidc: new OidcLogin(targetProvider.configuration(redirect)) });
  await oidcLogin(targetAuth, targetProvider, 'attacker-subject', 'target-browser');

  assert.equal(target.actor(oidcId, '').leader, false,
    'an imported registry must not be able to grant leader authority to a later OIDC login');
});
