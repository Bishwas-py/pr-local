import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isErrorLine, errorSignature } from '../src/watch.ts';

test('error lines are recognised across log styles, noise is not', () => {
  assert.ok(isErrorLine('[GIN] 2026/09/10 - 09:57:42 | 401 |  100µs | ::1 | PUT  "/api/v1/operator/me/preferences"'));
  assert.ok(isErrorLine('{"error":"salesforce: query failed","level":"error","msg":"Failed to list tax declarations"}'));
  assert.ok(isErrorLine('\x1b[1;31m[500] GET /admin/tax-declarations\x1b[0m'));
  assert.ok(isErrorLine('BackendError: Failed to list tax declarations'));
  assert.ok(!isErrorLine('[GIN] 2026/09/10 - 09:57:41 | 200 | 494µs | ::1 | GET "/api/v1/operator/team-members"'));
  assert.ok(!isErrorLine('{"level":"warning","msg":"Failed to initialize Redis client"}'));
  assert.ok(!isErrorLine('  VITE v6.0.0  ready in 900 ms'));
});

test('a signature ignores timestamps, ids and latencies so one cause is one signature', () => {
  const a = errorSignature('[GIN] 2026/09/10 - 09:57:42 | 401 |  100.625µs | ::1 | PUT  "/api/v1/operator/me/preferences"');
  const b = errorSignature('[GIN] 2026/09/10 - 10:03:01 | 401 |  90.1µs | ::1 | PUT  "/api/v1/operator/me/preferences"');
  assert.equal(a, b);
  assert.notEqual(a, errorSignature('[GIN] 2026/09/10 - 10:03:01 | 500 | 90µs | ::1 | GET "/api/v1/operator/processing"'));
});
