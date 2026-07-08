# Merge Senpai GitHub App

This directory contains the canonical Merge Senpai GitHub App runtime: a
Cloudflare Worker that receives GitHub App webhooks and dispatches the installed
`merge-senpai.yml` workflow. It does not store repository state or OpenAI keys.

## Behavior

- Pull request events dispatch `merge-senpai.yml` when `SENPAI_AUTO_DISPATCH` is
  `true`.
- PR comments containing the word `senpai` dispatch `merge-senpai.yml`.
- App installation and repository-added events install the static setup files
  from `templates/` into each installed repository.
- Before dispatching a review, the Worker checks setup again and creates any
  missing files.
- Existing setup files are not overwritten by default. Set
  `SENPAI_SETUP_OVERWRITE=true` only if the app should replace edited local
  copies.
- Comment dispatch is authorized by checking the commenter's repository
  permission through GitHub before dispatching. Only write/admin-class access can
  trigger secret-backed workflows.
- The target repository still needs `MERGE_SENPAI_OPENAI_KEY` configured as a
  GitHub Actions secret.

## Credentials

The Worker reads GitHub App credentials from Cloudflare Worker secrets:

- `APP_ID`: identifies the GitHub App.
- `PRIVATE_KEY`: signs GitHub App JWTs so the Worker can mint installation
  access tokens.
- `WEBHOOK_SECRET`: verifies incoming webhook payloads from GitHub.

Do not commit real values.

The Worker does not set `MERGE_SENPAI_OPENAI_KEY` because it does not know the
user's OpenAI key. A setup page could collect and write that secret through the
GitHub Actions Secrets API later, but the current product keeps key entry inside
the user's repository settings or `gh secret set`.

Automatic setup writes directly to the repository default branch. Repositories
with branch protection that blocks GitHub App commits may need to allow this app
or use a future setup-PR fallback.

## Local Development

```bash
cp app/.dev.vars.example app/.dev.vars
cd app
npm install
npm run dev
```

For local webhook testing, use `wrangler dev --remote` plus a tunnel, or deploy
the development Worker and point the GitHub App webhook URL at that Worker URL.

## Cloudflare Deploy

The repository workflow `.github/workflows/deploy-merge-senpai-worker.yml`
deploys `src/worker.js` to Cloudflare Workers.

Set these GitHub Actions secrets in the Merge Senpai source repository:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `MERGE_SENPAI_APP_ID`
- `MERGE_SENPAI_APP_PRIVATE_KEY`
- `MERGE_SENPAI_WEBHOOK_SECRET`

The workflow syncs those values into Cloudflare Worker secrets:

- `APP_ID`
- `PRIVATE_KEY`
- `WEBHOOK_SECRET`

GitHub downloads app private keys as PKCS#1 PEM files
(`-----BEGIN RSA PRIVATE KEY-----`). Cloudflare Workers use WebCrypto, which
requires PKCS#8 for GitHub App JWT signing. The deploy workflow converts
`MERGE_SENPAI_APP_PRIVATE_KEY` to PKCS#8 before writing the Worker `PRIVATE_KEY`
secret, so keep the original GitHub-downloaded PEM in the repository secret.

Setup files are fetched from `SENPAI_TEMPLATE_BASE_URL`, which defaults to this
repository's raw `main` branch. For branch testing before merge, override that
Worker variable to a raw URL for the branch or commit being tested.

Run the workflow manually for `development` or `production`. Pushes to `main`
deploy production. The default Worker names are:

- `merge-senpai-github-app-dev`
- `merge-senpai-github-app`

After deploy, enable the GitHub App webhook and set its webhook URL to the
Worker URL, for example:

```text
https://merge-senpai-github-app.<your-workers-subdomain>.workers.dev/
```

## GitHub App Permissions

Use the permissions in the app registration UI:

- `Actions: read/write`
- `Contents: read/write`
- `Issues: read`
- `Metadata: read`
- `Pull requests: read`
- `Workflows: read/write`

Subscribe to these webhook events:

- `installation`
- `installation_repositories`
- `issue_comment`
- `pull_request`

The `Workflows: write` permission is required because the app creates
`.github/workflows/merge-senpai.yml`. Without it, GitHub rejects workflow-file
writes even when `Contents: write` is granted.
