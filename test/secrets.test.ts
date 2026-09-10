import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redact, isSecretName, SecretStore, parseEnvFile, unsetVars } from '../src/secrets.ts';

test('redact strips every known value and every NAME=value of a secret name', () => {
  const text = 'FOO_API_KEY=sk-live-123 boom\nconnect with sk-live-123 failed\nPORT=8090';
  const out = redact(text, { values: ['sk-live-123'], names: ['FOO_API_KEY'] });
  assert.ok(!out.includes('sk-live-123'));
  assert.ok(out.includes('FOO_API_KEY=<redacted>'));
  assert.ok(out.includes('PORT=8090'));
});

test('redact handles a value that appears inside a url', () => {
  const out = redact('postgres://u:hunter2hunter2@localhost/db', { values: ['hunter2hunter2'], names: [] });
  assert.equal(out, 'postgres://u:<redacted>@localhost/db');
});

test('a short local dev password is not blanked out of every path', () => {
  const out = redact('/opt/homebrew/opt/postgresql@17 DB_PASSWORD=postgres', { values: ['postgres'], names: ['DB_PASSWORD'] });
  assert.equal(out, '/opt/homebrew/opt/postgresql@17 DB_PASSWORD=<redacted>');
});

test('secret-looking names are recognised, plain ones are not', () => {
  for (const n of ['FOO_API_KEY', 'SESSION_SECRET_KEY', 'DB_PASSWORD', 'QUEUE_CLIENT_TOKEN', 'PRIVATE_ADMIN_API_KEY'])
    assert.ok(isSecretName(n), n);
  for (const n of ['PORT', 'DB_HOST', 'ENABLE_AUTH', 'PUBLIC_ANALYTICS_HOST', 'API_BASE_URL'])
    assert.ok(!isSecretName(n), n);
});

test('store writes 0600 outside any repo and reads back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dd-'));
  const store = new SecretStore(join(dir, 'secrets.json'));
  assert.equal(store.get('FOO'), undefined);
  store.set('FOO', 'bar');
  assert.equal(store.get('FOO'), 'bar');
  assert.equal(statSync(join(dir, 'secrets.json')).mode & 0o777, 0o600);
  assert.equal(new SecretStore(join(dir, 'secrets.json')).get('FOO'), 'bar');
  assert.ok(readFileSync(join(dir, 'secrets.json'), 'utf8').includes('bar'));
});

test('parseEnvFile reads KEY=value, quotes and comments like dotenv does', () => {
  const env = parseEnvFile('# c\nA=1\nB="two words"\nC=\'x\'\n\nD=a=b\nexport E=5\n');
  assert.deepEqual(env, { A: '1', B: 'two words', C: 'x', D: 'a=b', E: '5' });
});

test('an unset variable named by a failure is picked out of the log', () => {

  const log = 'fatal: Configuration validation failed: SEARCH_API_KEY must be set when the search service is configured (SEARCH_BASE_URL is set)';
  assert.deepEqual(unsetVars(log, { SEARCH_BASE_URL: 'x' }), ['SEARCH_API_KEY']);
  assert.deepEqual(unsetVars('Error: missing required env FOO_TOKEN\nHINT: set BAR_KEY', {}), ['FOO_TOKEN', 'BAR_KEY']);
  assert.deepEqual(unsetVars('listen tcp :8090: bind: address already in use', {}), []);
  assert.deepEqual(unsetVars('FOO_TOKEN is unset', { FOO_TOKEN: 'set' }), []);
});
