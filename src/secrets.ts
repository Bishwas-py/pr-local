import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

export type Secrets = { values: string[]; names: string[] };

/** Shorter values (a local dev password like "postgres") are not blanked out
 *  of every path and log line; NAME=value redaction still covers them. */
export const MIN_SECRET_LEN = 10;

const SECRET_NAME = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL)/i;
const PUBLIC_NAME = /^PUBLIC_/;

/** A var whose name says it holds a credential. Public keys are public. */
export function isSecretName(name: string): boolean {
  return !PUBLIC_NAME.test(name) && SECRET_NAME.test(name);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Strips every known secret value and every NAME=value for a secret name. */
export function redact(text: string, secrets: Secrets): string {
  let out = text;
  for (const v of secrets.values) if (v && v.length >= MIN_SECRET_LEN) out = out.replaceAll(v, '<redacted>');
  for (const n of secrets.names) out = out.replace(new RegExp(`(${escapeRe(n)}=)[^\\s]*`, 'g'), '$1<redacted>');
  return out;
}

/** dotenv-compatible reader: KEY=value, optional export, quotes, # comments. */
export function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    env[m[1]] = v;
  }
  return env;
}

export function readEnvFiles(dir: string, files: string[] = []): Record<string, string> {
  let env: Record<string, string> = {};
  for (const f of files) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) env = { ...env, ...parseEnvFile(fs.readFileSync(p, 'utf8')) };
  }
  return env;
}

export const defaultStorePath = () =>
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'deploy-dev', 'secrets.json');

/** Asked once, kept forever, 0600, outside every repo. */
export class SecretStore {
  private data: Record<string, string>;
  readonly file: string;
  constructor(file: string = defaultStorePath()) {
    this.file = file;
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  }
  get(name: string): string | undefined {
    return this.data[name];
  }
  set(name: string, value: string): void {
    this.data[name] = value;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(this.file, 0o600);
  }
  values(): string[] {
    return Object.values(this.data);
  }
}

/** Reads one value from the terminal without echo. */
export function promptSecret(name: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    const write = (rl as any)._writeToOutput;
    (rl as any)._writeToOutput = function (s: string) {
      if (s.includes(name)) write.call(this, s);
    };
    rl.question(`${name} is required and not set. Enter it (kept in ${defaultStorePath()}, asked once): `, (v) => {
      rl.close();
      process.stderr.write('\n');
      resolve(v.trim());
    });
  });
}

const UNSET_PATTERNS = [
  /\b([A-Z][A-Z0-9_]{2,})\b[^\n]*?\b(must be set|is not set|is unset|is required|not set|is missing)\b/g,
  /\b(missing|unset|required|set)\b[^\n]*?\b([A-Z][A-Z0-9_]{2,})\b/g
];

/** Variable names a failure says are missing, that really are not set. */
export function unsetVars(text: string, env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  for (const re of UNSET_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const name = /^[A-Z]/.test(m[1]) ? m[1] : m[2];
      if (!/[A-Z]/.test(name) || !name.includes('_')) continue;
      if (env[name] || out.includes(name)) continue;
      out.push(name);
    }
  }
  return out;
}
