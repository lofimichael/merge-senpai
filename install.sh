#!/usr/bin/env bash
set -euo pipefail

FORCE="${SENPAI_FORCE:-0}"
CREATE_MEDIA_BRANCH="${SENPAI_CREATE_MEDIA_BRANCH:-0}"
RAW_BASE="${SENPAI_RAW_BASE:-https://raw.githubusercontent.com/lofimichael/merge-senpai/main}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --force)
      FORCE=1
      ;;
    --media-branch|--create-media-branch)
      CREATE_MEDIA_BRANCH=1
      ;;
    -h|--help)
      cat <<'HELP'
Merge Senpai installer

Usage:
  bash install.sh [--force] [--media-branch]

Environment:
  MERGE_SENPAI_OPENAI_KEY   If set, installer will store it with gh secret set.
  SENPAI_FORCE=1            Overwrite generated files.
  SENPAI_CREATE_MEDIA_BRANCH=1
                            Create/push an orphan senpai-media storage branch.
  SENPAI_RAW_BASE=url       Override raw asset base URL.
HELP
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

if git_root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  cd "$git_root"
else
  echo "Merge Senpai should be installed from inside a git repository." >&2
  exit 1
fi

write_file() {
  local path="$1"
  if [ -e "$path" ] && [ "$FORCE" != "1" ]; then
    echo "Refusing to overwrite $path. Re-run with --force if intended." >&2
    exit 1
  fi
  mkdir -p "$(dirname "$path")"
  cat > "$path"
}

mkdir -p .github/workflows .github/merge-senpai

write_file ".github/senpai.yml" <<'YAML'
version: 1
persona: tsundere
model: gpt-5.4-mini
blocking: false

review:
  max_findings: 8
  focus:
    - correctness
    - security
    - data-loss
    - tests

commands:
  fix: true
  require_author_association:
    - OWNER
    - MEMBER
    - COLLABORATOR

media:
  artifact_html: true
  publish_media_branch: false
  storage_branch: senpai-media
YAML

write_file ".github/merge-senpai/player.html" <<'HTML'
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Merge Senpai Briefing</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #101012;
      --panel: #19191d;
      --ink: #f7f2ea;
      --muted: #b8b1a8;
      --line: #343238;
      --red: #ff5b6e;
      --gold: #f3c969;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background:
        linear-gradient(135deg, rgba(255,91,110,.14), transparent 34%),
        radial-gradient(circle at 80% 12%, rgba(243,201,105,.12), transparent 28%),
        var(--bg);
      color: var(--ink);
      font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(980px, calc(100vw - 32px));
      border: 1px solid var(--line);
      background: color-mix(in srgb, var(--panel) 94%, transparent);
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 24px 80px rgba(0,0,0,.36);
    }
    header {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 18px 20px;
      border-bottom: 1px solid var(--line);
    }
    img {
      width: 56px;
      height: 56px;
      border-radius: 6px;
      border: 1px solid var(--line);
      background: #fff;
    }
    h1 {
      margin: 0;
      font-size: 20px;
      letter-spacing: 0;
    }
    p {
      margin: 2px 0 0;
      color: var(--muted);
    }
    .stage {
      padding: 20px;
    }
    video {
      width: 100%;
      aspect-ratio: 16 / 9;
      display: block;
      background: #050506;
      border: 1px solid var(--line);
      border-radius: 6px;
    }
    .empty {
      min-height: 240px;
      display: grid;
      place-items: center;
      border: 1px dashed var(--line);
      border-radius: 6px;
      color: var(--muted);
      text-align: center;
      padding: 24px;
    }
    code {
      color: var(--gold);
      word-break: break-all;
    }
  </style>
</head>
<body>
  <main>
    <header>
      <img src="./avatar.png" alt="Merge Senpai">
      <div>
        <h1>Merge Senpai Briefing</h1>
        <p>Drop an MP4 URL in <code>#v=...</code> to play a PR status briefing.</p>
      </div>
    </header>
    <section class="stage" id="stage"></section>
  </main>
  <script>
    const params = new URLSearchParams(location.hash.slice(1));
    const videoUrl = params.get("v");
    const stage = document.getElementById("stage");
    if (videoUrl) {
      const video = document.createElement("video");
      video.controls = true;
      video.playsInline = true;
      video.src = videoUrl;
      stage.append(video);
    } else {
      stage.innerHTML = '<div class="empty">No briefing URL yet.<br>Use <code>player.html#v=https://example.com/senpai.mp4</code>.</div>';
    }
  </script>
