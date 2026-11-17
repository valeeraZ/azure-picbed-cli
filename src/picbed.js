import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const ZERO = '0'.repeat(40);
const sha = (algorithm, data) => createHash(algorithm).update(data).digest('hex');
const isCommit = value => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);

export class PicbedError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

class ApiError extends PicbedError {
  constructor(status, operation, retryable = false) {
    const hint = status === 401 ? 'PAT is invalid or expired' : status === 403 ? 'Insufficient permissions or branch policy blocks direct commits' :
      status === 404 ? 'Organization, project, repository or version not found, or access denied' : `HTTP ${status}`;
    super('AZURE_API_ERROR', `${operation} failed: ${hint}`);
    this.status = status;
    this.retryable = retryable;
  }
}

export function imageType(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) &&
    bytes.toString('ascii', 12, 16) === 'IHDR') return { ext: 'png', mime: 'image/png' };
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return { ext: 'gif', mime: 'image/gif' };
  if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' &&
    ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16))) return { ext: 'webp', mime: 'image/webp' };
  throw new PicbedError('INVALID_IMAGE', 'Only PNG, JPEG, GIF and WebP images with valid file headers are supported');
}

export async function readImage(path, maxSizeMiB) {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    const limit = Math.floor(maxSizeMiB * 1024 * 1024);
    if (!stat.isFile()) throw new PicbedError('INVALID_FILE', 'Input path must be a regular file');
    if (!stat.size || stat.size > limit) throw new PicbedError('INVALID_SIZE', `Image must be non-empty and no larger than ${maxSizeMiB} MiB`);
    // Read through the same descriptor with a hard cap, including files growing during the read.
    const bytes = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length !== stat.size) throw new PicbedError('FILE_CHANGED', 'File changed while reading; retry the upload');
    const content = bytes.subarray(0, length);
    return { bytes: content, ...imageType(content), hash: sha('sha256', content),
      blobId: sha('sha1', Buffer.concat([Buffer.from(`blob ${content.length}\0`), content])), name: basename(path) };
  } finally {
    await handle.close();
  }
}

export class AzureClient {
  constructor(config, token, fetchImpl = globalThis.fetch) {
    this.config = config;
    this.fetch = fetchImpl;
    const { organization, project, repo } = config.azure;
    this.base = `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}`;
    this.authorization = `Basic ${Buffer.from(`:${token}`).toString('base64')}`;
  }

  url(resource = '', params = {}) {
    const url = new URL(this.base + resource);
    url.search = new URLSearchParams({ 'api-version': '7.1', ...params }).toString();
    return url.toString();
  }

