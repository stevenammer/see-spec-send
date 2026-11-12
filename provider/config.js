import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { adapters } from './adapters.js';
import { priceRate } from '../gateway/ledger.js';

const kinds = Object.keys(adapters);
const integer = value => Number.isSafeInteger(value) && value >= 0;
export const configPath = env => resolve(env.SSS_PROVIDERS_FILE || 'sss.providers.json');
export function readProviders(env = process.env) {
  const file = configPath(env); if (!existsSync(file)) return { providers: [], defaults: {} };
  let parsed; try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch { throw Error('invalid provider config'); }
  if (!parsed || !Array.isArray(parsed.providers) || !parsed.defaults || typeof parsed.defaults !== 'object') throw Error('invalid provider config');
  for (const provider of parsed.providers) validateProvider(provider);
  return parsed;
}
export function validateProvider(provider) {
  if (!provider || typeof provider.name !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(provider.name) || !kinds.includes(provider.kind) || typeof provider.model !== 'string' || !provider.model || provider.enabled !== true && provider.enabled !== false) throw Error('invalid provider');
  if (!provider.price || !integer(provider.price.inputMicrosPerMillion) || !integer(provider.price.outputMicrosPerMillion)) throw Error('priced provider required');
  if (provider.kind === 'command') return provider;
  if (typeof provider.url !== 'string' || !Array.isArray(provider.hosts) || !provider.hosts.length || !provider.hosts.every(host => typeof host === 'string' && host)) throw Error('provider URL and host allowlist required');
  if (provider.apiKeyEnv && provider.apiKeyFile) throw Error('choose one provider credential reference');
  if (provider.apiKeyEnv && !/^[A-Z_][A-Z0-9_]*$/.test(provider.apiKeyEnv)) throw Error('invalid API key environment name');
  if (provider.apiKeyFile && (typeof provider.apiKeyFile !== 'string' || !provider.apiKeyFile.startsWith('/'))) throw Error('API key file must be absolute');
  return provider;
}
export function saveProviders(data, env = process.env) { const file = configPath(env); writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 }); chmodSync(file, 0o600); }
export function providerFor(name, env = process.env) {
  const provider = readProviders(env).providers.find(entry => entry.name === name && entry.enabled); if (!provider) throw Error('provider is not enabled');
  const apiKey = provider.apiKeyEnv ? env[provider.apiKeyEnv] : provider.apiKeyFile ? readFileSync(provider.apiKeyFile, 'utf8').trim() : undefined;
  if ((provider.apiKeyEnv || provider.apiKeyFile) && !apiKey) throw Error('provider credential unavailable');
  return adapters[provider.kind]({ ...provider, apiKey });
}
export function meteredProviderFor(name, env = process.env) {
  const config = readProviders(env);
  const entry = config.providers.find(provider => provider.name === name && provider.enabled);
  if (!entry) throw Error('provider is not enabled');
  return { provider: providerFor(name, env), rate: priceRate({ model: entry.model, ...entry.price }) };
}
export function defaultProviderFor(org, env = process.env) {
  const name = readProviders(env).defaults[org];
  if (typeof name !== 'string') throw Error('organization has no default provider');
  return meteredProviderFor(name, env);
}
