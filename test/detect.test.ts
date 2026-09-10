import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { detectService } from '../src/detect.ts';

function repo(files: Record<string, string>, dirs: string[] = []): string {
  const d = mkdtempSync(join(tmpdir(), 'dd-det-'));
  for (const sub of dirs) mkdirSync(join(d, sub), { recursive: true });
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(d, f, '..'), { recursive: true });
    writeFileSync(join(d, f), body);
  }
  return d;
}

test('a SvelteKit repo: npm run dev, port 5173, routes, health probe', () => {
  const d = repo(
    {
      'package.json': JSON.stringify({ scripts: { dev: 'vite dev' }, devDependencies: { '@sveltejs/kit': '2' } }),
      '.env': 'X=1'
    },
    ['src/routes/api/health', 'node_modules']
  );
  const s = detectService(d);
  assert.match(s.start!, /npm run dev.*--port \$\{port\}/);
  assert.equal(s.port, 5173);
  assert.equal(s.routes, 'src/routes');
  assert.equal(s.ready, 'http://localhost:${port}/api/health');
  assert.equal(s.url, 'http://localhost:${port}');
  assert.deepEqual(s.env_files, ['.env']);
  assert.deepEqual(s.link, ['node_modules']);
});

test('pnpm is honored when its lockfile is present', () => {
  const d = repo({ 'package.json': JSON.stringify({ scripts: { dev: 'vite' } }), 'pnpm-lock.yaml': '' });
  assert.match(detectService(d).start!, /pnpm run dev/);
});

test('a Next repo: port 3000, app routes', () => {
  const d = repo({ 'package.json': JSON.stringify({ scripts: { dev: 'next dev' }, dependencies: { next: '15' } }) }, ['app']);
  const s = detectService(d);
  assert.equal(s.port, 3000);
  assert.equal(s.routes, 'app');
});

test('a Go repo: go run ., port 8080', () => {
  const d = repo({ 'go.mod': 'module x\n', 'main.go': 'package main\nfunc main(){}\n' });
  const s = detectService(d);
  assert.equal(s.start, 'go run .');
  assert.equal(s.port, 8080);
});

test('an undetectable repo yields no start, so the caller can ask for one', () => {
  const d = repo({ 'readme.txt': 'hi' });
  assert.equal(detectService(d).start, undefined);
});
