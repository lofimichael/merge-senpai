
# Merge Senpai

> [!IMPORTANT]
> **Project status: frozen hackathon edition.** This public repository is
> preserved as the completed Merge Senpai hackathon artifact. It is not under
> active feature development. See [PROJECT_STATUS.md](PROJECT_STATUS.md) for the
> maintenance policy.

<img width="192" height="192" alt="merge-senpai" src="https://github.com/user-attachments/assets/c1a41945-96df-4946-8577-34aee8c7d3c5" />

Merge Senpai is a BYOK PR reviewer that runs the code review inside the installing repository's GitHub Actions and uses a lightweight GitHub App dispatcher as its control plane.

## Install

Install the Merge Senpai GitHub App on the repositories you want reviewed. The
app writes the static setup files into each installed repository:

- `.github/workflows/merge-senpai.yml`
- `.github/workflows/merge-senpai-local-probe.yml`
- `.github/senpai.yml`
- `.github/merge-senpai/avatar.png`
- `.github/merge-senpai/player.html`
- `.github/merge-senpai/probe-local-models.mjs`
- `.github/merge-senpai/generate-media.mjs`
- `.github/merge-senpai/generate-higgsfield-video.mjs`
- `.github/merge-senpai/run-local-review.mjs`

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
- Can optionally use a local structured-output review provider instead of Codex/OpenAI.
- Posts a branded, nonblocking PR review as `github-actions[bot]`.
- Uploads a branded HTML review card as a workflow artifact.
- Can optionally generate media through a provider-neutral media layer.
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

## Review Providers

The default review provider is `codex-openai`, using the repository's
`MERGE_SENPAI_OPENAI_KEY`.

For local/offline review, configure `.github/senpai.yml`:

```yaml
review:
  review_provider: local-vllm # local-vllm | local-ollama | local-llama-cpp
  local_review_model: qwen3-coder
```

Then configure the endpoint as a repository secret or variable:

```bash
gh secret set MERGE_SENPAI_LOCAL_REVIEW_ENDPOINT
gh secret set MERGE_SENPAI_LOCAL_REVIEW_API_KEY # optional
```

Local review providers must return JSON matching Merge Senpai's review schema.
The workflow calls vLLM with JSON Schema response format, Ollama with its native
schema `format`, and llama.cpp-style OpenAI-compatible servers with JSON-object
format plus schema instructions. Merge Senpai still validates and normalizes the
JSON before posting a review.

Local review is opt-in. The default stays Codex/OpenAI because local model
quality varies by model, context length, repo language, and runner hardware.

## Optional Media Branch

The installed config publishes static review cards to `senpai-media` so demos
have an obvious artifact trail. Each run updates the branch with a README,
`index.html`, the latest report, avatar, and player assets. If generated media
is enabled and succeeds, the generated keyframe image and MP4 are committed to
the same branch and linked from the PR review.

Set `media.publish_media_branch: false` in `.github/senpai.yml` if you do not
want Merge Senpai to maintain that branch.

## Media Providers

Merge Senpai's media layer is provider-neutral:

```yaml
media:
  media_provider: off      # off | static | higgsfield | ltx-local
  media_runner_label: ubuntu-24.04
  publish_media_branch: true
  storage_branch: senpai-media
```

`static` and `off` never generate a video; the HTML review card is still
published when `publish_media_branch` is true.

### Higgsfield

Higgsfield media is opt-in per repository. Add these repository secrets in the
installed repository:

```bash
gh secret set HIGGS_KEY_ID
gh secret set HIGGS_API_SECRET
```

Then set `media.media_provider: higgsfield` in `.github/senpai.yml`. Merge Senpai
asks Codex for sanitized media prompts, calls Higgsfield Soul text-to-image to
create a keyframe, calls Higgsfield DoP image-to-video with that keyframe, and
commits the resulting assets to `senpai-media`.

The default profile uses Higgsfield's Cloud guide endpoints with a 1080p Soul
keyframe, then DoP Standard image-to-video. The richer `/v1` SDK-shaped routes
are kept as fallbacks because some accounts or model rollouts reject that request
shape.

