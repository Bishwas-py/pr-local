import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requiredServices, routeFor, parseTarget } from '../src/plan.ts';

const services = {
  db: { ready: 'tcp://localhost:5432' },
  queue: { ready: 'tcp://localhost:7077' },
  api: { repo: 'api', needs: ['db'], url: 'http://localhost:8090' },
  worker: { repo: 'api', paths: ['cmd/worker/**'], needs: ['db', 'queue'] },
  web: { repo: 'web', needs: ['api'], url: 'http://localhost:5173/admin', routes: 'src/routes' },
  form: { repo: 'form', needs: ['api'], url: 'http://localhost:5174' }
};

test('frontend-only diff boots that frontend, the api and the db, nothing else', () => {
  const got = requiredServices(services, { web: ['src/routes/(protected)/processing/+page.svelte'] });
  assert.deepEqual(got, ['db', 'api', 'web']);
});

test('backend-only diff boots every frontend that shows it, never the worker', () => {
  const got = requiredServices(services, { api: ['app/features/operator/processing.go'] });
  assert.deepEqual(got, ['db', 'api', 'web', 'form']);
});

test('a worker diff boots the worker and its queue', () => {
  const got = requiredServices(services, { api: ['cmd/worker/main.go'] });
  assert.ok(got.includes('worker') && got.includes('queue'));
});

test('an empty diff boots everything a human can open', () => {
  const got = requiredServices(services, {});
  assert.deepEqual(got, ['db', 'api', 'web', 'form']);
});

test('needs are ordered before the service that needs them', () => {
  const got = requiredServices(services, { web: ['x'] });
  assert.ok(got.indexOf('db') < got.indexOf('api') && got.indexOf('api') < got.indexOf('web'));
});

test('route comes from the changed page, route groups dropped', () => {
  const url = routeFor(services.web, [
    'src/lib/processing.ts',
    'src/routes/(protected)/(standard)/processing/+page.svelte',
    'src/routes/(protected)/(standard)/processing/processing.remote.ts'
  ]);
  assert.equal(url, 'http://localhost:5173/admin/processing');
});

test('a parameterised route falls back to the service url', () => {
  const url = routeFor(services.web, ['src/routes/(protected)/files/[fileId]/+page.svelte']);
  assert.equal(url, 'http://localhost:5173/admin');
});

test('no route files means the service url', () => {
  assert.equal(routeFor(services.web, ['src/lib/a.ts']), 'http://localhost:5173/admin');
});

test('parseTarget tells a pr number, a ticket and a branch apart', () => {
  assert.deepEqual(parseTarget('298', 'proj-{id}'), { pr: 298 });
  assert.deepEqual(parseTarget('PROJ-601', 'proj-{id}'), { ticket: 'proj-601' });
  assert.deepEqual(parseTarget('user/proj-601-steps', 'proj-{id}'), { branch: 'user/proj-601-steps' });
  assert.deepEqual(parseTarget('PROJ-601', undefined), { branch: 'PROJ-601' });
});

import { pickBranch } from '../src/plan.ts';

test('an ambiguous PR number is settled by the repo you are standing in', () => {
  const found = new Map([['user/proj-580', ['api']], ['user/proj-581', ['web']]]);
  assert.deepEqual(pickBranch(found, 'web'), { branch: 'user/proj-581' });
  assert.deepEqual(pickBranch(found, 'api'), { branch: 'user/proj-580' });
  assert.deepEqual(pickBranch(found, undefined), { ambiguous: ['user/proj-580 (api)', 'user/proj-581 (web)'] });
  assert.deepEqual(pickBranch(found, 'other'), { ambiguous: ['user/proj-580 (api)', 'user/proj-581 (web)'] });
});

test('one branch across repos needs no tie break', () => {
  assert.deepEqual(pickBranch(new Map([['user/x', ['api', 'web']]]), undefined), { branch: 'user/x' });
  assert.deepEqual(pickBranch(new Map(), 'web'), { none: true });
});

import { slotFor, withPorts } from '../src/plan.ts';

test('a branch set always maps to the same slot, order-independent', () => {
  assert.equal(slotFor(['a', 'b']), slotFor(['b', 'a']));
  assert.notEqual(slotFor(['a']), slotFor(['b']));
  assert.ok(slotFor(['a']) >= 1 && slotFor(['a']) <= 99);
  assert.equal(slotFor([]), slotFor([]));
});

test('ports shift by the slot and ${port} / ${svc.port} are filled in everywhere', () => {
  const out = withPorts(
    {
      db: { ready: 'tcp://localhost:5432' },
      api: { port: 8090, env: { PORT: '${port}' }, ready: 'http://localhost:${port}/health' },
      web: { port: 5173, needs: ['api'], env: { API: 'http://localhost:${api.port}/v1' }, start: 'vite --port ${port}', url: 'http://localhost:${port}/admin' }
    },
    12
  );
  assert.equal(out.db.ready, 'tcp://localhost:5432');
  assert.equal(out.api.port, 9290);
  assert.deepEqual(out.api.env, { PORT: '9290' });
  assert.equal(out.api.ready, 'http://localhost:9290/health');
  assert.equal(out.web.port, 6373);
  assert.deepEqual(out.web.env, { API: 'http://localhost:9290/v1' });
  assert.equal(out.web.start, 'vite --port 6373');
  assert.equal(out.web.url, 'http://localhost:6373/admin');
});
