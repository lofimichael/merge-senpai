import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { probeLocalModels } from "./probe-local-models.mjs";

const runnerTemp = process.env.RUNNER_TEMP || process.cwd();
const reviewPath = process.env.SENPAI_REVIEW_JSON || path.join(runnerTemp, "senpai-review.json");
const videoOutputPath = process.env.SENPAI_VIDEO_OUTPUT || path.join(runnerTemp, "senpai-briefing.mp4");
const imageOutputBase = process.env.SENPAI_IMAGE_OUTPUT_BASE || path.join(runnerTemp, "senpai-briefing-image");
const metadataPath = process.env.SENPAI_MEDIA_METADATA || path.join(runnerTemp, "senpai-media.json");
const ltxRequestPath = process.env.SENPAI_LTX_REQUEST_JSON || path.join(runnerTemp, "senpai-ltx-request.json");

function setOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${String(value).replace(/\n/g, " ")}\n`);
}

function escapeWorkflowCommandValue(value) {
  return String(value)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

function warning(message) {
  console.log(`::warning::${escapeWorkflowCommandValue(message)}`);
}

function getEnv(name, fallback = "") {
  return String(process.env[name] || fallback).trim();
}

function envFlag(name, fallback = false) {
  const value = getEnv(name);
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function normalizeProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  if (!provider || provider === "off" || provider === "none" || provider === "false") return "off";
  if (provider === "ltx") return "ltx-local";
  return provider;
}

function workflowValue(value) {
  return String(value || "").replace(/\n/g, " ").slice(0, 1000);
}

function writeMetadata(metadata) {
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
}

function fileExistsWithBytes(filePath) {
  try {
    return fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

function findImageOutput() {
  const dir = path.dirname(imageOutputBase);
  const base = path.basename(imageOutputBase);
  try {
    return fs.readdirSync(dir)
      .map((name) => path.join(dir, name))
      .find((candidate) => path.basename(candidate).startsWith(base) && fileExistsWithBytes(candidate)) || "";
  } catch {
    return "";
  }
}

function sanitizePrompt(value) {
  return String(value || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[A-Za-z0-9_./+=-]{48,}/g, "[redacted]")
    .replace(/\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PRIVATE)[A-Z0-9_]*\b/gi, "credential")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1500);
}

function buildMediaPlan(review) {
  if (review?.media_plan && typeof review.media_plan === "object" && !Array.isArray(review.media_plan)) {
    return review.media_plan;
  }

  const summary = sanitizePrompt(review?.summary || "");
  const briefing = sanitizePrompt(review?.briefing_script || summary);
  const findings = Array.isArray(review?.findings) ? review.findings.length : 0;
  return {
    title: "Pull request review briefing",
    safe_summary: summary,
    story_beats: [{
      duration_seconds: Number(getEnv("SENPAI_MEDIA_DURATION", "5")) || 5,
      visual: "A fictional CI review host presents abstract pull request status panels.",
      motion: "Slow cinematic push with subtle parallax and clean interface-card movement.",
      audio: briefing,
    }],
    negative_prompt: "readable source code, secrets, URLs, real person likenesses, brand logos, private identifiers",
    captions: [
      `Verdict: ${sanitizePrompt(review?.verdict || "review")}`,
      `Grade: ${sanitizePrompt(review?.grade || "?")}`,
      `Findings: ${findings}`,
    ],
  };
}

function commandExists(command) {
  if (!command) return false;
  if (command.includes("/") && fs.existsSync(command)) return true;
  const pathDirs = String(process.env.PATH || "").split(path.delimiter);
  return pathDirs.some((dir) => fs.existsSync(path.join(dir, command)));
}

function runCommand(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with status ${code}`));
    });
  });
}

function parseArgsJson(value) {
  if (!value) return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("SENPAI_LTX_ARGS_JSON must be a JSON string array.");
  }
  return parsed;
}

function skip(provider, reason, extra = {}) {
  const metadata = {
    generated: false,
    provider,
    skip_reason: reason,
    ...extra,
  };
  writeMetadata(metadata);
  setOutput("generated", "false");
  setOutput("provider", provider);
  setOutput("skip_reason", reason);
  warning(`${provider} media skipped: ${reason}`);
}

async function runHiggsfield() {
  if (getEnv("REPOSITORY_PRIVATE") === "true" && !envFlag("SENPAI_HIGGSFIELD_PRIVATE", false)) {
    skip("higgsfield", "private repository requires SENPAI_HIGGSFIELD_PRIVATE=true");
    return;
  }

  const helperPath = getEnv("SENPAI_HIGGSFIELD_HELPER", ".github/merge-senpai/generate-higgsfield-video.mjs");
  if (!fs.existsSync(helperPath)) {
    skip("higgsfield", `helper not found at ${helperPath}`);
    return;
  }

  await runCommand(process.execPath, [helperPath], {});

  const generated = fileExistsWithBytes(videoOutputPath);
  const imagePath = findImageOutput();
  writeMetadata({
    generated,
    provider: "higgsfield",
    image_path: imagePath,
    video_path: generated ? videoOutputPath : "",
    metadata_path: getEnv("SENPAI_VIDEO_METADATA", path.join(runnerTemp, "senpai-video.json")),
  });
  setOutput("generated", generated ? "true" : "false");
  setOutput("provider", "higgsfield");
  if (imagePath) setOutput("image_path", imagePath);
  if (generated) setOutput("video_path", videoOutputPath);
}