- `media.higgsfield_image_endpoint: higgsfield-ai/soul/standard`
- `media.higgsfield_video_endpoint: higgsfield-ai/dop/standard`
- `media.higgsfield_fallback_image_endpoint: /v1/text2image/soul`
- `media.higgsfield_fallback_video_endpoint: /v1/image2video/dop`
- `media.higgsfield_image_quality: 1080p`
- `media.higgsfield_image_size: 1152x2048`
- `media.higgsfield_video_model: dop-standard`
- `media.higgsfield_enhance_prompt: true`

The review and HTML card are posted before Higgsfield runs. Higgsfield media is
generated afterward and only adds a separate PR comment if the MP4/keyframe are
successfully committed to `senpai-media`.

Higgsfield is best-effort. If media generation, media artifact upload, or
`senpai-media` publishing fails, Merge Senpai still posts the review and uploads
the HTML review card. When media is generated and published successfully, Merge
Senpai adds or updates a separate PR comment with the video, player, and keyframe
links from the `senpai-media` branch.

The workflow intentionally uses the API/key-secret path, not the local
Higgsfield CLI. The CLI is useful for model discovery, but it uses interactive
`higgsfield auth login` and exposes `job_set_type` names that are not guaranteed
to be identical to Cloud API endpoint strings.

Template installs keep this off by default. Public demo repos can enable it.
Private repos should treat Higgsfield as prompt egress to a second vendor and
enable it only deliberately.

### LTX Local

`media.media_provider: ltx-local` is for repositories with a prewarmed
self-hosted GPU runner or a local model wrapper command. It is not enabled by
default and should not download model weights in ordinary PR CI.

Recommended config:

```yaml
media:
  media_provider: ltx-local
  media_runner_label: '["self-hosted","gpu","ltx"]'
  ltx_model_dir: /opt/models/ltx-2.3
  ltx_cache_dir: /opt/models/.cache
  ltx_required_files: '["model.safetensors"]'
  ltx_require_gpu: true
  ltx_probe_command: /opt/merge-senpai/bin/probe-ltx
  ltx_probe_args_json: "[]"
  ltx_command: /opt/merge-senpai/bin/run-ltx
  ltx_args_json: "[]"
```

The runner command receives:

- `SENPAI_LTX_REQUEST_JSON`: provider-neutral media request.
- `SENPAI_VIDEO_OUTPUT`: MP4 path it must write.
- `SENPAI_IMAGE_OUTPUT_BASE`: optional keyframe output prefix.
- `SENPAI_LTX_MODEL_DIR`: configured model directory.
- `SENPAI_LTX_CACHE_DIR`, `HF_HOME`, `HUGGINGFACE_HUB_CACHE`,
  `TRANSFORMERS_CACHE`, `DIFFUSERS_CACHE`, and `XDG_CACHE_HOME`: cache paths
  selected by Merge Senpai from the configured or existing runner cache.

Run `Merge Senpai Local Model Probe` manually after configuring `ltx-local`. It
first resolves `.github/senpai.yml` on a GitHub-hosted runner, then schedules a
self-hosted probe only when `media_provider: ltx-local`, `media_runner_label`
is self-hosted, and the repository safety state is valid. The probe checks GPU
presence, model directory, optional required files, cache reuse/initialization,
and the optional probe command. It does not require an extra environment
variable to enable.

The workflow fails closed for unsafe self-hosted states. Public repositories and
fork PRs do not get direct self-hosted model jobs by default. For public repos,
the safer local-compute pattern is a user-owned model endpoint or queue called
from a GitHub-hosted workflow with bounded JSON artifacts, not a self-hosted
Actions runner that executes arbitrary PR workflows.

Merge Senpai does not upload dynamic GitHub comment attachments. GitHub supports
human drag-and-drop attachments in the browser, but the documented PR/comment
APIs do not provide a stable bot file-upload endpoint. Committed `senpai-media`
media files are real git objects; comment attachments are GitHub-hosted assets,
not git history.

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
templates/.github/workflows/merge-senpai-local-probe.yml
templates/.github/senpai.yml
templates/.github/merge-senpai/player.html
templates/.github/merge-senpai/probe-local-models.mjs
templates/.github/merge-senpai/generate-media.mjs
templates/.github/merge-senpai/generate-higgsfield-video.mjs
templates/.github/merge-senpai/run-local-review.mjs
```