</body>
</html>
HTML

write_file ".github/workflows/merge-senpai.yml" <<'YAML'
name: Merge Senpai

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  issue_comment:
    types: [created]
  workflow_dispatch:
    inputs:
      pr_number:
        description: Pull request number to review
        required: true
      reason:
        description: Why this review was dispatched
        required: false
        default: manual

permissions:
  contents: read

concurrency:
  group: merge-senpai-${{ github.event.pull_request.number || github.event.issue.number || inputs.pr_number || github.run_id }}
  cancel-in-progress: true

env:
  SENPAI_BRAND: Merge Senpai
  SENPAI_DEFAULT_MODEL: gpt-5.4-mini
  SENPAI_MODEL: gpt-5.4-mini

jobs:
  review:
    name: review
    if: github.event_name == 'pull_request' || github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-24.04
    permissions:
      contents: write
      pull-requests: write
      issues: write
    steps:
      - name: Checkout repository
        uses: actions/checkout@v6
        with:
          fetch-depth: 0
          persist-credentials: false

      - name: Resolve pull request context
        id: ctx
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          set -euo pipefail
          if [ "${{ github.event_name }}" = "pull_request" ]; then
            PR_NUMBER="$(jq -r '.pull_request.number' "$GITHUB_EVENT_PATH")"
            BASE_REF="$(jq -r '.pull_request.base.ref' "$GITHUB_EVENT_PATH")"
            HEAD_REF="$(jq -r '.pull_request.head.ref' "$GITHUB_EVENT_PATH")"
            HEAD_SHA="$(jq -r '.pull_request.head.sha' "$GITHUB_EVENT_PATH")"
            HEAD_REPO="$(jq -r '.pull_request.head.repo.full_name' "$GITHUB_EVENT_PATH")"
          else
            PR_NUMBER="${{ inputs.pr_number }}"
            gh api "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER" > "$RUNNER_TEMP/pr.json"
            BASE_REF="$(jq -r '.base.ref' "$RUNNER_TEMP/pr.json")"
            HEAD_REF="$(jq -r '.head.ref' "$RUNNER_TEMP/pr.json")"
            HEAD_SHA="$(jq -r '.head.sha' "$RUNNER_TEMP/pr.json")"
            HEAD_REPO="$(jq -r '.head.repo.full_name' "$RUNNER_TEMP/pr.json")"
          fi

          {
            echo "PR_NUMBER=$PR_NUMBER"
            echo "BASE_REF=$BASE_REF"
            echo "HEAD_REF=$HEAD_REF"
            echo "HEAD_SHA=$HEAD_SHA"
            echo "HEAD_REPO=$HEAD_REPO"
          } >> "$GITHUB_ENV"

      - name: Gate secret-backed review
        id: gate
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          set -euo pipefail
          enabled=true
          reason=""

          if [ "$HEAD_REPO" != "$GITHUB_REPOSITORY" ]; then
            enabled=false
            reason="Merge Senpai skipped this fork PR because GitHub does not pass repository secrets to fork-triggered workflows. Ask a maintainer to run a trusted same-repo review if needed."
          elif [ "${{ secrets.MERGE_SENPAI_OPENAI_KEY != '' }}" != "true" ]; then
            enabled=false
            reason="Merge Senpai is installed, but MERGE_SENPAI_OPENAI_KEY is not configured yet."
          fi

          echo "enabled=$enabled" >> "$GITHUB_OUTPUT"

          if [ "$enabled" != "true" ]; then
            {
              echo "## Merge Senpai"
              echo
              echo "$reason"
            } > "$RUNNER_TEMP/senpai-skip.md"
            gh pr comment "$PR_NUMBER" --body-file "$RUNNER_TEMP/senpai-skip.md" || true
            cat "$RUNNER_TEMP/senpai-skip.md" >> "$GITHUB_STEP_SUMMARY"
          fi

      - name: Checkout pull request merge
        if: steps.gate.outputs.enabled == 'true'
        run: |
          set -euo pipefail
          git fetch origin "$BASE_REF" --depth=1 || true
          git fetch origin "refs/pull/$PR_NUMBER/merge:refs/remotes/origin/senpai-pr-$PR_NUMBER-merge" || true
          git fetch origin "refs/pull/$PR_NUMBER/head:refs/remotes/origin/senpai-pr-$PR_NUMBER" || true
          git checkout --detach "refs/remotes/origin/senpai-pr-$PR_NUMBER-merge" || git checkout --detach "refs/remotes/origin/senpai-pr-$PR_NUMBER"

      - name: Prepare Codex review prompt
        if: steps.gate.outputs.enabled == 'true'
        run: |
          set -euo pipefail
          git show "origin/$BASE_REF:.github/senpai.yml" > "$RUNNER_TEMP/base-senpai.yml" 2>/dev/null || cp .github/senpai.yml "$RUNNER_TEMP/base-senpai.yml"
          MODEL="$(sed -n -E 's/^model:[[:space:]]*"?([^"#]+)"?.*/\1/p' "$RUNNER_TEMP/base-senpai.yml" | head -1 | xargs || true)"
          echo "SENPAI_MODEL=${MODEL:-$SENPAI_DEFAULT_MODEL}" >> "$GITHUB_ENV"

          cat > "$RUNNER_TEMP/senpai.schema.json" <<'JSON'
          {
            "type": "object",
            "additionalProperties": false,
            "required": ["verdict", "grade", "summary", "persona_line", "briefing_script", "image_prompt", "findings"],
            "properties": {
              "verdict": { "type": "string", "enum": ["clean", "comment", "request_changes"] },
              "grade": { "type": "string" },
              "summary": { "type": "string" },
              "persona_line": { "type": "string" },
              "briefing_script": { "type": "string" },
              "image_prompt": { "type": "string" },
              "findings": {
                "type": "array",
                "items": {
                  "type": "object",
                  "additionalProperties": false,
                  "required": ["severity", "title", "file", "line", "message", "suggestion"],
                  "properties": {
                    "severity": { "type": "string", "enum": ["P0", "P1", "P2", "P3"] },
                    "title": { "type": "string" },
                    "file": { "type": "string" },
                    "line": { "type": "integer" },
                    "message": { "type": "string" },
                    "suggestion": { "type": "string" }
                  }
                }
              }
            }
          }
          JSON

          git diff --unified=80 "origin/$BASE_REF"...HEAD > "$RUNNER_TEMP/pr.diff" 2>/dev/null || git diff --unified=80 HEAD~1...HEAD > "$RUNNER_TEMP/pr.diff" 2>/dev/null || true
          git diff --stat "origin/$BASE_REF"...HEAD > "$RUNNER_TEMP/pr.stat" 2>/dev/null || true

          cat > "$RUNNER_TEMP/senpai.prompt.md" <<'PROMPT'
          You are Merge Senpai, a stern but caring CI reviewer.

          Review this pull request for correctness, security, data loss, broken tests, migration risk, and surprising behavior. Prefer high-signal findings over style nits.

          Output only JSON matching the provided schema. Persona is allowed only in persona_line, summary, briefing_script, and optionally finding titles. Keep finding messages clinical and actionable.

          Severity policy:
          - P0: security/data-loss/corruption or guaranteed production breakage.
          - P1: likely correctness bug, broken core workflow, missing critical test.
          - P2: important maintainability or edge-case issue.
          - P3: minor concern or polish.

          If there are no material issues, return verdict "clean" with an empty findings array.
          PROMPT

          {
            echo
            echo "Repository: $GITHUB_REPOSITORY"
            echo "Pull request: #$PR_NUMBER"
            echo "Base ref: $BASE_REF"
            echo "Head ref: $HEAD_REF"
            echo "Head SHA: $HEAD_SHA"
            echo
            echo "Base-branch Merge Senpai config:"
            sed -n '1,220p' "$RUNNER_TEMP/base-senpai.yml"
            echo
            echo "Diff stat:"
            sed -n '1,160p' "$RUNNER_TEMP/pr.stat"
            echo
            echo "Unified diff, truncated if needed:"
            head -c 120000 "$RUNNER_TEMP/pr.diff"
          } >> "$RUNNER_TEMP/senpai.prompt.md"

      - name: Run Codex review
        if: steps.gate.outputs.enabled == 'true'
        id: codex
        continue-on-error: true
        uses: openai/codex-action@v1
        with:
          openai-api-key: ${{ secrets.MERGE_SENPAI_OPENAI_KEY }}
          model: ${{ env.SENPAI_MODEL }}
          prompt-file: ${{ runner.temp }}/senpai.prompt.md
          output-file: ${{ runner.temp }}/senpai-review.json
          sandbox: read-only
          codex-args: '["--ephemeral", "--output-schema", "${{ runner.temp }}/senpai.schema.json"]'

      - name: Normalize review JSON
        if: steps.gate.outputs.enabled == 'true'
        run: |
          node <<'NODE'
          const fs = require("fs");
          const path = `${process.env.RUNNER_TEMP}/senpai-review.json`;
          let raw = fs.existsSync(path) ? fs.readFileSync(path, "utf8").trim() : "";
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch {
            const match = raw.match(/\{[\s\S]*\}/);
            if (match) {
              try { parsed = JSON.parse(match[0]); } catch {}
            }
          }
          if (!parsed || !Array.isArray(parsed.findings)) {
            parsed = {
              verdict: "comment",
              grade: "?",
              summary: "Codex did not return valid review JSON. The raw response is attached in the workflow logs.",
              persona_line: "I asked for clean JSON and got a paper crane instead. Hmph.",
              briefing_script: "Merge Senpai could not parse the review output. Please inspect the workflow logs and re-run the review.",
              image_prompt: "",
              findings: []
            };
          }
          fs.writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
          NODE

      - name: Post branded review
        if: steps.gate.outputs.enabled == 'true'
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          set -euo pipefail
          node <<'NODE'
          const fs = require("fs");
          const review = JSON.parse(fs.readFileSync(`${process.env.RUNNER_TEMP}/senpai-review.json`, "utf8"));
          const findings = Array.isArray(review.findings) ? review.findings : [];
          const blockers = findings.filter(f => ["P0", "P1"].includes(String(f.severity))).length;
          const avatarUrl = `https://raw.githubusercontent.com/${process.env.GITHUB_REPOSITORY}/${process.env.BASE_REF}/.github/merge-senpai/avatar.png`;
          const marker = `<!-- merge-senpai:review:${process.env.PR_NUMBER}:${process.env.HEAD_SHA} -->`;

          function mdEscape(value) {
            return String(value ?? "").replace(/\r/g, "").trim();
          }
          function cmdEscape(value) {
            return String(value ?? "")
              .replace(/%/g, "%25")
              .replace(/\r/g, "%0D")
              .replace(/\n/g, "%0A");
          }
          function propEscape(value) {
            return cmdEscape(value).replace(/,/g, "%2C").replace(/:/g, "%3A");
          }
          function htmlEscape(value) {
            return String(value ?? "")
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/"/g, "&quot;");
          }

          let body = `${marker}\n<img src="${avatarUrl}" width="72" align="right" alt="Merge Senpai" />\n\n`;
          body += `# Merge Senpai says: ${mdEscape(review.grade || "?")}\n\n`;
          body += `**Verdict:** \`${mdEscape(review.verdict || "comment")}\`  \n`;
          body += `**Findings:** ${findings.length} total, ${blockers} blocking-class\n\n`;
          body += `> ${mdEscape(review.persona_line || "I reviewed it because somebody had to.")}\n\n`;
          body += `${mdEscape(review.summary || "No summary returned.")}\n\n`;

          if (findings.length) {
            body += `## Findings\n\n`;
            for (const finding of findings) {
              const sev = mdEscape(finding.severity || "P3");
              const file = mdEscape(finding.file || "");
              const line = Number.isFinite(Number(finding.line)) ? Number(finding.line) : 1;
              body += `### ${sev}: ${mdEscape(finding.title || "Untitled finding")}\n\n`;
              body += `\`${file}:${line}\`\n\n`;
              body += `${mdEscape(finding.message || "")}\n\n`;
              if (finding.suggestion) {
                body += `**Suggestion:** ${mdEscape(finding.suggestion)}\n\n`;
              }

              const level = ["P0", "P1"].includes(sev) ? "warning" : "notice";
              const title = `${sev}: ${finding.title || "Merge Senpai finding"}`;
              const props = [`file=${propEscape(file)}`, `line=${line}`, `title=${propEscape(title)}`].join(",");
              console.log(`::${level} ${props}::${cmdEscape(finding.message || title)}`);
            }
          } else {
            body += `No material findings. Don't get smug.\n\n`;
          }

          body += `---\n`;
          body += `Generated inside this repository by \`Merge Senpai\` using the repository's own \`MERGE_SENPAI_OPENAI_KEY\`.\n`;
          fs.writeFileSync(`${process.env.RUNNER_TEMP}/senpai-review.md`, body);
          fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${body}\n`);

          const localAvatar = ".github/merge-senpai/avatar.png";
          const avatarData = fs.existsSync(localAvatar) ? fs.readFileSync(localAvatar).toString("base64") : "";
          const avatarSrc = avatarData ? `data:image/png;base64,${avatarData}` : avatarUrl;
          const rows = findings.map(f => `
            <article>
              <strong>${htmlEscape(f.severity || "P3")} - ${htmlEscape(f.title || "Untitled finding")}</strong>
              <code>${htmlEscape(f.file || "")}:${htmlEscape(f.line || "")}</code>
              <p>${htmlEscape(f.message || "")}</p>
            </article>
          `).join("");
          const html = `<!doctype html>
          <html lang="en">
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Merge Senpai Review PR #${htmlEscape(process.env.PR_NUMBER)}</title>
            <style>
              body{margin:0;background:#101012;color:#f7f2ea;font:16px/1.5 ui-sans-serif,system-ui;padding:32px}
              main{max-width:900px;margin:auto;border:1px solid #343238;border-radius:8px;background:#19191d;overflow:hidden}
              header{display:flex;gap:18px;align-items:center;padding:22px;border-bottom:1px solid #343238}
              img{width:72px;height:72px;border-radius:6px;background:#fff}
              h1{margin:0;font-size:28px} p{color:#c8c0b8} section{padding:22px}
              article{border-top:1px solid #343238;padding:16px 0} code{display:block;color:#f3c969;margin-top:4px}
            </style>
          </head>
          <body>
            <main>
              <header><img src="${avatarSrc}" alt=""><div><h1>Merge Senpai: ${htmlEscape(review.grade || "?")}</h1><p>${htmlEscape(review.persona_line || "")}</p></div></header>
              <section><h2>${htmlEscape(review.verdict || "comment")}</h2><p>${htmlEscape(review.summary || "")}</p>${rows || "<p>No material findings.</p>"}</section>
            </main>
          </body>
          </html>`;
          fs.writeFileSync(`${process.env.RUNNER_TEMP}/senpai-report.html`, html);
          NODE

          gh pr review "$PR_NUMBER" --comment --body-file "$RUNNER_TEMP/senpai-review.md" \
            || gh pr comment "$PR_NUMBER" --body-file "$RUNNER_TEMP/senpai-review.md" \
            || true

      - name: Upload branded review card
        if: steps.gate.outputs.enabled == 'true'
        uses: actions/upload-artifact@v4
        with:
          name: merge-senpai-pr-${{ env.PR_NUMBER }}
          path: ${{ runner.temp }}/senpai-report.html
          if-no-files-found: error
          retention-days: 14

      - name: Publish to senpai-media branch
        if: steps.gate.outputs.enabled == 'true'
        env:
          GITHUB_TOKEN: ${{ github.token }}
        run: |
          set -euo pipefail
          if ! grep -Eq '^  publish_media_branch:[[:space:]]*true|^publish_media_branch:[[:space:]]*true' "$RUNNER_TEMP/base-senpai.yml"; then
            exit 0
          fi
          branch="$(sed -n -E 's/^  storage_branch:[[:space:]]*"?([^"#]+)"?.*/\1/p; s/^storage_branch:[[:space:]]*"?([^"#]+)"?.*/\1/p' "$RUNNER_TEMP/base-senpai.yml" | head -1 | xargs || true)"
          branch="${branch:-senpai-media}"
          tmp="$(mktemp -d)"
          git worktree add --detach "$tmp" HEAD
          (
            cd "$tmp"
            git config user.name "Merge Senpai"
            git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
            git remote set-url origin "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
            if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
              git fetch origin "$branch"
              git checkout "$branch"
            else
              git switch --orphan "$branch"
              git rm -rf . >/dev/null 2>&1 || true
            fi
            mkdir -p "pr-$PR_NUMBER"
            cp "$RUNNER_TEMP/senpai-report.html" "pr-$PR_NUMBER/$HEAD_SHA.html"
            cp "$GITHUB_WORKSPACE/.github/merge-senpai/player.html" "player.html" 2>/dev/null || true
            cp "$GITHUB_WORKSPACE/.github/merge-senpai/avatar.png" "avatar.png" 2>/dev/null || true
            git add .
            git commit -m "Store Merge Senpai report for PR #$PR_NUMBER" || exit 0
            git push origin "HEAD:$branch"
          )
          git worktree remove "$tmp" --force

  fix:
    name: fix
    if: >-
      github.event_name == 'issue_comment' &&
      github.event.issue.pull_request != null &&
      (
        startsWith(github.event.comment.body, '/senpai') ||
        startsWith(github.event.comment.body, 'Senpai,') ||
        startsWith(github.event.comment.body, 'senpai,')
      ) &&
      contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association)
    runs-on: ubuntu-24.04
    permissions:
      contents: write
      pull-requests: write
      issues: write
      actions: write
    steps:
      - name: React to command
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          gh api \
            --method POST \
            -H "Accept: application/vnd.github+json" \
            "repos/$GITHUB_REPOSITORY/issues/comments/${{ github.event.comment.id }}/reactions" \
            -f content=eyes >/dev/null || true

      - name: Resolve pull request
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          set -euo pipefail
          PR_NUMBER="${{ github.event.issue.number }}"
          gh api "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER" > "$RUNNER_TEMP/pr.json"
          BASE_REF="$(jq -r '.base.ref' "$RUNNER_TEMP/pr.json")"
          HEAD_REF="$(jq -r '.head.ref' "$RUNNER_TEMP/pr.json")"
          HEAD_REPO="$(jq -r '.head.repo.full_name' "$RUNNER_TEMP/pr.json")"
          {
            echo "PR_NUMBER=$PR_NUMBER"
            echo "BASE_REF=$BASE_REF"
            echo "HEAD_REF=$HEAD_REF"
            echo "HEAD_REPO=$HEAD_REPO"
          } >> "$GITHUB_ENV"

          if [ "$HEAD_REPO" != "$GITHUB_REPOSITORY" ]; then
            gh pr comment "$PR_NUMBER" --body "Merge Senpai refuses to push fixes to fork PRs in workflow mode. Make a same-repo branch or apply the suggestion manually." || true
            echo "SENPAI_FIX_ENABLED=false" >> "$GITHUB_ENV"
          elif [ "${{ secrets.MERGE_SENPAI_OPENAI_KEY != '' }}" != "true" ]; then
            gh pr comment "$PR_NUMBER" --body "Merge Senpai cannot fix this yet because MERGE_SENPAI_OPENAI_KEY is not configured." || true
            echo "SENPAI_FIX_ENABLED=false" >> "$GITHUB_ENV"
          else
            echo "SENPAI_FIX_ENABLED=true" >> "$GITHUB_ENV"
          fi

      - name: Checkout repository
        if: env.SENPAI_FIX_ENABLED == 'true'
        uses: actions/checkout@v6
        with:
          fetch-depth: 0
          token: ${{ github.token }}

      - name: Checkout pull request branch
        if: env.SENPAI_FIX_ENABLED == 'true'
        run: |
          set -euo pipefail
          git fetch origin "refs/heads/$HEAD_REF:refs/remotes/origin/$HEAD_REF"
          git checkout -B "$HEAD_REF" "refs/remotes/origin/$HEAD_REF"

      - name: Prepare Codex fix prompt
        if: env.SENPAI_FIX_ENABLED == 'true'
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          set -euo pipefail
          gh pr view "$PR_NUMBER" --json title,body,reviews,comments > "$RUNNER_TEMP/pr-context.json" || echo '{}' > "$RUNNER_TEMP/pr-context.json"
          cat > "$RUNNER_TEMP/senpai-fix.prompt.md" <<'PROMPT'
          You are Merge Senpai in fix mode.

          A trusted maintainer asked you to update this same-repository pull request. Make the smallest coherent code change that satisfies the request. Add or update tests when appropriate. Do not rewrite unrelated code. Do not touch workflow secrets or credentials. Do not commit; leave changes in the workspace.
          PROMPT
          {
            echo
            echo "Pull request: #$PR_NUMBER"
            echo "Maintainer command:"
            jq -r '.comment.body' "$GITHUB_EVENT_PATH"
            echo
            echo "PR context JSON:"
            cat "$RUNNER_TEMP/pr-context.json"
          } >> "$RUNNER_TEMP/senpai-fix.prompt.md"

      - name: Run Codex fix
        if: env.SENPAI_FIX_ENABLED == 'true'
        continue-on-error: true
        uses: openai/codex-action@v1
        with:
          openai-api-key: ${{ secrets.MERGE_SENPAI_OPENAI_KEY }}
          model: gpt-5.4-mini
          prompt-file: ${{ runner.temp }}/senpai-fix.prompt.md
          sandbox: workspace-write
          codex-args: '["--ephemeral"]'

      - name: Commit and dispatch re-review
        if: env.SENPAI_FIX_ENABLED == 'true'
        env:
          GH_TOKEN: ${{ github.token }}
          GITHUB_TOKEN: ${{ github.token }}
        run: |
          set -euo pipefail
          git add -N .
          if git diff --quiet; then
            gh pr comment "$PR_NUMBER" --body "Merge Senpai tried, but found no safe file changes to commit." || true
            exit 0
          fi

          git config user.name "Merge Senpai"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git remote set-url origin "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
          git add -A
          git commit -m "Merge Senpai fix for PR #$PR_NUMBER"
          git push origin "HEAD:$HEAD_REF"

          gh pr comment "$PR_NUMBER" --body "Merge Senpai pushed a fix commit and requested a fresh review. Hmph." || true
          gh workflow run merge-senpai.yml -f pr_number="$PR_NUMBER" -f reason="post-fix" || true
YAML

avatar_target=".github/merge-senpai/avatar.png"
if [ -f "assets/merge-senpai.png" ]; then
  cp "assets/merge-senpai.png" "$avatar_target"
elif command -v curl >/dev/null 2>&1; then
  if ! curl -fsSL "$RAW_BASE/assets/merge-senpai.png" -o "$avatar_target"; then
    echo "Warning: could not download avatar from $RAW_BASE/assets/merge-senpai.png" >&2
    rm -f "$avatar_target"
  fi
else
  echo "Warning: curl not found; avatar was not installed." >&2
fi

if command -v gh >/dev/null 2>&1 && [ -n "${MERGE_SENPAI_OPENAI_KEY:-}" ]; then
  printf '%s' "$MERGE_SENPAI_OPENAI_KEY" | gh secret set MERGE_SENPAI_OPENAI_KEY >/dev/null
  echo "Stored MERGE_SENPAI_OPENAI_KEY with gh secret set."
fi

if [ "$CREATE_MEDIA_BRANCH" = "1" ]; then
  if ! command -v git >/dev/null 2>&1; then
    echo "git is required to create the media branch." >&2
    exit 1
  fi
  tmp="$(mktemp -d)"
  cleanup() {
    git worktree remove "$tmp" --force >/dev/null 2>&1 || true
  }
  trap cleanup EXIT
  git worktree add --detach "$tmp" HEAD >/dev/null
  (
    cd "$tmp"
    if git ls-remote --exit-code --heads origin senpai-media >/dev/null 2>&1; then
      git fetch origin senpai-media >/dev/null
      git checkout senpai-media
    else
      git switch --orphan senpai-media
      git rm -rf . >/dev/null 2>&1 || true
    fi
    cp "$git_root/.github/merge-senpai/player.html" index.html
    cp "$git_root/.github/merge-senpai/avatar.png" avatar.png 2>/dev/null || true
    cat > README.md <<'EOF'
# Merge Senpai Media

Storage branch for Merge Senpai public demo artifacts.
EOF
    git add .
    git commit -m "Create Merge Senpai media branch" >/dev/null 2>&1 || true
    git push -u origin senpai-media
  )
fi

cat <<EOF
Merge Senpai installed.

Generated:
  .github/workflows/merge-senpai.yml
  .github/senpai.yml
  .github/merge-senpai/avatar.png
  .github/merge-senpai/player.html

Next:
  1. Review the generated diff.
  2. Set the BYOK secret if you have not already:
       gh secret set MERGE_SENPAI_OPENAI_KEY
  3. Commit the files.

EOF
