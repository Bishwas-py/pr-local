#!/usr/bin/env node
// Prefer the TypeScript source (a clone always runs fresh); fall back to the
// compiled dist, which is what the published package ships (source excluded).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'src', 'cli.ts');
await import(existsSync(src) ? src : join(here, '..', 'dist', 'cli.js'));
