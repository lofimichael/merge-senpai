import fs from "node:fs";
import { fileURLToPath } from "node:url";

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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function endpointJoin(base, suffix) {
  const cleanBase = String(base || "").replace(/\/+$/, "");
  if (!cleanBase) return suffix;
  if (cleanBase.endsWith(suffix)) return cleanBase;
  return `${cleanBase}${suffix}`;
}

function extractFirstJsonObject(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Local review provider returned empty content.");

  try {
    return JSON.parse(raw);
  } catch {}

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Local review provider did not return JSON.");
  return JSON.parse(match[0]);
}

function validateAndNormalizeReview(review) {
  if (!review || typeof review !== "object" || Array.isArray(review)) {
    throw new Error("Review output must be a JSON object.");
  }

  const verdict = String(review.verdict || "comment");
  if (!["clean", "comment", "request_changes"].includes(verdict)) {
    throw new Error(`Review verdict is invalid: ${verdict}`);
  }

  if (!Array.isArray(review.findings)) {
    throw new Error("Review output must include findings array.");
  }

  const normalizedFindings = review.findings.map((finding, index) => {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      throw new Error(`Finding ${index + 1} must be an object.`);
    }
    const severity = String(finding.severity || "P3");
    if (!["P0", "P1", "P2", "P3"].includes(severity)) {
      throw new Error(`Finding ${index + 1} has invalid severity: ${severity}`);
    }
    return {
      severity,
      title: String(finding.title || "Untitled finding").slice(0, 180),
      file: String(finding.file || "").slice(0, 500),
      line: Number.isFinite(Number(finding.line)) ? Number(finding.line) : 1,
      message: String(finding.message || "").slice(0, 4000),
      suggestion: String(finding.suggestion || "").slice(0, 8000),
    };
  });

  const summary = String(review.summary || "Local review completed.").slice(0, 4000);
  const personaLine = String(review.persona_line || "I reviewed the diff with the local model you configured.").slice(0, 1000);
  const briefingScript = String(review.briefing_script || summary).slice(0, 4000);
  const imagePrompt = String(review.image_prompt || summary).slice(0, 2000);
  const videoPrompt = String(review.video_prompt || briefingScript).slice(0, 2000);

  return {
    verdict,
    grade: String(review.grade || "?").slice(0, 40),
    summary,
    persona_line: personaLine,
    briefing_script: briefingScript,
    image_prompt: imagePrompt,
    video_prompt: videoPrompt,
    media_plan: review.media_plan && typeof review.media_plan === "object" ? review.media_plan : {
      title: "Pull request review briefing",
      safe_summary: summary,
      story_beats: [{
        duration_seconds: 5,
        visual: "Abstract CI review cards and pull request status panels.",
        motion: "Slow camera push with subtle interface motion.",
        audio: briefingScript,
      }],
      negative_prompt: "readable source code, secrets, URLs, brand logos, real people",
      captions: [
        `Verdict: ${verdict}`,
        `Findings: ${normalizedFindings.length}`,
      ],
    },
    findings: normalizedFindings,
  };
}

function buildOpenAICompatibleBody({ model, prompt, schema, provider }) {
  const schemaInstruction = [
    "Return only JSON that matches the Merge Senpai review schema.",
    "Do not include markdown fences or explanatory prose.",
  ].join(" ");

  const body = {
    model,
    messages: [
      { role: "system", content: schemaInstruction },
      { role: "user", content: prompt },
    ],
    temperature: 0,
  };

  if (provider === "local-vllm") {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: "merge_senpai_review",
        strict: true,
        schema,
      },
    };
  } else {
    body.response_format = { type: "json_object" };
    body.messages[0].content += ` Schema: ${JSON.stringify(schema)}`;
  }

  return body;
}

async function fetchJson(url, options) {
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
    throw new Error(`Local review request failed (${response.status}): ${JSON.stringify(data)}`);
  }

  return data || {};
}

async function runOpenAICompatibleReview({ provider, endpoint, model, prompt, schema, apiKey }) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const data = await fetchJson(endpointJoin(endpoint, "/v1/chat/completions"), {
    method: "POST",
    headers,
    body: JSON.stringify(buildOpenAICompatibleBody({ provider, model, prompt, schema })),
  });

  const content = data?.choices?.[0]?.message?.content;
  return extractFirstJsonObject(content);
}

async function runOllamaReview({ endpoint, model, prompt, schema }) {
  const data = await fetchJson(endpointJoin(endpoint, "/api/chat"), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: "Return only JSON matching the provided schema. Do not include markdown.",
        },
        { role: "user", content: prompt },
      ],
      stream: false,
      format: schema,
      options: { temperature: 0 },
    }),
  });

  return extractFirstJsonObject(data?.message?.content || data?.response || "");
}

async function main() {
  setOutput("generated", "false");

  const provider = getEnv("SENPAI_REVIEW_PROVIDER", "local-vllm");
  const endpoint = getEnv("SENPAI_LOCAL_REVIEW_ENDPOINT");
  const model = getEnv("SENPAI_LOCAL_REVIEW_MODEL", getEnv("SENPAI_MODEL", "local-review-model"));
  const promptPath = getEnv("SENPAI_PROMPT_FILE");
  const schemaPath = getEnv("SENPAI_SCHEMA_FILE");
  const outputPath = getEnv("SENPAI_REVIEW_OUTPUT");
  const apiKey = getEnv("SENPAI_LOCAL_REVIEW_API_KEY");

  if (!promptPath || !schemaPath || !outputPath) {
    throw new Error("SENPAI_PROMPT_FILE, SENPAI_SCHEMA_FILE, and SENPAI_REVIEW_OUTPUT are required.");
  }

  const prompt = fs.readFileSync(promptPath, "utf8");
  const schema = readJson(schemaPath);

  let review;
  if (getEnv("SENPAI_LOCAL_REVIEW_DRY_RUN") === "true") {
    review = {
      verdict: "comment",
      grade: "local-dry-run",
      summary: "Local review dry run completed without calling a model endpoint.",
      persona_line: "The local review path is wired, but this run was intentionally dry.",
      briefing_script: "Merge Senpai validated the local structured review path in dry-run mode.",
      image_prompt: "Abstract local model review console with validated JSON output, no readable code.",
      video_prompt: "Animate a local review console producing validated JSON for a pull request.",
      findings: [],
    };
  } else {
    if (!endpoint) throw new Error(`SENPAI_LOCAL_REVIEW_ENDPOINT is required for ${provider}.`);
    if (provider === "local-ollama") {
      review = await runOllamaReview({ endpoint, model, prompt, schema });
    } else if (["local-vllm", "local-llama-cpp"].includes(provider)) {
      review = await runOpenAICompatibleReview({ provider, endpoint, model, prompt, schema, apiKey });
    } else {
      throw new Error(`Unsupported local review provider: ${provider}`);
    }
  }

  const normalized = validateAndNormalizeReview(review);
  fs.writeFileSync(outputPath, `${JSON.stringify(normalized, null, 2)}\n`);
  setOutput("generated", "true");
  console.log(`Local review provider ${provider} wrote ${outputPath}.`);
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
    warning(error?.message || "Local review failed.");
    process.exitCode = 1;
  });
}

export {
  buildOpenAICompatibleBody,
  endpointJoin,
  extractFirstJsonObject,
  validateAndNormalizeReview,
};
