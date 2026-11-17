import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { resolve, dirname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { validateConfig } from './config.js';

function terminalPrompts(input, output) {
  if (!input.isTTY || !output.isTTY) {
    throw new Error('config requires an interactive terminal. Create a JSON configuration file instead; see docs/agent-usage.md');
  }
  let hidden = false;
  const display = new Writable({ write(chunk, encoding, callback) {
    if (!hidden) output.write(chunk, encoding);
    callback();
  } });
  const rl = createInterface({ input, output: display, terminal: true });
  const controller = new AbortController();
  rl.on('SIGINT', () => controller.abort());
  rl.on('close', () => controller.abort());
  return {
    async ask(prompt, { secret = false } = {}) {
      try {
        const answer = rl.question(prompt, { signal: controller.signal });
        hidden = secret;
        return await answer;
      } catch {
        throw new Error('Configuration cancelled; no changes were saved');
      } finally {
        hidden = false;
        if (secret) output.write('\n');
      }
    },
    close() { rl.close(); display.end(); },
  };
}

// ask is injectable for deterministic tests; real CLI interaction always requires a TTY.
export async function configure(file = 'azure-picbed.json', { input = process.stdin, output = process.stderr, ask } = {}) {
  const session = ask ? { ask, close() {} } : terminalPrompts(input, output);
  const path = resolve(file);
  try {
    let existing;
    try {
      const content = await readFile(path, 'utf8');
      try { existing = validateConfig(JSON.parse(content)); }
      catch { throw new Error(`Existing configuration is invalid: ${path}. Fix it or choose another --config path`); }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (existing) {
      const confirmation = await session.ask(`Update ${path}? [y/N]: `);
      if (!/^y(es)?$/i.test(confirmation.trim())) return { saved: false, path };
    }
    async function field(label, fallback = '', required = false, secret = false) {
      while (true) {
        const hint = secret ? (fallback ? ' [Enter to keep existing token]' : ' [input hidden]') : (fallback ? ` [${fallback}]` : '');
        const answer = (await session.ask(`${label}${hint}: `, { secret })).trim();
        if (answer || fallback || !required) return answer || fallback;
        output.write(`${label} is required.\n`);
      }
    }
    const prior = existing?.azure ?? {};
    const organization = await field('Organization name', prior.organization, true);
    const project = await field('Project name or ID', prior.project, true);
    const repo = await field('Repository name or ID', prior.repo, true);
    const branch = await field('Branch (blank uses repository default)', prior.branch);
    const directory = await field('Image directory', prior.directory ?? '/images');
    let auth;
    while (true) {
      auth = (await field('Authentication: token or env', prior.token ? 'token' : 'env')).toLowerCase();
      if (['token', 'env'].includes(auth)) break;
      output.write('Enter token or env.\n');
    }
    const credentials = auth === 'token'
      ? { token: await field('PAT', prior.token, true, true) }
      : { tokenEnv: await field('PAT environment variable', prior.tokenEnv ?? 'AZURE_DEVOPS_PAT', true) };
    const maxSizeMiB = Number(await field('Maximum image size (MiB)', String(existing?.maxSizeMiB ?? 10)));
    const timeoutMs = Number(await field('HTTP timeout (ms)', String(existing?.timeoutMs ?? 30000)));
    const config = validateConfig({ azure: { organization, project, repo, ...(branch ? { branch } : {}), directory, ...credentials }, maxSizeMiB, timeoutMs });
    const tempPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    try {
      await writeFile(tempPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      await rename(tempPath, path);
    } finally {
      await rm(tempPath, { force: true });
    }
    return { saved: true, path };
  } finally {
    session.close();
  }
}
