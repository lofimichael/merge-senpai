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

function envFlag(name, fallback = false) {
  const value = getEnv(name);
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function numberEnv(name, fallback) {
  const value = Number(getEnv(name, String(fallback)));
  return Number.isFinite(value) ? value : fallback;
}

function endpointKey(endpoint) {
  return String(endpoint || "").replace(/^\/+/, "").replace(/\/+$/, "");
}

function isSoulV1Endpoint(endpoint) {
  return endpointKey(endpoint) === "v1/text2image/soul";
}

function isDopV1Endpoint(endpoint) {
  return endpointKey(endpoint) === "v1/image2video/dop";
}

function imageSizeForAspectRatio(aspectRatio) {
  const normalized = String(aspectRatio || "").replace(/\s/g, "");
  if (normalized === "16:9") return "2048x1152";
  if (normalized === "1:1") return "1536x1536";
  return "1152x2048";
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
    "Premium vertical social video keyframe for a fictional tech creator explaining a pull request review.",
    "Cinematic editorial still, realistic studio lighting, high-detail face and fabric texture, clean lens rendering, confident presenter pose, abstract CI panels, pull request timeline shapes, no readable text.",
    "Make it feel expensive and intentional, not low-resolution, plastic, blurry, or generic AI stock art.",
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
    "Use a smooth cinematic camera push, subtle parallax, stable hands and face, animated CI checkmarks, kinetic interface cards, and energetic presentation motion.",
    "Prioritize temporal stability, sharp subject detail, clean lighting, and minimal warping or flicker.",
    "Keep text abstract and non-readable. Do not reveal source code, secrets, URLs, real person likenesses, brand logos, or private identifiers.",
    `Verdict: ${verdict}. Grade: ${grade}. Findings: ${findings}.`,
    `Scene direction: ${source || "The reviewer celebrates a clean validation PR and points to a durable media branch artifact."}`,
  ].join(" ");
}

function endpointFor(endpoint) {
  const clean = String(endpoint || "").replace(/^\/+/, "");
  return `${baseUrl}/${clean}`;
}

function sameEndpoint(a, b) {
  return endpointKey(a) === endpointKey(b);
}

