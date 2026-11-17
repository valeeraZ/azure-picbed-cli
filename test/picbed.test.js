import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateConfig, loadConfig } from '../src/config.js';
import { readImage, imageType, uploadImage, verifyAnonymous } from '../src/picbed.js';
import { parseArgs, formatResult, main } from '../src/cli.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const hash = createHash('sha256').update(png).digest('hex');
const blobId = createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${png.length}\0`), png])).digest('hex');
const HEAD = 'a'.repeat(40);
const COMMIT = 'b'.repeat(40);
const config = validateConfig({ azure: { organization: 'org', project: 'Public Project', repo: 'repo' }, timeoutMs: 1000 });
let dir, file;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'azure-picbed-test-'));
  file = join(dir, 'image with spaces.png');
  await writeFile(file, png);
});
after(async () => { await rm(dir, { recursive: true, force: true }); });

function mockAzure({ exists = false, conflict = false, lostResponse = false, badVerification = false,
  size = 100, missingBranch = false, pushStatus, prefixRef = false, lastTimeout = false } = {}) {
  const calls = [];
  let current = HEAD, stored = exists, pushes = 0;
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    calls.push({ url, options });
    const json = (body, status = 200) => Response.json(body, { status });
    const auth = options.headers?.Authorization;
    if (!auth) {
      assert.equal(options.credentials, 'omit');
      assert.equal(options.headers?.Authorization, undefined);
      assert.equal(options.headers?.Cookie, undefined);
      assert.equal(url.searchParams.get('versionDescriptor.version'), current);
      return new Response(badVerification ? '<html>login</html>' : png, { headers: { 'content-type': badVerification ? 'text/html' : 'image/png' } });
    }
    assert.equal(auth, `Basic ${Buffer.from(':secret-pat').toString('base64')}`);
    assert.equal(options.redirect, 'error');
    if (url.pathname.endsWith('/refs')) return json({ value: missingBranch ? [] : [
      ...(prefixRef ? [{ name: 'refs/heads/main-extra', objectId: 'c'.repeat(40) }] : []),
      { name: 'refs/heads/main', objectId: current },
    ] });
    if (url.pathname.endsWith('/items')) {
      assert.equal(url.searchParams.get('versionDescriptor.version'), current);
      return stored ? json({ gitObjectType: 'blob', objectId: blobId }) : json({}, 404);
    }
    if (url.pathname.endsWith('/pushes')) {
      pushes++;
      const body = JSON.parse(options.body);
      assert.equal(body.refUpdates[0].oldObjectId, missingBranch ? '0'.repeat(40) : current);
      assert.equal(body.commits[0].changes[0].item.path, `/images/${hash}.png`);
      assert.deepEqual(Buffer.from(body.commits[0].changes[0].newContent.content, 'base64'), png);
      if (pushStatus) return json({}, pushStatus);
      if (lastTimeout) throw new Error('private transport secret-pat');
      if (conflict && pushes === 1) { current = 'c'.repeat(40); return json({}, 409); }
      current = COMMIT;
      stored = true;
      if (lostResponse) throw new Error('private transport secret-pat');
      return json({ commits: [{ commitId: current }] });
    }
    return json({ id: 'repository-id', defaultBranch: size === 0 ? undefined : 'refs/heads/main', size, project: { visibility: 'public' } });
  };
  return { fetchImpl, calls, get pushes() { return pushes; } };
}

test('configuration defaults and invalid fields', () => {
  assert.equal(config.azure.branch, undefined);
  assert.equal(config.azure.directory, '/images');
  assert.equal(config.azure.tokenEnv, 'AZURE_DEVOPS_PAT');
  for (const azure of [{ token: '' }, { token: 123 }, { token: 'has whitespace' }, { token: null }, { organization: 'https://dev.azure.com/org' }, { branch: 123 },
    { branch: 'main..oops' }, { branch: 'a/.hidden' }, { directory: '../images' }, { tokenEnv: 'x=y' }]) {
    assert.throws(() => validateConfig({ azure: { ...config.azure, ...azure } }), /Invalid configuration/);
  }
  assert.throws(() => validateConfig({ azure: config.azure, timeoutMs: 0 }));
  assert.equal(validateConfig({ azure: { ...config.azure, branch: 'refs/heads/feature/images' } }).azure.branch, 'feature/images');
});

test('config file loading gives actionable errors', async () => {
  await assert.rejects(loadConfig(join(dir, 'absent.json')), /Configuration file not found/);
  await writeFile(join(dir, 'invalid.json'), '{');
  await assert.rejects(loadConfig(join(dir, 'invalid.json')), /valid JSON/);
});

test('image hashing uses bytes and Git blob format', async () => {
  const image = await readImage(file, 10);
  assert.equal(image.hash, hash);
  assert.equal(image.blobId, blobId);
  assert.equal(image.mime, 'image/png');
  const disguised = join(dir, 'image.txt');
  await writeFile(disguised, png);
  assert.equal((await readImage(disguised, 10)).ext, 'png');
});

test('unsupported, empty, oversized and directory inputs fail locally', async () => {
  assert.throws(() => imageType(Buffer.from('<svg/>')), /Only PNG/);
  await assert.rejects(readImage(file, 0.000001), { code: 'INVALID_SIZE' });
  await writeFile(join(dir, 'empty'), '');
  await assert.rejects(readImage(join(dir, 'empty'), 10), { code: 'INVALID_SIZE' });
  await assert.rejects(readImage(dir, 10), { code: 'INVALID_FILE' });
});

test('JPEG GIF and WebP signatures are recognized', () => {
  assert.equal(imageType(Buffer.from('ffd8ffe00000', 'hex')).ext, 'jpg');
  assert.equal(imageType(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(7)])).ext, 'gif');
  assert.equal(imageType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(4)])).ext, 'webp');
});

test('upload creates a binary commit then verifies anonymous exact bytes', async () => {
  const mock = mockAzure();
  const result = await uploadImage(file, config, 'secret-pat', mock);
  assert.equal(result.commitId, COMMIT);
  assert.equal(result.deduplicated, false);
  assert.equal(result.verification.verified, true);
  assert.equal(mock.pushes, 1);
  assert.ok(!JSON.stringify(result).includes('secret-pat'));
  assert.match(result.rawUrl, /repository-id\/items/);
  assert.equal(new URL(result.rawUrl).searchParams.get('download'), 'false');
});

test('raw URL preserves binary bytes for browser navigation and verifies browser Accept headers', async () => {
  const mock = mockAzure();
  const checkedAccepts = [];
  const fetchImpl = async (input, options) => {
    if (options.headers?.Authorization) return mock.fetchImpl(input, options);
    const accept = options.headers?.Accept ?? '*/*';
    checkedAccepts.push(accept);
    // Azure can transcode binary as UTF-8 when navigation negotiates HTML/XML.
    const corrupted = accept.includes('text/html') && new URL(input).searchParams.get('$format') !== 'octetStream';
    return new Response(corrupted ? Buffer.from(png.toString('utf8')) : png, { headers: { 'content-type': 'image/png' } });
  };
  const result = await uploadImage(file, config, 'secret-pat', { fetchImpl });
  assert.equal(new URL(result.rawUrl).searchParams.get('$format'), 'octetStream');
  assert.ok(checkedAccepts.some(accept => accept.includes('text/html')));
  assert.ok(checkedAccepts.some(accept => accept.startsWith('image/')));
});

test('verification rejects navigation-specific byte corruption even when default response is valid', async () => {
  const image = await readImage(file, 10);
  await assert.rejects(verifyAnonymous('https://example.com/image', image, 1000, async (url, options) => {
    const bytes = options.headers?.Accept?.includes('text/html') ? Buffer.from(png.toString('utf8')) : png;
    return new Response(bytes, { headers: { 'content-type': 'image/png' } });
  }), /content differs from the local image/);
});

test('deduplication skips commits and still verifies anonymously', async () => {
  const mock = mockAzure({ exists: true });
  const result = await uploadImage(file, config, 'secret-pat', mock);
  assert.equal(result.deduplicated, true);
  assert.equal(result.commitId, HEAD);
  assert.equal(mock.pushes, 0);
});

test('ref filter results require exact branch match', async () => {
  const mock = mockAzure({ prefixRef: true });
  assert.equal((await uploadImage(file, config, 'secret-pat', mock)).commitId, COMMIT);
});

test('concurrent ref update checks fresh head before retry', async () => {
  const mock = mockAzure({ conflict: true });
  assert.equal((await uploadImage(file, config, 'secret-pat', mock)).commitId, COMMIT);
  assert.equal(mock.pushes, 2);
});

test('lost push response reconciles content instead of duplicating commit', async () => {
  const mock = mockAzure({ lostResponse: true });
  const result = await uploadImage(file, config, 'secret-pat', mock);
  assert.equal(result.commitId, COMMIT);
  assert.equal(mock.pushes, 1);
});

test('repeated ambiguous writes return path for recovery and no secret', async () => {
  const mock = mockAzure({ lastTimeout: true });
  await assert.rejects(uploadImage(file, config, 'secret-pat', mock), error => {
    assert.equal(error.code, 'UPLOAD_UNCERTAIN');
    assert.equal(error.details.path, `/images/${hash}.png`);
    assert.ok(!error.message.includes('secret-pat'));
    return true;
  });
  assert.equal(mock.pushes, 3);
});

test('existing repository missing target branch is never pushed', async () => {
  const mock = mockAzure({ missingBranch: true });
  await assert.rejects(uploadImage(file, config, 'secret-pat', mock), { code: 'BRANCH_NOT_FOUND' });
  assert.equal(mock.pushes, 0);
});

test('empty repository is initialized with zero oldObjectId', async () => {
  const mock = mockAzure({ missingBranch: true, size: 0 });
  const result = await uploadImage(file, config, 'secret-pat', mock);
  assert.equal(result.branch, 'main');
  assert.equal(mock.pushes, 1);
});

test('permissions error does not retry write', async () => {
  const mock = mockAzure({ pushStatus: 403 });
  await assert.rejects(uploadImage(file, config, 'secret-pat', mock), /branch policy/);
  assert.equal(mock.pushes, 1);
});

test('saved commit survives anonymous verification failure', async () => {
  const mock = mockAzure({ badVerification: true });
  await assert.rejects(uploadImage(file, config, 'secret-pat', mock), error => {
    assert.equal(error.code, 'LINK_VERIFICATION_FAILED');
    assert.equal(error.details.commitId, COMMIT);
    assert.equal(error.details.verification.verified, false);
    return true;
  });
});

test('path content mismatch never overwrites', async () => {
  const mock = mockAzure({ exists: true });
  const fetchImpl = async (url, options) => String(url).includes('/items?') ?
    Response.json({ gitObjectType: 'blob', objectId: '0'.repeat(40) }) : mock.fetchImpl(url, options);
  await assert.rejects(uploadImage(file, config, 'secret-pat', { fetchImpl }), { code: 'PATH_COLLISION' });
  assert.equal(mock.pushes, 0);
});

test('missing PAT prevents all network access', async () => {
  const mock = mockAzure();
  await assert.rejects(uploadImage(file, config, '', mock), { code: 'MISSING_TOKEN' });
  assert.equal(mock.calls.length, 0);
});

test('verification rejects JSON, attachment, changed bytes, oversized and empty body', async () => {
  const image = await readImage(file, 10);
  for (const [body, headers] of [
    ['{}', { 'content-type': 'application/json' }],
    [png, { 'content-type': 'image/png', 'content-disposition': 'attachment; filename="a.png"' }],
    [Buffer.alloc(png.length), { 'content-type': 'image/png' }],
    [Buffer.alloc(png.length + 1), { 'content-type': 'image/png' }],
    [null, { 'content-type': 'image/png' }],
  ]) await assert.rejects(verifyAnonymous('https://example.com/image', image, 1000, async () => new Response(body, { headers })));
});

test('CLI parser validates command, count, options, output and delimiter', () => {
  assert.equal(parseArgs([]).help, true);
  assert.equal(parseArgs(['--version']).version, true);
  assert.equal(parseArgs(['upload', '--', '-picture.png']).file, '-picture.png');
  assert.equal(parseArgs(['upload', file, '--output', 'json']).output, 'json');
  for (const args of [['nope'], ['upload'], ['upload', 'a', 'b'], ['upload', 'a', '--output', 'bad'],
    ['upload', 'a', '--token', 'secret'], ['upload', 'a', '--config']]) assert.throws(() => parseArgs(args));
});

test('CLI formatting and help keep diagnostics separate from stdout', async () => {
  const result = { rawUrl: 'https://example.com/image.png' };
  assert.equal(formatResult(result, { output: 'url' }), result.rawUrl);
  assert.equal(JSON.parse(formatResult(result, { output: 'json' })).rawUrl, result.rawUrl);
  assert.equal(formatResult(result, { output: 'markdown', alt: 'a[b]\nc' }), '![a\\[b\\] c](https://example.com/image.png)');
  let out = '', err = '';
  const io = { stdout: { write: value => { out += value; } }, stderr: { write: value => { err += value; } } };
  assert.equal(await main(['--help'], io), 0);
  assert.match(out, /azure-picbed upload/);
  assert.equal(err, '');
  out = '';
  assert.equal(await main(['upload'], io), 1);
  assert.equal(out, '');
  assert.equal(JSON.parse(err).error.code, 'ERROR');
});

test('CLI upload returns JSON on stdout and preserves saved result only on stderr on exit 2', async () => {
  const configFile = join(dir, 'cli-config.json');
  await writeFile(configFile, JSON.stringify({ azure: { organization: 'org', project: 'Public Project', repo: 'repo' } }));
  for (const badVerification of [false, true]) {
    let out = '', err = '';
    const mock = mockAzure({ badVerification });
    const code = await main(['upload', file, '--config', configFile, '--output', 'json'], {
      stdout: { write: value => { out += value; } },
      stderr: { write: value => { err += value; } },
      env: { AZURE_DEVOPS_PAT: 'secret-pat' }, fetchImpl: mock.fetchImpl,
    });
    assert.equal(code, badVerification ? 2 : 0);
    if (badVerification) {
      assert.equal(out, '');
      const error = JSON.parse(err).error;
      assert.equal(error.code, 'LINK_VERIFICATION_FAILED');
      assert.equal(error.details.commitId, COMMIT);
    } else {
      assert.equal(JSON.parse(out).verification.verified, true);
      assert.equal(err, '');
    }
    assert.ok(!out.includes('secret-pat'));
    assert.ok(!err.includes('secret-pat'));
  }
});

test('markdown upload prints only usable Markdown and nothing on stderr', async () => {
  const configFile = join(dir, 'markdown-config.json');
  await writeFile(configFile, JSON.stringify({ azure: { organization: 'org', project: 'Public Project', repo: 'repo' } }));
  const mock = mockAzure({ conflict: true });
  let out = '', err = '';
  const code = await main(['upload', file, '--config', configFile, '--output', 'markdown', '--alt', 'Architecture'], {
    stdout: { write: value => { out += value; } }, stderr: { write: value => { err += value; } },
    env: { AZURE_DEVOPS_PAT: 'secret-pat' }, fetchImpl: mock.fetchImpl,
  });
  assert.equal(code, 0);
  assert.equal(err, '');
  assert.match(out, /^!\[Architecture\]\(https:\/\/[^\n]+\)\n$/);
  assert.equal(out.split('\n').length, 2);
  assert.ok(out.includes('octetStream'));
  assert.equal(mock.pushes, 2);
});

test('private project is rejected before any write', async () => {
  await assert.rejects(uploadImage(file, config, 'secret-pat', {
    fetchImpl: async () => Response.json({ id: 'repo', project: { visibility: 'private' } }),
  }), { code: 'PRIVATE_REPOSITORY' });
});

test('CLI uses JSON token without environment and prefers it over environment token', async () => {
  const configFile = join(dir, 'inline-token.json');
  await writeFile(configFile, JSON.stringify({ azure: { organization: 'org', project: 'Public Project', repo: 'repo', token: 'secret-pat' } }));
  for (const env of [{}, { AZURE_DEVOPS_PAT: 'unused-env-pat' }]) {
    let out = '', err = '';
    const mock = mockAzure();
    const code = await main(['upload', file, '--config', configFile, '--output', 'json'], {
      stdout: { write: value => { out += value; } },
      stderr: { write: value => { err += value; } },
      env, fetchImpl: mock.fetchImpl,
    });
    assert.equal(code, 0);
    assert.equal(JSON.parse(out).verification.verified, true);
    assert.equal(mock.pushes, 1);
    assert.ok(!out.includes('secret-pat'));
    assert.ok(!err.includes('secret-pat'));
    assert.ok(!out.includes('unused-env-pat'));
    assert.ok(!err.includes('unused-env-pat'));
  }
});

test('failed reconciliation after an ambiguous push retains recoverable metadata', async () => {
  const mock = mockAzure({ lostResponse: true });
  let pushed = false;
  const fetchImpl = async (url, options) => {
    if (pushed) throw new Error('secret-pat');
    if (options.method === 'POST') pushed = true;
    return mock.fetchImpl(url, options);
  };
  await assert.rejects(uploadImage(file, config, 'secret-pat', { fetchImpl }), error => {
    assert.equal(error.code, 'UPLOAD_UNCERTAIN');
    assert.equal(error.details.branch, 'main');
    assert.equal(error.details.path, `/images/${hash}.png`);
    assert.ok(!error.message.includes('secret-pat'));
    return true;
  });
  assert.equal(mock.pushes, 1);
});
