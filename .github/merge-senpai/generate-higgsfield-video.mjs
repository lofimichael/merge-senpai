import fs from "node:fs";
import path from "node:path";

const runnerTemp = process.env.RUNNER_TEMP || process.cwd();
const reviewPath = process.env.SENPAI_REVIEW_JSON || path.join(runnerTemp, "senpai-review.json");
const videoOutputPath = process.env.SENPAI_VIDEO_OUTPUT || path.join(runnerTemp, "senpai-briefing.mp4");
const imageOutputBase = process.env.SENPAI_IMAGE_OUTPUT_BASE || path.join(runnerTemp, "senpai-briefing-image");
const metadataPath = process.env.SENPAI_VIDEO_METADATA || path.join(runnerTemp, "senpai-video.json");
const requestPath = process.env.SENPAI_VIDEO_REQUEST || path.join(runnerTemp, "senpai-video-request.json");
const baseUrl = (process.env.HIGGS_BASE_URL || "https://platform.higgsfield.ai").replace(/\/$/, "");

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

function sanitizePrompt(value) {
  return String(value || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[A-Za-z0-9_./+=-]{48,}/g, "[redacted]")
    .replace(/\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PRIVATE)[A-Z0-9_]*\b/gi, "credential")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1100);
}

function buildImagePrompt(review) {
  const source = sanitizePrompt(review.image_prompt || review.video_prompt || review.summary);
  const verdict = sanitizePrompt(review.verdict || "review");
  const grade = sanitizePrompt(review.grade || "?");
  const findings = Array.isArray(review.findings) ? review.findings.length : 0;

  return [
    "Vertical social video keyframe for a fictional tech influencer explaining a pull request review.",
    "Anime-inspired Merge Senpai energy, expressive presenter pose, floating CI panels, pull request timeline, bold shapes, readable mood but no actual readable text.",
    "No source code, secrets, URLs, real person likenesses, brand logos, or private identifiers.",
    `Review context: verdict ${verdict}, grade ${grade}, findings ${findings}.`,
    `Visual concept: ${source || "A tiny validation pull request gets reviewed, passes cleanly, and publishes a durable CI artifact."}`,
  ].join(" ");
}

function buildVideoPrompt(review) {
  const source = sanitizePrompt(review.video_prompt || review.briefing_script || review.summary);
  const verdict = sanitizePrompt(review.verdict || "review");
  const grade = sanitizePrompt(review.grade || "?");
  const findings = Array.isArray(review.findings) ? review.findings.length : 0;

  return [
    "Animate this PR recap keyframe into a short social clip.",
    "Use quick influencer-style camera push, subtle parallax, animated CI checkmarks, kinetic interface cards, and energetic presentation motion.",
    "Keep text abstract and non-readable. Do not reveal source code, secrets, URLs, real person likenesses, brand logos, or private identifiers.",
    `Verdict: ${verdict}. Grade: ${grade}. Findings: ${findings}.`,
    `Scene direction: ${source || "The reviewer celebrates a clean validation PR and points to a durable media branch artifact."}`,
  ].join(" ");
}

function endpointFor(endpoint) {
  const clean = String(endpoint || "").replace(/^\/+/, "");
  return `${baseUrl}/${clean}`;
}

async function apiFetch(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 500) };
    }
  }

  if (!response.ok) {
    const detail = data?.detail || data?.message || data?.raw || response.statusText;
    throw new Error(`Higgsfield request failed (${response.status}): ${detail}`);
  }

  return data || {};
}

function findImageUrl(data) {
  return (
    data?.images?.[0]?.url ||
    data?.image?.url ||
    data?.output?.image_url ||
    data?.output?.url ||
    data?.result?.image?.url ||
    data?.result?.url ||
    ""
  );
}

function findVideoUrl(data) {
  return (
    data?.video?.url ||
    data?.videos?.[0]?.url ||
    data?.output?.video_url ||
    data?.output?.url ||
    data?.result?.video?.url ||
    data?.result?.url ||
    ""
  );
}

async function pollStatus(initial, authHeader, maxPollMs, pollIntervalMs) {
  let latest = initial;
  const requestId = initial.request_id || initial.id;
  const statusUrl = initial.status_url || (requestId ? `${baseUrl}/requests/${requestId}/status` : "");
  if (!statusUrl) return latest;

  const started = Date.now();
  while (Date.now() - started < maxPollMs) {
    const status = String(latest.status || "").toLowerCase();
    if (["completed", "failed", "nsfw", "canceled", "cancelled"].includes(status)) return latest;

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    latest = await apiFetch(statusUrl, {
      headers: {
        Accept: "application/json",
        Authorization: authHeader,
      },
    });
  }

  throw new Error(`Higgsfield generation timed out after ${Math.round(maxPollMs / 1000)}s`);
}

function assertCompleted(data, label) {
  const status = String(data.status || "").toLowerCase();
  if (["failed", "nsfw", "canceled", "cancelled"].includes(status)) {
    throw new Error(`Higgsfield ${label} ended with status ${status}`);
  }
  return status || "completed";
}

function extensionFor(contentType, fallback) {
  const normalized = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (normalized === "image/jpeg") return "jpg";
  if (normalized === "image/png") return "png";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/gif") return "gif";
  if (normalized === "video/mp4") return "mp4";
  return fallback;
}