function errorDetail(data, fallback) {
  const detail = data?.detail || data?.message || data?.raw || fallback;
  if (typeof detail === "string") return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

function buildImageRequest(review, endpoint) {
  const aspectRatio = getEnv("SENPAI_HIGGSFIELD_ASPECT_RATIO", "9:16");
  const resolution = getEnv("SENPAI_HIGGSFIELD_IMAGE_RESOLUTION", "1080p");
  const prompt = buildImagePrompt(review);

  if (isSoulV1Endpoint(endpoint)) {
    const request = {
      prompt,
      width_and_height: getEnv("SENPAI_HIGGSFIELD_IMAGE_SIZE", imageSizeForAspectRatio(aspectRatio)),
      quality: getEnv("SENPAI_HIGGSFIELD_IMAGE_QUALITY", resolution),
      batch_size: numberEnv("SENPAI_HIGGSFIELD_IMAGE_BATCH_SIZE", 1),
      enhance_prompt: envFlag("SENPAI_HIGGSFIELD_ENHANCE_PROMPT", true),
    };
    const seed = getEnv("SENPAI_HIGGSFIELD_SEED");
    if (seed) request.seed = Number(seed);
    return request;
  }

  return {
    prompt,
    aspect_ratio: aspectRatio,
    resolution,
  };
}

function buildVideoRequest(review, endpoint) {
  const prompt = buildVideoPrompt(review);

  if (isDopV1Endpoint(endpoint)) {
    const request = {
      model: getEnv("SENPAI_HIGGSFIELD_VIDEO_MODEL", "dop-standard"),
      prompt,
      input_images: [],
      enhance_prompt: envFlag("SENPAI_HIGGSFIELD_ENHANCE_PROMPT", true),
    };
    const seed = getEnv("SENPAI_HIGGSFIELD_SEED");
    if (seed) request.seed = Number(seed);
    return request;
  }

  return {
    image_url: "",
    prompt,
    duration: numberEnv("SENPAI_HIGGSFIELD_DURATION", 5),
  };
}

function attachImageToVideoRequest(videoRequest, endpoint, imageUrl) {
  if (isDopV1Endpoint(endpoint)) {
    videoRequest.input_images = [{
      type: "image_url",
      image_url: imageUrl,
    }];
    return;
  }

  videoRequest.image_url = imageUrl;
}

function redactedVideoRequest(videoRequest, endpoint) {
  if (isDopV1Endpoint(endpoint)) {
    return {
      ...videoRequest,
      input_images: "[filled after image generation]",
    };
  }

  return {
    ...videoRequest,
    image_url: "[filled after image generation]",
  };
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
    throw new Error(`Higgsfield request failed (${response.status}): ${errorDetail(data, response.statusText)}`);
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

async function generateImage({ endpoint, request, authHeader, maxPollMs, pollIntervalMs }) {
  const submitted = await apiFetch(endpointFor(endpoint), {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });
  const completed = await pollStatus(submitted, authHeader, maxPollMs, pollIntervalMs);
  assertCompleted(completed, "text-to-image");
  const url = findImageUrl(completed) || findImageUrl(submitted);
  if (!url) {
    throw new Error("Higgsfield text-to-image completed without an image URL.");
  }
  return { submitted, completed, url };
}

async function generateVideo({ endpoint, request, authHeader, maxPollMs, pollIntervalMs }) {
  const submitted = await apiFetch(endpointFor(endpoint), {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(request),
  });
  const completed = await pollStatus(submitted, authHeader, maxPollMs, pollIntervalMs);
  const status = assertCompleted(completed, "image-to-video");
  const url = findVideoUrl(completed) || findVideoUrl(submitted);
  if (!url) {
    throw new Error("Higgsfield image-to-video completed without a video URL.");
  }
  return { submitted, completed, status, url };
}

async function main() {
  setOutput("generated", "false");

  const keyId = getEnv("HIGGS_KEY_ID");
  const apiSecret = getEnv("HIGGS_API_SECRET");
  const imageEndpoint = getEnv("SENPAI_HIGGSFIELD_IMAGE_ENDPOINT", "higgsfield-ai/soul/standard");
  const videoEndpoint = getEnv("SENPAI_HIGGSFIELD_VIDEO_ENDPOINT", "higgsfield-ai/dop/standard");
  const fallbackImageEndpoint = getEnv("SENPAI_HIGGSFIELD_FALLBACK_IMAGE_ENDPOINT", "/v1/text2image/soul");
  const fallbackVideoEndpoint = getEnv("SENPAI_HIGGSFIELD_FALLBACK_VIDEO_ENDPOINT", "/v1/image2video/dop");
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
  const imageRequest = buildImageRequest(review, imageEndpoint);
  const videoRequest = buildVideoRequest(review, videoEndpoint);

  fs.writeFileSync(requestPath, `${JSON.stringify({
    image_endpoint: imageEndpoint,
    video_endpoint: videoEndpoint,
    fallback_image_endpoint: fallbackImageEndpoint,
    fallback_video_endpoint: fallbackVideoEndpoint,
    image_request: imageRequest,
    video_request: redactedVideoRequest(videoRequest, videoEndpoint),
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

  let activeImageEndpoint = imageEndpoint;
  let activeImageRequest = imageRequest;
  let imageResult;
  try {
    imageResult = await generateImage({
      endpoint: activeImageEndpoint,
      request: activeImageRequest,
      authHeader,
      maxPollMs,
      pollIntervalMs,
    });
  } catch (error) {
    if (!fallbackImageEndpoint || sameEndpoint(fallbackImageEndpoint, activeImageEndpoint)) throw error;
    warning(`Primary Higgsfield image endpoint failed; trying fallback ${fallbackImageEndpoint}: ${error?.message || error}`);
    activeImageEndpoint = fallbackImageEndpoint;
    activeImageRequest = buildImageRequest(review, activeImageEndpoint);
    imageResult = await generateImage({
      endpoint: activeImageEndpoint,
      request: activeImageRequest,
      authHeader,
      maxPollMs,
      pollIntervalMs,
    });
  }

  const imageDownload = await downloadFile(imageResult.url, imageOutputBase, "png");
  let activeVideoEndpoint = videoEndpoint;
  let activeVideoRequest = videoRequest;
  attachImageToVideoRequest(activeVideoRequest, activeVideoEndpoint, imageResult.url);

  let videoResult;
  try {
    videoResult = await generateVideo({
      endpoint: activeVideoEndpoint,
      request: activeVideoRequest,
      authHeader,
      maxPollMs,
      pollIntervalMs,
    });
  } catch (error) {
    if (!fallbackVideoEndpoint || sameEndpoint(fallbackVideoEndpoint, activeVideoEndpoint)) throw error;
    warning(`Primary Higgsfield video endpoint failed; trying fallback ${fallbackVideoEndpoint}: ${error?.message || error}`);
    activeVideoEndpoint = fallbackVideoEndpoint;
    activeVideoRequest = buildVideoRequest(review, activeVideoEndpoint);
    attachImageToVideoRequest(activeVideoRequest, activeVideoEndpoint, imageResult.url);
    videoResult = await generateVideo({
      endpoint: activeVideoEndpoint,
      request: activeVideoRequest,
      authHeader,
      maxPollMs,
      pollIntervalMs,
    });
  }

  const videoDownload = await downloadFile(videoResult.url, videoOutputPath.replace(/\.mp4$/, ""), "mp4");
  fs.writeFileSync(metadataPath, `${JSON.stringify({
    image_endpoint: activeImageEndpoint,
    video_endpoint: activeVideoEndpoint,
    image_request: activeImageRequest,
    video_request: redactedVideoRequest(activeVideoRequest, activeVideoEndpoint),
    image_request_id: imageResult.completed.request_id || imageResult.submitted.request_id || "",
    video_request_id: videoResult.completed.request_id || videoResult.submitted.request_id || "",
    status: videoResult.status,
    source_image_url: imageResult.url,
    source_video_url: videoResult.url,
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
