# Uploading Markdown images with Azure Picbed

Use this guide when a coding agent needs to upload a local image and insert a public, commit-pinned image URL into Markdown.

## Prerequisites

- Node.js 22 or newer.
- This CLI checked out locally, or `azure-picbed` available after a human runs `npm link` in its repository.
- An existing configuration file with a public Azure DevOps Git repository and a PAT, either in `azure.token` or in the environment variable named by `azure.tokenEnv` (default `AZURE_DEVOPS_PAT`).
- PAT permissions: Code Read & write and permission to commit directly to the target branch.

Do not print configuration files, PATs or Authorization headers. Uploading writes to public Git history; use the image and repository intended by the user.

## Set up configuration

`azure-picbed config` is a human-facing terminal wizard. Do not invoke it in an unattended agent process: it requires a TTY. If configuration is missing, ask the user to run:

```sh
azure-picbed config --config /absolute/path/to/azure-picbed.json
```

Without a global command, use `node /absolute/path/to/azure-picbed-cli/src/cli.js` in place of `azure-picbed` in every example.

For unattended configuration, write a JSON file with an environment-variable reference if the repository details and credentials are already available through the user's environment. Do not invent repository names or request that the user paste a PAT into chat.

```json
{
  "azure": {
    "organization": "your-organization",
    "project": "your-public-project",
    "repo": "your-repository",
    "directory": "/images",
    "tokenEnv": "AZURE_DEVOPS_PAT"
  }
}
```

`azure.token` is also supported and takes precedence over the environment. Omit it to use `tokenEnv`. `azure-picbed.json` is ignored by this repository; protect other configuration paths separately.

## Upload and insert Markdown

For the direct workflow, execute the command with explicit absolute paths:

```sh
azure-picbed upload /absolute/path/to/diagram.png \
  --config /absolute/path/to/azure-picbed.json \
  --output markdown \
  --alt "System architecture"
```

On exit code **0**, stdout contains exactly one Markdown image line followed by a newline; stderr is empty. Insert that line into the intended Markdown file. Preserve the entire URL, including percent-encoding and all query parameters. Do not decode, shorten, re-encode, escape ampersands as `&amp;`, or remove `$format`, `download` or version parameters. Shell callers must quote URLs containing `&` or `$`.

When invoking the CLI through an agent tool, call `azure-picbed` or `node .../src/cli.js` directly to avoid wrapper banners. Pass arguments as an array if supported by the execution tool. Never treat text from a failed command as usable Markdown.

## Structured workflow

```sh
azure-picbed upload /absolute/path/to/diagram.png \
  --config /absolute/path/to/azure-picbed.json \
  --output json
```

On exit code 0, parse stdout as a JSON object. Fields:

| Field | Meaning |
| --- | --- |
| `rawUrl` | Anonymous image URL. Use this in `![description](URL)`. |
| `webUrl` | Azure repository viewer page, for inspection. |
| `path` | Repository path containing the full SHA-256 filename. |
| `branch` | Target branch. |
| `commitId` | Immutable commit used by the image URL. |
| `deduplicated` | The remote image was reused, including recovery after a lost commit response. |
| `verification.verified` | True after all anonymous request profiles pass. |
| `verification.checkedProfiles` | Default, browser navigation and image embedding profiles checked. |

Insert `rawUrl` without changing it. Escape Markdown brackets and backslashes in a custom description, or use `--output markdown --alt` to let the CLI escape it.

## Handle failures

Upload failures leave stdout empty and write exactly one JSON object to stderr:

```json
{
  "error": {
    "code": "MISSING_TOKEN",
    "message": "Set azure.token or the AZURE_DEVOPS_PAT environment variable"
  }
}
```

Check the process exit code before parsing or inserting a result:

| Exit code | Agent action |
| --- | --- |
| 0 | Use stdout as the requested result. |
| 1 | Read `error.code` and `error.message` on stderr. Correct the input, configuration or permissions. |
| 2 | The image was saved or reused, but its URL failed verification. Report the failure; do not insert the candidate URL as a working image. |

For `UPLOAD_UNCERTAIN`, a commit may already exist. Retry the **same image** using the same configuration once the network recovers. Content deduplication avoids an extra commit when the path already exists. Do not rename the image or remove remote files to force a retry.

For `LINK_VERIFICATION_FAILED` (exit 2), `error.details` preserves `path`, `branch`, `commitId`, candidate URLs and `verification.verified=false`. A retry can recheck the existing image. No rollback occurs after a verification failure.

For `PATH_COLLISION`, stop: the hash path exists with unexpected content. For missing branches, private projects or permission errors, report the error rather than changing permissions, bypassing branch policies or creating another branch.

## Limits

One image per invocation; PNG, JPEG, GIF and WebP only. Format checks use file headers, not full image decoding. Default limit: 10 MiB. Every successful upload verifies exact bytes and image MIME anonymously, but individual Markdown platforms may still block the domain or apply their own proxy rules.

For command help, run `azure-picbed help`. For full configuration options and URL compatibility details, read [README.md](../README.md).