  async request(resource, { params, body, allow404 = false, operation = 'Azure API request' } = {}) {
    let response;
    try {
      response = await this.fetch(this.url(resource, params), {
        method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { Authorization: this.authorization, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      if (allow404 && response.status === 404) { await response.body?.cancel(); return null; }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ApiError(response.status, operation, [409, 412, 429].includes(response.status) || response.status >= 500);
      }
      return await response.json();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // Never echo fetch errors or server responses, which may contain secrets.
      const failure = new PicbedError('REQUEST_UNCERTAIN', `${operation} returned no valid response (network failure, timeout or invalid response)`);
      failure.retryable = true;
      throw failure;
    }
  }

  async head(branch) {
    const refs = await this.request('/refs', { params: { filter: `heads/${branch}` }, operation: 'Read branch' });
    if (!Array.isArray(refs.value)) throw new PicbedError('INVALID_RESPONSE', 'Azure returned an invalid branch list');
    const ref = refs.value.find(item => item.name === `refs/heads/${branch}`);
    if (ref && !isCommit(ref.objectId)) throw new PicbedError('INVALID_RESPONSE', 'Azure returned an invalid branch commit');
    return ref?.objectId;
  }

  async hasImage(path, commitId, image) {
    if (commitId === ZERO) return false;
    const item = await this.request('/items', { params: { path, 'versionDescriptor.versionType': 'commit',
      'versionDescriptor.version': commitId }, allow404: true, operation: 'Check image path' });
    if (!item) return false;
    if (item.gitObjectType !== 'blob' || item.objectId !== image.blobId) {
      throw new PicbedError('PATH_COLLISION', 'Hash path exists with different Git content; upload stopped');
    }
    return true;
  }
}

export function resultUrls(config, repoId, path, commitId) {
  const client = new AzureClient({ ...config, azure: { ...config.azure, repo: repoId } }, '');
  const rawUrl = client.url('/items', { path, 'versionDescriptor.versionType': 'commit',
    'versionDescriptor.version': commitId, download: 'false', '$format': 'octetStream' });
  const { organization, project } = config.azure;
  const web = new URL(`https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repoId)}`);
  web.search = new URLSearchParams({ path, version: `GC${commitId}`, _a: 'contents' }).toString();
  return { rawUrl, webUrl: web.toString() };
}

const ANONYMOUS_PROFILES = [
  { name: 'default' },
  { name: 'browser-navigation', accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8' },
  { name: 'image-embed', accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8' },
];

export async function verifyAnonymous(url, image, timeoutMs, fetchImpl = globalThis.fetch) {
  let verification;
  for (const profile of ANONYMOUS_PROFILES) {
    verification = await verifyAnonymousResponse(url, image, timeoutMs, fetchImpl, profile.accept);
  }
  return { ...verification, checkedProfiles: ANONYMOUS_PROFILES.map(profile => profile.name) };
}

async function verifyAnonymousResponse(url, image, timeoutMs, fetchImpl, accept) {
  // Each profile is anonymous. Accept models real browser negotiation, never a required client header.
  const response = await fetchImpl(url, { redirect: 'follow', credentials: 'omit',
    ...(accept ? { headers: { Accept: accept } } : {}), signal: AbortSignal.timeout(timeoutMs) });
  try {
    if (!response.ok) throw new Error(`Anonymous request returned HTTP ${response.status}`);
    const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (mime !== image.mime) throw new Error(`Anonymous response Content-Type is not ${image.mime}`);
    if (/^attachment\b/i.test((response.headers.get('content-disposition') ?? '').trim())) {
      throw new Error('Anonymous response is an attachment; inline display cannot be verified');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Anonymous response has no image body');
    let length = 0;
    const hash = createHash('sha256');
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > image.bytes.length) throw new Error('Anonymous response content differs from the local image');
        hash.update(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (length !== image.bytes.length || hash.digest('hex') !== image.hash) throw new Error('Anonymous response content differs from the local image');
    return { verified: true, contentType: mime, contentDisposition: response.headers.get('content-disposition') };
  } finally {
    if (!response.body?.locked) await response.body?.cancel().catch(() => {});
  }
}

export async function uploadImage(file, config, token, { fetchImpl = globalThis.fetch, log = () => {} } = {}) {
  const image = await readImage(file, config.maxSizeMiB);
  if (!token || !token.trim()) throw new PicbedError('MISSING_TOKEN', `Set azure.token or the ${config.azure.tokenEnv} environment variable`);
  const client = new AzureClient(config, token, fetchImpl);
  const repo = await client.request('', { operation: 'Read repository' });
  if (typeof repo.id !== 'string' || !repo.id) throw new PicbedError('INVALID_RESPONSE', 'Azure did not return a repository ID');
  if (repo.project?.visibility === 'private') throw new PicbedError('PRIVATE_REPOSITORY', 'Target project is private; a public project is required');
  const branch = config.azure.branch ?? repo.defaultBranch?.replace(/^refs\/heads\//, '') ?? (repo.size === 0 ? 'main' : undefined);
  if (!branch) throw new PicbedError('MISSING_BRANCH', 'Repository has no default branch; set azure.branch');
  const path = `${config.azure.directory === '/' ? '' : config.azure.directory}/${image.hash}.${image.ext}`;
  let saved;
  let uncertain = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    let head;
    try {
      head = await client.head(branch);
      if (!head && repo.size !== 0) throw new PicbedError('BRANCH_NOT_FOUND', `Branch ${branch} does not exist; upload stopped to avoid creating an unintended branch`);
      head ??= ZERO;
      if (await client.hasImage(path, head, image)) {
        saved = { commitId: head, deduplicated: true };
        break;
      }
    } catch (error) {
      if (uncertain) throw new PicbedError('UPLOAD_UNCERTAIN', 'An earlier commit may have succeeded but could not be confirmed. Retry the same image when the network recovers', { path, branch });
      throw error;
    }
    log(`Uploading to ${branch}:${path}`);
    try {
      const push = await client.request('/pushes', { operation: 'Commit image', body: {
        refUpdates: [{ name: `refs/heads/${branch}`, oldObjectId: head }],
        commits: [{ comment: `Add image ${image.hash}.${image.ext}`, changes: [{ changeType: 'add', item: { path },
          newContent: { content: image.bytes.toString('base64'), contentType: 'base64encoded' } }] }],
      } });
      const commitId = push.commits?.[0]?.commitId;
      if (!isCommit(commitId)) {
        const error = new PicbedError('INVALID_RESPONSE', 'Push response is missing a valid commit ID');
        error.retryable = true;
        throw error;
      }
      saved = { commitId, deduplicated: false };
      break;
    } catch (error) {
      if (!error.retryable) throw error;
      uncertain = true;
      // On the last attempt reconcile once more without submitting again.
      if (attempt === 2) {
        try {
          const current = await client.head(branch);
          if (current && await client.hasImage(path, current, image)) saved = { commitId: current, deduplicated: true };
        } catch { /* Report uncertain status with a recoverable path below. */ }
        if (!saved) throw new PicbedError('UPLOAD_UNCERTAIN', 'Upload result is uncertain; retry the same image later. Existing images will not be overwritten', { path, branch });
      } else {
        log('Push result is uncertain or branch changed; checking remote path before retry');
        await delay(200 * (attempt + 1));
      }
    }
  }
  const result = { path, branch, ...saved, ...resultUrls(config, repo.id, path, saved.commitId) };
  log('Verifying anonymous image access');
  try {
    result.verification = await verifyAnonymous(result.rawUrl, image, config.timeoutMs, fetchImpl);
  } catch (error) {
    // Only emit our own validation messages. Fetch errors can include sensitive internals.
    const reason = error.constructor === Error && /^Anonymous /.test(error.message) ? error.message : 'Anonymous access timed out or failed due to a network error';
    throw new PicbedError('LINK_VERIFICATION_FAILED', `Image is saved in the repository, but link verification failed: ${reason}`, { ...result, verification: { verified: false } });
  }
  return result;
}
