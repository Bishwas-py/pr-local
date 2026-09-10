import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReport } from '../src/agent.ts';

test('the agent report is the last json block, tolerant of prose around it', () => {
  const text = 'Looked at the logs.\n```json\n{"data":"filled","issues":[{"found":"PUT /me/preferences 401: auth off, no subject","fixed":true,"kind":"local"}],"restart":["api"]}\n```\nDone.';
  assert.deepEqual(parseReport(text), {
    data: 'filled',
    issues: [{ found: 'PUT /me/preferences 401: auth off, no subject', fixed: true, kind: 'local' }],
    restart: ['api']
  });
});

test('no block means nothing found, nothing filled', () => {
  assert.deepEqual(parseReport('I could not tell.'), { data: 'none', issues: [], restart: [] });
});

import { checkPrompt } from '../src/agent.ts';

const baseInput = {
  diff: 'diff', hints: [{ service: 'api', hint: 'psql ...' }],
  running: [{ service: 'api', url: 'http://x', log: '/l' }],
  logTails: { api: 'tail' }, screen: 'http://x/page', priorCommits: ''
};
const ctx = { cwd: '/wt', envNames: { set: ['PATH'], unset: [] }, secrets: { names: [], values: [] } };

test('the check prompt seeds and checks runtime by default', () => {
  const p = checkPrompt({ ...baseInput, seed: true }, ctx as any);
  assert.match(p, /DATA:/);
  assert.match(p, /RUNTIME:/);
  assert.match(p, /psql \.\.\./);
});

test('with seeding off, the prompt drops the data task and hints, keeps runtime', () => {
  const p = checkPrompt({ ...baseInput, seed: false }, ctx as any);
  assert.doesNotMatch(p, /DATA:/);
  assert.doesNotMatch(p, /psql \.\.\./);
  assert.match(p, /RUNTIME:/);
  assert.match(p, /data.*none/);
});
