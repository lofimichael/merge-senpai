# Merge Senpai

Merge Senpai is a BYOK PR reviewer that runs the code review inside the installing repository's GitHub Actions and uses a lightweight GitHub App dispatcher as its control plane.

## Install

Install the Merge Senpai GitHub App on the repositories you want reviewed. The
app writes the static setup files into each installed repository:

- `.github/workflows/merge-senpai.yml`
- `.github/senpai.yml`
- `.github/merge-senpai/avatar.png`
- `.github/merge-senpai/player.html`

Then add the OpenAI key used only for this reviewer to each repository:

```bash
gh secret set MERGE_SENPAI_OPENAI_KEY
```

The app does not synthesize workflow YAML. The exact files it installs live in
this repository under `templates/`, so the source template and installed result
are easy to diff.

If a repository's default branch protection blocks direct commits from GitHub
Apps, automatic setup can fail. In that case, allow this app to write setup
commits or add a setup-PR fallback before relying on zero-touch install for that
repository.

## What It Does

- Reviews same-repository pull requests on `opened`, `synchronize`, `reopened`, and `ready_for_review`.
- Runs Codex in GitHub Actions with your `MERGE_SENPAI_OPENAI_KEY`.
- Posts a branded, nonblocking PR review as `github-actions[bot]`.
- Uploads a branded HTML review card as a workflow artifact.
- Responds to write/admin-class maintainer comments that mention `senpai`.
- Keeps fork PRs safe by skipping secret-backed review instead of exposing your key.

The default install is nonblocking. It will not fail your CI or block merges unless you change the workflow/config to do that.

## Branding

The current workflow posts reviews as `github-actions[bot]`. GitHub controls that identity unless review posting moves fully into the GitHub App. Merge Senpai brands the parts we can control:

- Workflow name: `Merge Senpai`
- Check/job name: `review`
- Review copy, generated artifact, storage branch, and installed avatar
- Avatar copied into `.github/merge-senpai/avatar.png`

The Cloudflare Worker dispatcher gives the product a GitHub App boundary for
receiving webhooks and dispatching workflow runs. The review itself still runs
inside the user's repository, on the user's OpenAI key.

## Commands

On a PR, comment:

```text
/senpai review
```

or:

```text
Can senpai look at this?
```

Only commenters with write/admin-class access to the repository can dispatch a review.

## Optional Media Branch

The installed config includes a `senpai-media` storage branch setting for future
public demo artifacts. It is disabled by default.

## GitHub App

- Worker source: `app/src/worker.js`
- Wrangler config: `app/wrangler.toml`
- Deploy workflow: `.github/workflows/deploy-merge-senpai-worker.yml`

Store the GitHub App credentials as GitHub Actions secrets in this Merge Senpai source repo, not in source files:

- `MERGE_SENPAI_APP_ID`
- `MERGE_SENPAI_APP_PRIVATE_KEY`
- `MERGE_SENPAI_WEBHOOK_SECRET`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

The deploy workflow syncs those values into Cloudflare Worker secrets.

The GitHub App needs these repository permissions:

- `Actions: read/write`
- `Contents: read/write`
- `Issues: read`
- `Metadata: read`
- `Pull requests: read`
- `Workflows: read/write`

Subscribe it to `installation`, `installation_repositories`, `issue_comment`,
and `pull_request` events.

## Local Development

```bash
cd app
npm install
npm run dev
```

See `app/README.md` for GitHub App permissions and hosting notes.

To edit the setup payload that the app writes into installed repositories, change
files under `templates/` directly:

```bash
templates/.github/workflows/merge-senpai.yml
templates/.github/senpai.yml
templates/.github/merge-senpai/player.html
```
