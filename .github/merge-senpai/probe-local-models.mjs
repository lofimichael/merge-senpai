import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const runnerTemp = process.env.RUNNER_TEMP || process.cwd();

function setOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${String(value).replace(/\n/g, " ")}\n`);
}

function appendGitHubEnv(values) {
  if (!process.env.GITHUB_ENV) return;
  const lines = Object.entries(values)
    .filter(([, value]) => value != null && value !== "")
    .map(([name, value]) => `${name}=${String(value).replace(/\n/g, " ")}`);
  if (lines.length) fs.appendFileSync(process.env.GITHUB_ENV, `${lines.join("\n")}\n`);
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

function commandExists(command) {
  if (!command) return false;
  if (command.includes("/") && fs.existsSync(command)) return true;
  const pathDirs = String(process.env.PATH || "").split(path.delimiter);
  return pathDirs.some((dir) => fs.existsSync(path.join(dir, command)));
}

function parseStringList(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  if (raw.startsWith("[") || raw.startsWith("{")) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      throw new Error("Expected a JSON string array.");
    }
    return parsed.map((item) => item.trim()).filter(Boolean);
  }
  return raw
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseArgsJson(value) {
  if (!value) return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("Expected a JSON string array.");
  }
  return parsed;
}

function ensureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function canCreateDirectory(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function chooseCacheDir(modelDir, configuredCacheDir) {
  const candidates = [];
  if (configuredCacheDir) candidates.push(configuredCacheDir);
  candidates.push(path.join(modelDir, ".cache"));
  candidates.push(path.join(path.dirname(modelDir), ".cache"));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return {
        cacheDir: candidate,
        reused: true,
        source: candidate === configuredCacheDir ? "configured_existing" : "existing_runner_cache",
      };
    }
  }

  for (const candidate of candidates) {
    if (canCreateDirectory(candidate)) {
      return {
        cacheDir: candidate,
        reused: false,
        source: candidate === configuredCacheDir ? "configured_created" : "model_adjacent_created",
      };
    }
  }

  const fallback = path.join(runnerTemp, "merge-senpai-model-cache");
  ensureDirectory(fallback);
  return {
    cacheDir: fallback,
    reused: false,
    source: "runner_temp_created",
  };
}

function cacheEnvironment(cacheDir) {
  return {
    SENPAI_LTX_CACHE_DIR: cacheDir,
    HF_HOME: cacheDir,
    HUGGINGFACE_HUB_CACHE: path.join(cacheDir, "hub"),
    TRANSFORMERS_CACHE: path.join(cacheDir, "transformers"),
    DIFFUSERS_CACHE: path.join(cacheDir, "diffusers"),
    XDG_CACHE_HOME: path.join(cacheDir, "xdg"),
  };
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

async function probeLocalModels(options = {}) {
  const provider = String(options.provider || getEnv("SENPAI_MEDIA_PROVIDER", "ltx-local")).trim();
  const safetyVerdict = String(options.safetyVerdict || getEnv("SENPAI_SELF_HOSTED_SAFETY_VERDICT", "denied")).trim();
  const modelDir = String(options.modelDir || getEnv("SENPAI_LTX_MODEL_DIR", "/opt/models/ltx-2.3")).trim();
  const cacheDirConfig = String(options.cacheDir || getEnv("SENPAI_LTX_CACHE_DIR", "")).trim();
  const requiredFiles = options.requiredFiles || parseStringList(getEnv("SENPAI_LTX_REQUIRED_FILES"));
  const requireGpu = options.requireGpu ?? envFlag("SENPAI_LTX_REQUIRE_GPU", true);
  const probeCommand = String(options.probeCommand || getEnv("SENPAI_LTX_PROBE_COMMAND", "")).trim();
  const probeArgs = options.probeArgs || parseArgsJson(getEnv("SENPAI_LTX_PROBE_ARGS_JSON", "[]"));
  const configureEnv = options.configureEnv ?? true;

  const metadata = {
    ready: false,
    provider,
    safety_verdict: safetyVerdict,
    model_dir: modelDir,
    required_files: requiredFiles,
    require_gpu: requireGpu,
    probe_command: probeCommand,
    cache_dir: "",
    cache_reused: false,
    cache_source: "",
    missing_files: [],
    reason: "",
  };

  if (provider !== "ltx-local") {
    metadata.reason = `provider ${provider} does not use local model cache probing`;
    return metadata;
  }
  if (safetyVerdict !== "allowed") {
    metadata.reason = `self-hosted safety verdict is ${safetyVerdict || "missing"}`;
    return metadata;
  }
  if (requireGpu && !commandExists("nvidia-smi")) {
    metadata.reason = "nvidia-smi is not available on this runner";
    return metadata;
  }
  if (!modelDir || !fs.existsSync(modelDir)) {
    metadata.reason = `model directory does not exist: ${modelDir}`;
    return metadata;
  }

  metadata.missing_files = requiredFiles.filter((relativePath) => {
    const target = path.isAbsolute(relativePath)
      ? relativePath
      : path.join(modelDir, relativePath);
    return !fs.existsSync(target);
  });
  if (metadata.missing_files.length) {
    metadata.reason = `model directory is missing required file(s): ${metadata.missing_files.join(", ")}`;
    return metadata;
  }

  const cache = chooseCacheDir(modelDir, cacheDirConfig);
  metadata.cache_dir = cache.cacheDir;
  metadata.cache_reused = cache.reused;
  metadata.cache_source = cache.source;
  const env = cacheEnvironment(cache.cacheDir);
  for (const dir of Object.values(env)) ensureDirectory(dir);

  if (configureEnv) {
    appendGitHubEnv(env);
  }

  if (probeCommand) {
    if (!commandExists(probeCommand)) {
      metadata.reason = `probe command is not executable or on PATH: ${probeCommand}`;
      return metadata;
    }
    await runCommand(probeCommand, probeArgs, {
      ...env,
      SENPAI_LTX_MODEL_DIR: modelDir,
      SENPAI_LTX_CACHE_DIR: cache.cacheDir,
    });
  }

  metadata.ready = true;
  metadata.reason = cache.reused ? "model and existing cache are ready" : "model is ready and cache was initialized";
  metadata.env = env;
  return metadata;
}

function writeProbeMetadata(metadata) {
  const metadataPath = getEnv("SENPAI_LOCAL_MODEL_PROBE_METADATA", path.join(runnerTemp, "senpai-local-model-probe.json"));
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  setOutput("ready", metadata.ready ? "true" : "false");
  setOutput("cache_dir", metadata.cache_dir || "");
  setOutput("cache_reused", metadata.cache_reused ? "true" : "false");
  setOutput("reason", metadata.reason || "");
  setOutput("metadata_path", metadataPath);
  return metadataPath;
}

async function main() {
  const metadata = await probeLocalModels();
  const metadataPath = writeProbeMetadata(metadata);

  if (metadata.ready) {
    console.log(`Merge Senpai local model probe ready: ${metadata.reason}`);
    console.log(`Probe metadata: ${metadataPath}`);
    return;
  }

  warning(`Merge Senpai local model probe not ready: ${metadata.reason}`);
  if (process.argv.includes("--strict")) {
    process.exitCode = 1;
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
    warning(error?.message || "Local model probe failed.");
    process.exitCode = 1;
  });
}

export {
  cacheEnvironment,
  chooseCacheDir,
  commandExists,
  parseStringList,
  probeLocalModels,
};