async function runLtxLocal(review) {
  const provider = "ltx-local";
  const safetyVerdict = getEnv("SENPAI_SELF_HOSTED_SAFETY_VERDICT", "denied");
  if (safetyVerdict !== "allowed") {
    skip(provider, `self-hosted safety verdict is ${safetyVerdict || "missing"}`);
    return;
  }

  const modelDir = getEnv("SENPAI_LTX_MODEL_DIR", "/opt/models/ltx-2.3");
  const command = getEnv("SENPAI_LTX_COMMAND");
  const args = parseArgsJson(getEnv("SENPAI_LTX_ARGS_JSON", "[]"));

  const probe = await probeLocalModels({
    provider,
    safetyVerdict,
    modelDir,
    configureEnv: true,
  });
  if (!probe.ready) {
    skip(provider, probe.reason || "local model probe was not ready", {
      probe,
    });
    return;
  }
  if (!command) {
    skip(provider, "SENPAI_LTX_COMMAND is not configured");
    return;
  }
  if (!commandExists(command)) {
    skip(provider, `configured command is not executable or on PATH: ${command}`);
    return;
  }

  const mediaPlan = buildMediaPlan(review);
  const request = {
    provider,
    model_dir: modelDir,
    output_path: videoOutputPath,
    image_output_base: imageOutputBase,
    seconds: Number(getEnv("SENPAI_LTX_SECONDS", getEnv("SENPAI_MEDIA_DURATION", "5"))) || 5,
    fps: Number(getEnv("SENPAI_LTX_FPS", "25")) || 25,
    width: Number(getEnv("SENPAI_LTX_WIDTH", "720")) || 720,
    height: Number(getEnv("SENPAI_LTX_HEIGHT", "1280")) || 1280,
    seed: getEnv("SENPAI_LTX_SEED", `${process.env.PR_NUMBER || "0"}-${process.env.HEAD_SHA || "head"}`),
    prompt: sanitizePrompt(review?.video_prompt || mediaPlan.safe_summary || review?.summary),
    media_plan: mediaPlan,
    negative_prompt: sanitizePrompt(mediaPlan.negative_prompt),
  };
  fs.writeFileSync(ltxRequestPath, `${JSON.stringify(request, null, 2)}\n`);

  if (getEnv("SENPAI_LTX_DRY_RUN") === "true") {
    writeMetadata({
      generated: false,
      provider,
      dry_run: true,
      request_path: ltxRequestPath,
      skip_reason: "dry_run",
    });
    setOutput("generated", "false");
    setOutput("provider", provider);
    setOutput("skip_reason", "dry_run");
    return;
  }

  await runCommand(command, args, {
    ...(probe.env || {}),
    SENPAI_LTX_REQUEST_JSON: ltxRequestPath,
    SENPAI_VIDEO_OUTPUT: videoOutputPath,
    SENPAI_IMAGE_OUTPUT_BASE: imageOutputBase,
    SENPAI_LTX_MODEL_DIR: modelDir,
  });

  if (!fileExistsWithBytes(videoOutputPath)) {
    throw new Error(`LTX command completed but did not write ${videoOutputPath}`);
  }

  const imagePath = findImageOutput();
  writeMetadata({
    generated: true,
    provider,
    request_path: ltxRequestPath,
    image_path: imagePath,
    video_path: videoOutputPath,
  });
  setOutput("generated", "true");
  setOutput("provider", provider);
  if (imagePath) setOutput("image_path", imagePath);
  setOutput("video_path", videoOutputPath);
}

async function main() {
  setOutput("generated", "false");

  const provider = normalizeProvider(getEnv("SENPAI_MEDIA_PROVIDER", envFlag("SENPAI_HIGGSFIELD_VIDEO", false) ? "higgsfield" : "off"));
  setOutput("provider", provider);

  if (provider === "off" || provider === "static") {
    skip(provider, provider === "off" ? "media provider is off" : "static provider has no generated video");
    return;
  }
  if (!fs.existsSync(reviewPath)) {
    skip(provider, `review JSON not found at ${reviewPath}`);
    return;
  }

  const review = JSON.parse(fs.readFileSync(reviewPath, "utf8"));
  if (provider === "higgsfield") {
    await runHiggsfield();
  } else if (provider === "ltx-local") {
    await runLtxLocal(review);
  } else {
    skip(provider, `unsupported media provider: ${provider}`);
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((error) => {
    warning(error?.message || "Media generation failed.");
    setOutput("generated", "false");
    process.exitCode = 1;
  });
}

export {
  buildMediaPlan,
  commandExists,
  normalizeProvider,
  parseArgsJson,
};
