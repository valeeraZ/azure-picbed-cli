#!/usr/bin/env node
import { basename } from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { uploadImage } from './picbed.js';
import { configure } from './configure.js';

const HELP = `Usage:
  azure-picbed config [--config <path>]
  azure-picbed upload <image> [--config <path>] [--output <url|markdown|json>] [--alt <text>]
  azure-picbed help [upload|config]

Upload PNG, JPEG, GIF or WebP images to a public Azure DevOps Git repository.

Commands:
  config                     Interactively create or update configuration (requires a terminal).
  upload                     Upload one image and verify its anonymous URL.
  help                       Show usage; also available as -h or --help.

Options:
  --config <path>            Configuration file (default: ./azure-picbed.json).
  --output <format>          url (default), markdown or json.
  --alt <text>               Markdown image description (default: file name).
  --version                  Print the version.

Authentication: azure.token takes precedence over the environment variable named
by azure.tokenEnv (default: AZURE_DEVOPS_PAT).

Upload success: stdout contains only the requested result; stderr is empty.
Upload failure: stdout is empty; stderr contains one JSON error object.
Exit codes: 0 = success; 1 = input/API/uncertain upload; 2 = saved but URL verification failed.

Example:
  azure-picbed upload ./diagram.png --output markdown --alt "System architecture"
`;

export function parseArgs(args) {
  if (!args.length || (args.length === 1 && ['-h', '--help'].includes(args[0]))) return { help: true };
  if (args[0] === 'help') {
    if (args.length > 2 || (args[1] && !['upload', 'config'].includes(args[1]))) throw new Error('Usage: azure-picbed help [upload|config]');
    return { help: true };
  }
  if (args.length === 1 && args[0] === '--version') return { version: true };
  if (!['upload', 'config'].includes(args[0])) throw new Error('Expected upload, config or help; run azure-picbed help for usage');
  const options = { command: args[0], ...(args[0] === 'upload' ? { output: 'url' } : {}) };
  const seen = new Set();
  let positionalOnly = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!positionalOnly && ['-h', '--help'].includes(arg)) return { help: true };
    if (!positionalOnly && arg === '--') { positionalOnly = true; continue; }
    if (!positionalOnly && arg.startsWith('-')) {
      const allowed = options.command === 'config' ? ['--config'] : ['--config', '--output', '--alt'];
      if (!allowed.includes(arg)) throw new Error(`Unknown option: ${arg}`);
      if (args[i + 1] === undefined || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`);
      const key = arg.slice(2);
      if (seen.has(key)) throw new Error(`Duplicate option: ${arg}`);
      seen.add(key);
      options[key] = args[++i];
    } else {
      if (options.command === 'config') throw new Error('config does not accept positional arguments');
      if (options.file) throw new Error('Only one image may be uploaded at a time');
      options.file = arg;
    }
  }
  if (options.command === 'config') return options;
  if (!options.file) throw new Error('Missing local image path');
  if (!['url', 'markdown', 'json'].includes(options.output)) throw new Error('--output must be url, markdown or json');
  return options;
}

export function formatResult(result, options) {
  if (options.output === 'json') return JSON.stringify(result, null, 2);
  if (options.output === 'markdown') {
    const alt = (options.alt ?? basename(options.file)).replace(/[\r\n]/g, ' ').replace(/[\\\[\]<>]/g, '\\$&');
    return `![${alt}](${result.rawUrl})`;
  }
  return result.rawUrl;
}

export async function main(args, { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  try {
    const options = parseArgs(args);
    if (options.help) { stdout.write(HELP); return 0; }
    if (options.version) { stdout.write('0.1.0\n'); return 0; }
    if (options.command === 'config') {
      const result = await configure(options.config, { input: stdin, output: stderr });
      stdout.write(JSON.stringify(result) + '\n');
      return 0;
    }
    const config = await loadConfig(options.config);
    const result = await uploadImage(options.file, config, config.azure.token ?? env[config.azure.tokenEnv], { fetchImpl });
    stdout.write(formatResult(result, options) + '\n');
    return 0;
  } catch (error) {
    stderr.write(JSON.stringify({ error: { code: error.code ?? 'ERROR', message: error.message, ...(error.details ? { details: error.details } : {}) } }, null, 2) + '\n');
    return error.code === 'LINK_VERIFICATION_FAILED' ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
