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
