#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist', 'cli.js');
await import(existsSync(dist) ? dist : join(here, '..', 'src', 'cli.ts'));
