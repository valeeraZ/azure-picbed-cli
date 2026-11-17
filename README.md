# Azure Picbed CLI

Upload local images to a public Azure DevOps Git repository and return anonymous image URLs pinned to an immutable commit. No clone, build step or runtime dependencies required. Requires Node.js 22 or newer.

Coding agents: start with [docs/agent-usage.md](docs/agent-usage.md) for the upload-to-Markdown workflow and machine-readable error handling.

## Quick start

Run from this repository:

```sh
node src/cli.js config
node src/cli.js help
node src/cli.js upload ./photo.png --output markdown --alt "Example photo"
```

Optionally run `npm link` in this repository to make `azure-picbed` available globally:

```sh
azure-picbed config
azure-picbed upload ./photo.png --output markdown --alt "Example photo"
```

Successful Markdown output contains exactly one ready-to-insert image line, with no banners or progress messages. Stderr is empty on upload success.

## Commands

### config

```sh
azure-picbed config [--config /path/to/azure-picbed.json]
```

The interactive terminal wizard asks for organization, project, repository, optional branch, image directory, authentication method, size limit and HTTP timeout. Choose `token` to store a PAT directly in JSON, or `env` to reference an environment variable. PAT input is hidden. Existing values are defaults, and existing PATs are never displayed. Press Enter to keep a default. Updates to an existing valid configuration require a yes/no confirmation. Ctrl+C cancels without saving partial changes.

Configuration is validated before saving, written atomically and created with owner-only permissions on POSIX systems. The parent directory must already exist. Stdout contains only `{ "saved": true, "path": "..." }`, or `saved: false` when an update is declined. Prompts go to stderr. No Azure request or upload occurs during configuration.

The wizard requires a terminal; unattended callers should supply a JSON file instead. Invalid existing configuration files are left untouched and must be fixed manually or replaced using a different path.

### help

```sh
azure-picbed help
azure-picbed help upload
azure-picbed help config
```

`-h` and `--help` also display usage. Running without arguments displays help. `--version` prints the version.

### upload

```sh
azure-picbed upload <image> [--config <path>] [--output <url|markdown|json>] [--alt <text>]
```

Examples:

```sh
azure-picbed upload ./photo.png
azure-picbed upload './photo with spaces.png' --output json
azure-picbed upload ./diagram.png --output markdown --alt "System architecture"
azure-picbed upload --output markdown -- ./-image.png
```

Use `--` before file names that begin with a hyphen. One image is supported per invocation. Accepted formats: PNG, JPEG, GIF and WebP, detected from file headers rather than the file extension. Header validation does not fully decode an image.

## Configuration

The default file is `./azure-picbed.json`. Both image and configuration paths are relative to the caller's working directory; `--config` can select an absolute path. A template is available in [azure-picbed.example.json](azure-picbed.example.json).

```json
{
  "azure": {
    "organization": "your-organization",
    "project": "your-public-project",
    "repo": "your-repository",
    "directory": "/images",
    "token": "your-personal-access-token"
  },
  "maxSizeMiB": 10,
  "timeoutMs": 30000
}
```

| Field | Behavior |
| --- | --- |
| `azure.organization` | Required organization name, not a username or URL. |
| `azure.project` | Required project name or ID. The project must be public. |
| `azure.repo` | Required repository name or ID. |
| `azure.branch` | Optional branch name, with or without `refs/heads/`. Defaults to the repository's default branch. |
| `azure.directory` | Repository directory; defaults to `/images`. `/` is supported. |
| `azure.token` | Optional inline PAT; takes precedence over environment authentication. |
| `azure.tokenEnv` | Environment variable used when `token` is omitted; defaults to `AZURE_DEVOPS_PAT`. |
| `maxSizeMiB` | Image size limit; defaults to 10, must be greater than 0 and at most 100. Azure request limits also apply. |
| `timeoutMs` | Per-HTTP-request timeout, including body reading; defaults to 30000, allowed range 100–300000. |

