import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  buildOpenAICompatibleBody,
  endpointJoin,
  extractFirstJsonObject,
  validateAndNormalizeReview,
} from "../../templates/.github/merge-senpai/run-local-review.mjs";
import {
  buildMediaPlan,
  normalizeProvider,
  parseArgsJson,
} from "../../templates/.github/merge-senpai/generate-media.mjs";
import {
  cacheEnvironment,
  chooseCacheDir,
  parseStringList,
  probeLocalModels,
} from "../../templates/.github/merge-senpai/probe-local-models.mjs";

describe("local review adapter", () => {
  it("builds vLLM requests with JSON Schema response format", () => {
    const schema = { type: "object", properties: { verdict: { type: "string" } } };
    const body = buildOpenAICompatibleBody({
      provider: "local-vllm",
      model: "qwen3-coder",
      prompt: "Review this diff.",
      schema,
    });

    assert.equal(body.model, "qwen3-coder");
    assert.equal(body.temperature, 0);
    assert.deepEqual(body.response_format, {
      type: "json_schema",
      json_schema: {
        name: "merge_senpai_review",
        strict: true,
        schema,
      },
    });
  });

  it("normalizes and validates local review JSON", () => {
    const review = validateAndNormalizeReview({
      verdict: "clean",
      grade: "A",
      summary: "Looks safe.",
      persona_line: "Fine, it passes.",
      briefing_script: "This PR is clean.",
      image_prompt: "Abstract green checks.",
      video_prompt: "Animate green checks.",
      findings: [],
    });

    assert.equal(review.verdict, "clean");
    assert.equal(review.findings.length, 0);
    assert.equal(review.media_plan.captions[0], "Verdict: clean");
  });

  it("rejects invalid local review severities", () => {
    assert.throws(
      () => validateAndNormalizeReview({
        verdict: "comment",
        findings: [{ severity: "P9" }],
      }),
      /invalid severity/,
    );
  });

  it("extracts JSON from noisy model output", () => {
    assert.deepEqual(extractFirstJsonObject("Here:\n{\"verdict\":\"comment\"}\n"), {
      verdict: "comment",
    });
  });

  it("joins OpenAI-compatible endpoints predictably", () => {
    assert.equal(endpointJoin("http://127.0.0.1:8000", "/v1/chat/completions"), "http://127.0.0.1:8000/v1/chat/completions");
    assert.equal(endpointJoin("http://127.0.0.1:8000/v1/chat/completions", "/v1/chat/completions"), "http://127.0.0.1:8000/v1/chat/completions");
  });
});

describe("media provider adapter", () => {
  it("normalizes provider names and disabled values", () => {
    assert.equal(normalizeProvider("ltx"), "ltx-local");
    assert.equal(normalizeProvider("false"), "off");
    assert.equal(normalizeProvider("HIGGSFIELD"), "higgsfield");
  });

  it("parses LTX args as a string array only", () => {
    assert.deepEqual(parseArgsJson("[\"--config\",\"ci.json\"]"), ["--config", "ci.json"]);
    assert.throws(() => parseArgsJson("{\"bad\":true}"), /JSON string array/);
  });

  it("builds fallback media plan from review fields", () => {
    const plan = buildMediaPlan({
      verdict: "request_changes",
      grade: "C",
      summary: "One blocker remains.",
      briefing_script: "Fix the blocker before merge.",
      findings: [{ severity: "P1" }],
    });

    assert.equal(plan.captions[0], "Verdict: request_changes");
    assert.equal(plan.captions[2], "Findings: 1");
    assert.match(plan.negative_prompt, /readable source code/);
  });
});

describe("local model probe", () => {
  it("parses required model file lists", () => {
    assert.deepEqual(parseStringList("[\"a.safetensors\",\"b.json\"]"), ["a.safetensors", "b.json"]);
    assert.deepEqual(parseStringList("a.safetensors, b.json"), ["a.safetensors", "b.json"]);
  });

  it("reuses an existing configured cache directory", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "senpai-cache-"));
    const modelDir = path.join(tmp, "model");
    const cacheDir = path.join(tmp, "cache");
    fs.mkdirSync(modelDir);
    fs.mkdirSync(cacheDir);

    const choice = chooseCacheDir(modelDir, cacheDir);
    assert.equal(choice.cacheDir, cacheDir);
    assert.equal(choice.reused, true);
    assert.equal(choice.source, "configured_existing");
  });

  it("exports cache environment paths under the selected cache", () => {
    const env = cacheEnvironment("/tmp/senpai-cache");
    assert.equal(env.HF_HOME, "/tmp/senpai-cache");
    assert.equal(env.HUGGINGFACE_HUB_CACHE, "/tmp/senpai-cache/hub");
    assert.equal(env.SENPAI_LTX_CACHE_DIR, "/tmp/senpai-cache");
  });

  it("marks local models ready when directory, required files, and safety are valid", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "senpai-model-"));
    const modelDir = path.join(tmp, "ltx");
    fs.mkdirSync(modelDir);
    fs.writeFileSync(path.join(modelDir, "weights.safetensors"), "fake");

    const result = await probeLocalModels({
      provider: "ltx-local",
      safetyVerdict: "allowed",
      modelDir,
      requiredFiles: ["weights.safetensors"],
      requireGpu: false,
      configureEnv: false,
    });

    assert.equal(result.ready, true);
    assert.equal(result.cache_dir.startsWith(modelDir), true);
  });

  it("reports missing required model files", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "senpai-model-"));
    const modelDir = path.join(tmp, "ltx");
    fs.mkdirSync(modelDir);

    const result = await probeLocalModels({
      provider: "ltx-local",
      safetyVerdict: "allowed",
      modelDir,
      requiredFiles: ["missing.safetensors"],
      requireGpu: false,
      configureEnv: false,
    });

    assert.equal(result.ready, false);
    assert.deepEqual(result.missing_files, ["missing.safetensors"]);
  });
});
