import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm, readdir, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configure } from '../src/configure.js';
import { loadConfig } from '../src/config.js';
import { main, parseArgs } from '../src/cli.js';

let dir;
before(async () => { dir = await mkdtemp(join(tmpdir(), 'picbed-config-')); });
after(async () => { await rm(dir, { recursive: true, force: true }); });

function scripted(answers) {
  const prompts = [];
  let output = '';
  return {
    prompts,
    output: { write(value) { output += value; } },
    get text() { return output; },
    async ask(prompt, options) {
      prompts.push({ prompt, options });
      assert.ok(answers.length, `Unexpected prompt: ${prompt}`);
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

test('config and help commands parse strictly', () => {
  assert.equal(parseArgs(['config']).command, 'config');
  assert.equal(parseArgs(['config', '--config', 'custom.json']).config, 'custom.json');
  for (const args of [['help'], ['help', 'upload'], ['help', 'config'], ['config', '--help'], ['upload', '--help']]) {
    assert.equal(parseArgs(args).help, true);
  }
  for (const args of [['help', 'unknown'], ['config', 'file'], ['config', '--output', 'json'],
    ['config', '--config'], ['upload', 'image.png', '--output', 'url', '--output', 'json']]) assert.throws(() => parseArgs(args));
});

test('help works through a command symlink such as npm link', async () => {
  const command = join(dir, 'azure-picbed');
  await symlink(fileURLToPath(new URL('../src/cli.js', import.meta.url)), command);
  const result = spawnSync(process.execPath, [command, 'help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /azure-picbed config/);
  assert.equal(result.stderr, '');
});

test('wizard saves environment authentication and defaults with owner-only permissions', async () => {
  const file = join(dir, 'env.json');
  const io = scripted(['org', 'project', 'repo', '', '', '', '', '', '']);
  const result = await configure(file, io);
  assert.deepEqual(result, { saved: true, path: file });
  const config = await loadConfig(file);
  assert.equal(config.azure.branch, undefined);
  assert.equal(config.azure.directory, '/images');
  assert.equal(config.azure.tokenEnv, 'AZURE_DEVOPS_PAT');
  assert.equal(config.azure.token, undefined);
  assert.equal(config.maxSizeMiB, 10);
  assert.equal(config.timeoutMs, 30000);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('wizard supports inline PAT and marks its prompt secret', async () => {
  const file = join(dir, 'token.json');
  const io = scripted(['org', 'project', 'repo', 'feature/images', '/pictures', 'token', 'test-only-pat', '20', '1500']);
  await configure(file, io);
  const config = await loadConfig(file);
  assert.equal(config.azure.token, 'test-only-pat');
  assert.equal(config.azure.branch, 'feature/images');
  assert.equal(config.azure.directory, '/pictures');
  assert.equal(config.timeoutMs, 1500);
  assert.ok(io.prompts.find(p => p.prompt.startsWith('PAT')).options.secret);
  assert.ok(!JSON.stringify(io.prompts).includes('test-only-pat'));
});

test('existing configuration is untouched when update is declined', async () => {
  const file = join(dir, 'decline.json');
  const content = JSON.stringify({ azure: { organization: 'org', project: 'project', repo: 'repo', token: 'original-pat' } });
  await writeFile(file, content);
  const result = await configure(file, scripted(['']));
  assert.equal(result.saved, false);
  assert.equal(await readFile(file, 'utf8'), content);
});

test('wizard keeps an existing PAT without displaying it', async () => {
  const file = join(dir, 'keep.json');
  await writeFile(file, JSON.stringify({ azure: { organization: 'org', project: 'project', repo: 'repo', token: 'original-pat' } }));
  const io = scripted(['yes', '', '', '', '', '', '', '', '', '']);
  await configure(file, io);
  assert.equal((await loadConfig(file)).azure.token, 'original-pat');
  assert.ok(!JSON.stringify(io.prompts).includes('original-pat'));
  assert.ok(!io.text.includes('original-pat'));
});

test('switching authentication to environment removes the inline PAT', async () => {
  const file = join(dir, 'switch.json');
  await writeFile(file, JSON.stringify({ azure: { organization: 'org', project: 'project', repo: 'repo', token: 'original-pat' } }));
  await configure(file, scripted(['y', '', '', '', '', '', 'env', 'CUSTOM_PAT', '', '']));
  const config = await loadConfig(file);
  assert.equal(config.azure.token, undefined);
  assert.equal(config.azure.tokenEnv, 'CUSTOM_PAT');
});

test('wizard retries required values and authentication choice', async () => {
  const io = scripted(['', 'org', 'project', 'repo', '', '', 'invalid', 'env', '', '', '']);
  await configure(join(dir, 'retry.json'), io);
  assert.match(io.text, /Organization name is required/);
  assert.match(io.text, /Enter token or env/);
});

test('validation failure and cancellation do not save partial configuration', async () => {
  const file = join(dir, 'invalid.json');
  await assert.rejects(configure(file, scripted(['org', 'project', 'repo', '', '', '', '', '0', ''])), /maxSizeMiB/);
  await assert.rejects(stat(file), { code: 'ENOENT' });
  await assert.rejects(configure(file, scripted([new Error('cancelled')])), /cancelled/);
  await assert.rejects(stat(file), { code: 'ENOENT' });
  assert.ok(!(await readdir(dir)).some(name => name.endsWith('.tmp')));
});

test('unattended config command fails immediately with one English JSON error', async () => {
  let out = '', err = '';
  const code = await main(['config', '--config', join(dir, 'unattended.json')], {
    stdin: { isTTY: false }, stdout: { write: value => { out += value; } }, stderr: { write: value => { err += value; } },
  });
  assert.equal(code, 1);
  assert.equal(out, '');
  assert.match(JSON.parse(err).error.message, /requires an interactive terminal/);
  await assert.rejects(stat(join(dir, 'unattended.json')), { code: 'ENOENT' });
});
