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
  assert.deepEqual(parseTarget('298', 'cla-{id}'), { pr: 298 });
  assert.deepEqual(parseTarget('CLA-601', 'cla-{id}'), { ticket: 'cla-601' });
  assert.deepEqual(parseTarget('user/cla-601-steps', 'cla-{id}'), { branch: 'user/cla-601-steps' });
  assert.deepEqual(parseTarget('CLA-601', undefined), { branch: 'CLA-601' });
});

import { pickBranch } from '../src/plan.ts';

test('an ambiguous PR number is settled by the repo you are standing in', () => {
  const found = new Map([['user/cla-580', ['api']], ['user/cla-581', ['web']]]);
  assert.deepEqual(pickBranch(found, 'web'), { branch: 'user/cla-581' });
  assert.deepEqual(pickBranch(found, 'api'), { branch: 'user/cla-580' });
  assert.deepEqual(pickBranch(found, undefined), { ambiguous: ['user/cla-580 (api)', 'user/cla-581 (web)'] });
  assert.deepEqual(pickBranch(found, 'other'), { ambiguous: ['user/cla-580 (api)', 'user/cla-581 (web)'] });
});

test('one branch across repos needs no tie break', () => {
  assert.deepEqual(pickBranch(new Map([['user/x', ['api', 'web']]]), undefined), { branch: 'user/x' });
  assert.deepEqual(pickBranch(new Map(), 'web'), { none: true });
});
