import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function fail(message) {
  throw new Error(`Invalid configuration: ${message}`);
}

export function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Expected a JSON object');
  const azure = input.azure;
  if (!azure || typeof azure !== 'object' || Array.isArray(azure)) fail('Missing azure object');
  for (const key of Object.keys(input)) {
    if (!['azure', 'maxSizeMiB', 'timeoutMs'].includes(key)) fail(`Unsupported field: ${key}`);
  }
  for (const key of Object.keys(azure)) {
    if (!['organization', 'project', 'repo', 'branch', 'directory', 'token', 'tokenEnv'].includes(key)) {
      fail(`Unsupported field: azure.${key}`);
    }
  }
  for (const key of ['organization', 'project', 'repo']) {
    if (typeof azure[key] !== 'string' || !azure[key].trim() || /[\x00-\x1f\x7f]/.test(azure[key])) {
      fail(`azure.${key} must be a non-empty name or ID`);
    }
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(azure.organization)) fail('organization must be an organization name, not a URL');
  const branch = typeof azure.branch === 'string' ? azure.branch.replace(/^refs\/heads\//, '') : azure.branch;
  if (azure.branch !== undefined && (typeof azure.branch !== 'string' || !branch ||
    /[\s~^:?*\[\\\x00-\x1f\x7f]/.test(branch) || branch.includes('..') || branch.includes('@{') ||
    branch === '@' || branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock')))) {
    fail('azure.branch must be a valid branch name');
  }
  const directory = azure.directory ?? '/images';
  if (typeof directory !== 'string' || /[\\\x00-\x1f\x7f]/.test(directory) ||
    directory.split('/').some(part => part === '.' || part === '..')) fail('directory must be a repository directory path');
  const tokenEnv = azure.tokenEnv ?? 'AZURE_DEVOPS_PAT';
  if (typeof tokenEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) fail('tokenEnv must be an environment variable name');
  if (azure.token !== undefined && (typeof azure.token !== 'string' || !azure.token.trim() || /\s/.test(azure.token))) {
    fail('azure.token must be a non-empty PAT string without whitespace');
  }
  const maxSizeMiB = input.maxSizeMiB ?? 10;
  const timeoutMs = input.timeoutMs ?? 30000;
  if (!Number.isFinite(maxSizeMiB) || maxSizeMiB <= 0 || maxSizeMiB > 100) fail('maxSizeMiB must be greater than 0 and at most 100');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) fail('timeoutMs must be an integer between 100 and 300000');
  return { azure: { ...azure, branch, directory: '/' + directory.split('/').filter(Boolean).join('/'), tokenEnv }, maxSizeMiB, timeoutMs };
}

export async function loadConfig(file = 'azure-picbed.json') {
  const path = resolve(file);
  let input;
  try {
    input = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Configuration file not found: ${path}. Run azure-picbed config to create one`);
    throw new Error(`Cannot read valid JSON configuration: ${path}`);
  }
  return validateConfig(input);
}
