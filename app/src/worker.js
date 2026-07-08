import { createAppAuth } from "@octokit/auth-app";

const DISPATCH_PERMISSIONS = new Set(["write", "admin"]);
const DEFAULT_TEMPLATE_BASE_URL = "https://raw.githubusercontent.com/lofimichael/merge-senpai/main";
const SETUP_FILES = [
  ".github/workflows/merge-senpai.yml",
  ".github/senpai.yml",
  ".github/merge-senpai/avatar.png",
  ".github/merge-senpai/player.html",
];

function envFlag(env, name, defaultValue = false) {
  const value = env[name];
  if (value == null || value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseReviewCommand(body) {
  const value = String(body || "").trim();
  const slash = value.match(/^\/senpai(?:\s+(\S+))?/i);
  const natural = value.match(/^senpai,\s*(\S+)?/i);

  if (!slash && !natural && !/\bsenpai\b/i.test(value)) return null;

  const verb = (slash?.[1] || natural?.[1] || "review").toLowerCase();
  if (!["review", "run", "check", "dispatch"].includes(verb)) return null;

  return verb;
}

function normalizePrivateKey(value) {
  return String(value || "").replace(/\\n/g, "\n");
}

function base64FromBytes(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;

  let result = 0;
  for (let index = 0; index < a.length; index += 1) {
    result |= a[index] ^ b[index];
  }
  return result === 0;
}

async function verifyGitHubSignature(request, env, body) {
  const signature = request.headers.get("x-hub-signature-256") || "";
  if (!signature.startsWith("sha256=")) return false;
  if (!env.WEBHOOK_SECRET) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return timingSafeEqual(hexToBytes(signature.slice("sha256=".length)), new Uint8Array(digest));
}

async function createInstallationToken(env, installationId) {
  if (!installationId) {
    throw new Error("Missing GitHub App installation id in webhook payload.");
  }

  const auth = createAppAuth({
    appId: env.APP_ID,
    privateKey: normalizePrivateKey(env.PRIVATE_KEY),
  });

  const installationAuthentication = await auth({
    type: "installation",
    installationId,
  });

  return installationAuthentication.token;
}

async function githubRequest(token, path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "merge-senpai-github-app",
      "x-github-api-version": "2022-11-28",
      ...(options.headers || {}),
    },
  });

  if (response.status === 204) return { response, data: null };

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  return { response, data };
}

function repoParts(repository) {
  const fullName = repository.full_name;
  if (!fullName || !fullName.includes("/")) {
    throw new Error("Repository payload is missing full_name.");
  }

  const [owner, repo] = fullName.split("/");
  return { owner, repo };
}

function repoApiPath(repository, suffix) {
  const { owner, repo } = repoParts(repository);
  return `/repos/${owner}/${repo}${suffix}`;
}

async function fetchSetupFile(env, path) {
  const baseUrl = String(env.SENPAI_TEMPLATE_BASE_URL || DEFAULT_TEMPLATE_BASE_URL).replace(/\/$/, "");
  const url = `${baseUrl}/templates/${path}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not fetch setup template ${url}: ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    content: base64FromBytes(bytes),
    size: bytes.length,
  };
}

async function getExistingContent(token, repository, path) {
  const { response, data } = await githubRequest(
    token,
    repoApiPath(repository, `/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`),
    { method: "GET" },
  );

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Could not inspect ${repository.full_name}:${path}: ${response.status}`);
  }
  return data;
}

async function putContent(token, repository, path, content, sha) {
  const body = {
    message: `Install Merge Senpai asset ${path}`,
    content,
  };
  if (sha) body.sha = sha;

  const { response, data } = await githubRequest(
    token,
    repoApiPath(repository, `/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`),
    {
      method: "PUT",
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    throw new Error(`Could not write ${repository.full_name}:${path}: ${response.status} ${JSON.stringify(data)}`);
  }

  return data;
}

async function ensureSetupFile(env, token, repository, path) {
  const template = await fetchSetupFile(env, path);
  const existing = await getExistingContent(token, repository, path);

  if (existing?.type === "file") {
    const existingContent = String(existing.content || "").replace(/\s/g, "");
    if (existingContent === template.content) {
      return { path, status: "current" };
    }

    if (!envFlag(env, "SENPAI_SETUP_OVERWRITE", false)) {
      return { path, status: "exists_different" };
    }

    await putContent(token, repository, path, template.content, existing.sha);
    return { path, status: "updated" };
  }

  await putContent(token, repository, path, template.content);
  return { path, status: "created", size: template.size };
}

async function ensureRepositorySetup(env, token, repository) {
  const results = [];
  for (const path of SETUP_FILES) {
    try {
      results.push(await ensureSetupFile(env, token, repository, path));
    } catch (error) {
      console.error("Merge Senpai setup failed for file", {
        repository: repository.full_name,
        path,
        error: error.message,
      });
      results.push({ path, status: "error", error: error.message });
    }
  }

  console.info("Merge Senpai setup checked", {
    repository: repository.full_name,
    results,
  });
  return results;
}

async function getCommenterPermission(token, repository, username) {
  const { response, data } = await githubRequest(
    token,
    repoApiPath(repository, `/collaborators/${encodeURIComponent(username)}/permission`),
    { method: "GET" },
  );

  if (response.status === 404) return "none";
  if (!response.ok) {
    throw new Error(`GitHub permission check failed: ${response.status} ${JSON.stringify(data)}`);
  }

  return String(data.permission || "none").toLowerCase();
}

async function canDispatchForComment(token, payload) {
  const permission = await getCommenterPermission(
    token,
    payload.repository,
    payload.comment.user.login,
  );
  return DISPATCH_PERMISSIONS.has(permission);
}

async function dispatchReview(env, payload, token, prNumber, reason) {
  const repository = payload.repository;
  const { owner, repo } = repoParts(repository);
  const workflowId = env.SENPAI_WORKFLOW_ID || "merge-senpai.yml";
  const ref = env.SENPAI_WORKFLOW_REF || repository.default_branch;

  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const { response, data } = await githubRequest(
      token,
      `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`,
      {
        method: "POST",
        body: JSON.stringify({
          ref,
          inputs: {
            pr_number: String(prNumber),
            reason,
          },
        }),
      },
    );

    if (response.ok) {
      console.info("Dispatched Merge Senpai workflow", {
        repository: repository.full_name,
        workflowId,
        ref,
        prNumber,
        reason,
        attempt,
      });
      return;
    }

    lastError = `GitHub workflow dispatch failed: ${response.status} ${JSON.stringify(data)}`;
    if (![404, 422].includes(response.status) || attempt === 4) break;
    await sleep(1000 * attempt);
  }

  throw new Error(lastError);
}