async function downloadFile(url, targetPath, fallbackExtension) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not download Higgsfield media (${response.status})`);
  }

  const contentType = response.headers.get("content-type") || "";
  const extension = extensionFor(contentType, fallbackExtension);
  const finalPath = targetPath.endsWith(`.${extension}`) ? targetPath : `${targetPath}.${extension}`;
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(finalPath, bytes);
  return { bytes: bytes.length, path: finalPath, contentType };
}

async function main() {
  setOutput("generated", "false");

  const keyId = getEnv("HIGGS_KEY_ID");
  const apiSecret = getEnv("HIGGS_API_SECRET");
  const imageEndpoint = getEnv("SENPAI_HIGGSFIELD_IMAGE_ENDPOINT", "higgsfield-ai/soul/standard");
  const videoEndpoint = getEnv("SENPAI_HIGGSFIELD_VIDEO_ENDPOINT", "higgsfield-ai/dop/standard");
  if (!keyId || !apiSecret) {
    warning("Higgsfield video skipped because HIGGS_KEY_ID or HIGGS_API_SECRET is missing.");
    return;
  }
  if (!imageEndpoint || !videoEndpoint) {
    warning("Higgsfield video skipped because image/video endpoints are not configured.");
    return;
  }
  if (!fs.existsSync(reviewPath)) {
    warning(`Higgsfield video skipped because ${reviewPath} does not exist.`);
    return;
  }

  const review = JSON.parse(fs.readFileSync(reviewPath, "utf8"));
  const imageRequest = {
    prompt: buildImagePrompt(review),
    aspect_ratio: getEnv("SENPAI_HIGGSFIELD_ASPECT_RATIO", "9:16"),
    resolution: getEnv("SENPAI_HIGGSFIELD_IMAGE_RESOLUTION", "720p"),
  };
  const videoRequest = {
    image_url: "",
    prompt: buildVideoPrompt(review),
    duration: Number(getEnv("SENPAI_HIGGSFIELD_DURATION", "5")),
  };

  fs.writeFileSync(requestPath, `${JSON.stringify({
    image_endpoint: imageEndpoint,
    video_endpoint: videoEndpoint,
    image_request: imageRequest,
    video_request: { ...videoRequest, image_url: "[filled after image generation]" },
  }, null, 2)}\n`);

  if (getEnv("SENPAI_HIGGSFIELD_DRY_RUN") === "true") {
    fs.writeFileSync(metadataPath, `${JSON.stringify({
      dry_run: true,
      image_endpoint: imageEndpoint,
      video_endpoint: videoEndpoint,
      image_request: imageRequest,
      video_request: { ...videoRequest, image_url: "[filled after image generation]" },
    }, null, 2)}\n`);
    return;
  }

  const authHeader = `Key ${keyId}:${apiSecret}`;
  const maxPollMs = Number(getEnv("SENPAI_HIGGSFIELD_MAX_POLL_MS", "360000"));
  const pollIntervalMs = Number(getEnv("SENPAI_HIGGSFIELD_POLL_INTERVAL_MS", "5000"));

  const imageSubmitted = await apiFetch(endpointFor(imageEndpoint), {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(imageRequest),
  });
  const imageCompleted = await pollStatus(imageSubmitted, authHeader, maxPollMs, pollIntervalMs);
  assertCompleted(imageCompleted, "text-to-image");
  const imageUrl = findImageUrl(imageCompleted) || findImageUrl(imageSubmitted);
  if (!imageUrl) {
    throw new Error("Higgsfield text-to-image completed without an image URL.");
  }

  const imageDownload = await downloadFile(imageUrl, imageOutputBase, "png");
  videoRequest.image_url = imageUrl;

  const videoSubmitted = await apiFetch(endpointFor(videoEndpoint), {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(videoRequest),
  });
  const videoCompleted = await pollStatus(videoSubmitted, authHeader, maxPollMs, pollIntervalMs);
  const videoStatus = assertCompleted(videoCompleted, "image-to-video");
  const videoUrl = findVideoUrl(videoCompleted) || findVideoUrl(videoSubmitted);
  if (!videoUrl) {
    throw new Error("Higgsfield image-to-video completed without a video URL.");
  }

  const videoDownload = await downloadFile(videoUrl, videoOutputPath.replace(/\.mp4$/, ""), "mp4");
  fs.writeFileSync(metadataPath, `${JSON.stringify({
    image_endpoint: imageEndpoint,
    video_endpoint: videoEndpoint,
    image_request_id: imageCompleted.request_id || imageSubmitted.request_id || "",
    video_request_id: videoCompleted.request_id || videoSubmitted.request_id || "",
    status: videoStatus,
    source_image_url: imageUrl,
    source_video_url: videoUrl,
    image_output_path: imageDownload.path,
    video_output_path: videoDownload.path,
    image_bytes: imageDownload.bytes,
    video_bytes: videoDownload.bytes,
  }, null, 2)}\n`);
  setOutput("generated", "true");
  setOutput("image_path", imageDownload.path);
  setOutput("video_path", videoDownload.path);
  console.log(`Higgsfield image saved to ${imageDownload.path} (${imageDownload.bytes} bytes).`);
  console.log(`Higgsfield video saved to ${videoDownload.path} (${videoDownload.bytes} bytes).`);
}

main().catch((error) => {
  warning(error?.message || "Higgsfield video generation failed.");
  setOutput("generated", "false");
});