To use an environment variable, replace `"token": "your-personal-access-token"` with `"tokenEnv": "AZURE_DEVOPS_PAT"`. The PAT needs **Code: Read & write**, plus repository and branch permissions. Tokens are never placed in result URLs. The default `azure-picbed.json` is ignored by Git in this repository; ignore custom credential file paths separately.

For a non-empty repository, a missing target branch is an error. When Azure reports an empty repository with size 0, the CLI can create the initial branch; it uses `main` when no branch is configured.

Images are stored as `<directory>/<full-SHA-256>.<detected-extension>`. Matching Git blob content at the same path is reused without a new commit. File names are normalized to png, jpg, gif or webp.

## Output contract for agents

Upload stdout contains only the requested successful result and a trailing newline:

| Format | Stdout on success |
| --- | --- |
| `url` (default) | One anonymous image URL. |
| `markdown` | One escaped `![description](URL)` image line; description defaults to the local file name. |
| `json` | One JSON object with `path`, `branch`, `commitId`, `rawUrl`, `webUrl`, `deduplicated` and `verification`. |

Successful uploads produce no stderr output, even when a retry is needed. Failed uploads leave stdout empty and emit exactly one JSON error object on stderr. All CLI-owned messages and documentation are in English.

| Exit code | Meaning |
| --- | --- |
| 0 | Image saved or reused; anonymous image verification passed. |
| 1 | Input/configuration/API error, or upload result is uncertain. |
| 2 | Image saved or reused, but anonymous URL verification failed. |

Use `rawUrl` for Markdown. `webUrl` is the repository viewer page. Preserve the entire returned URL and its query parameters. `deduplicated` means existing remote content was reused, including recovery after a lost push response.

An error object has an `error.code`, English `error.message` and optional `error.details`. On exit 2, details preserve the commit, repository path and candidate URLs with `verification.verified=false`. Do not insert these candidates as verified working images. A saved commit is not rolled back after link verification fails.

For `UPLOAD_UNCERTAIN`, retry the same image and configuration after the network recovers. The CLI rereads the branch and checks for identical content before another push. It attempts at most three pushes and performs one final reconciliation after the last ambiguous response. Each push uses `oldObjectId` to guard against concurrent updates. Existing hash paths with different content produce `PATH_COLLISION` and are never overwritten. The CLI does not bypass branch policies, open PRs or change repository permissions.

## Anonymous image verification

The commit-pinned Items API URL includes `download=false` and `$format=octetStream`. Real-repository testing found that browser navigation Accept headers can cause Azure to transcode binary content as text while still returning an image MIME type. Setting `$format=octetStream` preserved the original bytes and restored browser display in the tested repository. That format value is not listed in the current Items API documentation, so Azure compatibility remains subject to verification.

Each upload checks three anonymous request profiles: default, browser navigation and image embedding. Each must return the expected image Content-Type, no attachment disposition, and exactly the original image bytes and SHA-256. No PAT or Cookie is sent during these checks. JSON, login pages, octet-stream MIME, attachments and mismatched content are rejected. `verification.checkedProfiles` records the profiles checked.

The existing real-repository JPEG was verified in a browser after the URL fix. Individual Markdown platforms can still restrict the domain or apply their own proxy/CSP rules; test the intended platform when needed.

Public Git history can retain uploaded images and paths after file deletion, and repository history grows with new images.

## Development

```sh
npm run check
npm test
```

Tests use local fixtures and mocked HTTP responses, require no PAT and do not modify Azure repositories. They cover configuration, output contracts, binary commits, deduplication, branch conflicts, uncertain-response recovery, permissions and anonymous response verification.

API references: [Pushes Create](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pushes/create?view=azure-devops-rest-7.1), [Items Get](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/items/get?view=azure-devops-rest-7.1), [Repositories Get](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/repositories/get-repository?view=azure-devops-rest-7.1).