async function handleIssueComment(env, payload) {
  const { repository, issue, comment } = payload;

  if (!issue?.pull_request) return { ignored: "not_pull_request_comment" };

  const command = parseReviewCommand(comment.body);
  if (!command) return { ignored: "not_senpai_command" };

  const token = await createInstallationToken(env, payload.installation?.id);
  if (!(await canDispatchForComment(token, payload))) {
    console.info("Ignored unauthorized Merge Senpai command", {
      repository: repository.full_name,
      prNumber: issue.number,
      login: comment.user.login,
    });
    return { ignored: "commenter_not_allowed" };
  }

  await ensureRepositorySetup(env, token, repository);
  await dispatchReview(env, payload, token, issue.number, `comment:${command}:${comment.user.login}`);
  return { dispatched: true };
}

async function handlePullRequest(env, payload) {
  if (!envFlag(env, "SENPAI_AUTO_DISPATCH", false)) return { ignored: "auto_dispatch_disabled" };

  const { repository, pull_request: pullRequest } = payload;
  if (pullRequest.draft) return { ignored: "draft_pull_request" };

  const token = await createInstallationToken(env, payload.installation?.id);
  await ensureRepositorySetup(env, token, repository);
  await dispatchReview(env, payload, token, pullRequest.number, `pull_request:${payload.action}`);
  return { dispatched: true };
}

async function handleInstallation(env, payload) {
  if (payload.action !== "created") return { ignored: "unsupported_installation_action" };

  const token = await createInstallationToken(env, payload.installation?.id);
  const repositories = payload.repositories || [];
  const results = [];

  for (const repository of repositories) {
    results.push({
      repository: repository.full_name,
      files: await ensureRepositorySetup(env, token, repository),
    });
  }

  return { setup: true, repositories: results.length, results };
}

async function handleInstallationRepositories(env, payload) {
  if (payload.action !== "added") return { ignored: "unsupported_installation_repositories_action" };

  const token = await createInstallationToken(env, payload.installation?.id);
  const repositories = payload.repositories_added || [];
  const results = [];

  for (const repository of repositories) {
    results.push({
      repository: repository.full_name,
      files: await ensureRepositorySetup(env, token, repository),
    });
  }

  return { setup: true, repositories: results.length, results };
}

async function handleGitHubWebhook(request, env) {
  if (request.method !== "POST") {
    return new Response("Merge Senpai GitHub App is running.\n", { status: 200 });
  }

  const body = await request.text();
  const signatureOk = await verifyGitHubSignature(request, env, body);
  if (!signatureOk) {
    return Response.json({ error: "invalid_signature" }, { status: 401 });
  }

  const eventName = request.headers.get("x-github-event") || "";
  const payload = JSON.parse(body);
  const action = payload.action || "";

  let result;
  if (eventName === "installation") {
    result = await handleInstallation(env, payload);
  } else if (eventName === "installation_repositories") {
    result = await handleInstallationRepositories(env, payload);
  } else if (eventName === "issue_comment" && action === "created") {
    result = await handleIssueComment(env, payload);
  } else if (
    eventName === "pull_request" &&
    ["opened", "synchronize", "reopened", "ready_for_review"].includes(action)
  ) {
    result = await handlePullRequest(env, payload);
  } else {
    result = { ignored: "unsupported_event" };
  }

  return Response.json(result, { status: result.dispatched ? 202 : 200 });
}

export default {
  async fetch(request, env) {
    try {
      return await handleGitHubWebhook(request, env);
    } catch (error) {
      console.error(error);
      return Response.json({ error: "internal_error" }, { status: 500 });
    }
  },
};
