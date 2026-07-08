# Merge Senpai

Merge Senpai is a BYOK, no-server PR reviewer that runs inside your own GitHub Actions, posts a branded review, and can turn maintainer comments into same-branch fix commits.

```bash
curl -fsSL https://raw.githubusercontent.com/lofimichael/merge-senpai/main/install.sh | bash
```

Run that from the root of a GitHub repository. The installer finds the git root, creates `.github/` if needed, and writes a transparent install that you can review before committing:

- `.github/workflows/merge-senpai.yml`
- `.github/senpai.yml`
- `.github/merge-senpai/avatar.png`
- `.github/merge-senpai/player.html`

Then add the OpenAI key used only for this reviewer:

```bash
gh secret set MERGE_SENPAI_OPENAI_KEY
```

## What It Does

- Reviews same-repository pull requests on `opened`, `synchronize`, `reopened`, and `ready_for_review`.
- Runs Codex in GitHub Actions with your `MERGE_SENPAI_OPENAI_KEY`.
- Posts a branded, nonblocking PR review as `github-actions[bot]`.
- Uploads a branded HTML review card as a workflow artifact.
- Responds to maintainer comments like `/senpai fix the failing test`.
- Keeps fork PRs safe by skipping secret-backed review instead of exposing your key.

The default install is nonblocking. It will not fail your CI or block merges unless you change the workflow/config to do that.

## Branding

Workflow-only mode cannot change the GitHub actor from `github-actions[bot]`. GitHub controls that identity. Merge Senpai brands the parts we can control:

- Workflow name: `Merge Senpai`
- Check/job names: `review` and `fix`
- Review copy, labels, generated artifact, storage branch, and fix commit author
- Avatar copied into `.github/merge-senpai/avatar.png`

If you need comments to come from a real `merge-senpai` account, create a machine user or GitHub App and replace `GITHUB_TOKEN` usage with that token. The default stays simpler and fully BYOK.

## Commands

On a PR, comment:

```text
/senpai fix the bug and add a regression test
```

or:

```text
Senpai, fix the bug and add a regression test
```

Only `OWNER`, `MEMBER`, and `COLLABORATOR` comments trigger fixes. V1 refuses to push to fork PRs.

## Optional Media Branch

For public demos, you can create a storage branch for generated cards or future MP4 briefings:

```bash
SENPAI_CREATE_MEDIA_BRANCH=1 bash install.sh
```

This creates an orphan `senpai-media` branch using a temporary git worktree. It does not enable GitHub Pages for you; enable Pages manually if you want the branch to serve a public static player.

## Local Development

To install from a local checkout instead of the raw URL:

```bash
bash install.sh
```

Overwrite generated files intentionally:

```bash
bash install.sh --force
```

