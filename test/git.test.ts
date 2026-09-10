import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAutosolveLog, formatAutosolveSummary, formatPrList } from '../src/git.ts';

const raw = '\x1efix: a migration conflicted with the base branch\n\ndb/migrations/1.sql\ndb/migrations/atlas.sum\n\x1elocal: FOO_API_KEY was unset, stubbed the client\n\napp/foo.go\n';

test('the git log splits into upstream fixes and local workarounds', () => {
  const changes = parseAutosolveLog(raw);
  assert.deepEqual(changes, [
    { kind: 'fix', message: 'a migration conflicted with the base branch', files: ['db/migrations/1.sql', 'db/migrations/atlas.sum'] },
    { kind: 'local', message: 'FOO_API_KEY was unset, stubbed the client', files: ['app/foo.go'] }
  ]);
});

test('summary says how many, and which pile each belongs to', () => {
  const s = formatAutosolveSummary({ api: parseAutosolveLog(raw) });
  assert.match(s, /autosolve made 2 changes/);
  assert.match(s, /fix\s+a migration conflicted/);
  assert.match(s, /local\s+FOO_API_KEY was unset/);
  assert.match(s, /1 belongs in the PR/);
  assert.match(s, /1 never leaves this machine/);
});

test('no changes reads as nothing touched', () => {
  assert.match(formatAutosolveSummary({}), /autosolve made no changes/);
});

test('pr list prints number and title, grouped by repo', () => {

  const s = formatPrList({ api: [{ number: 305, title: 'feat: snapshot' }], web: [{ number: 311, title: 'feat: quiet log' }, { number: 3, title: 'x' }] });
  assert.equal(s, 'api\n305  feat: snapshot\nweb\n311  feat: quiet log\n  3  x');
  assert.equal(formatPrList({ api: [] }), 'api\n  (no open PRs)');
});
