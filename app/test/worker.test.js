import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizePrivateKey, parseReviewCommand, resolveGitHubAppConfig } from "../src/worker.js";

describe("resolveGitHubAppConfig", () => {
  it("prefers the signed webhook installation app id over the Worker secret", () => {
    const config = resolveGitHubAppConfig(
      {
        APP_ID: "Iv23client-id-is-not-the-app-id",
        PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\\nabc\\n-----END RSA PRIVATE KEY-----",
      },
      { app_id: 4250652 },
    );

    assert.equal(config.appId, 4250652);
    assert.match(config.privateKey, /\nabc\n/);
  });

  it("reports missing private key as configuration, not a generic crash", () => {
    assert.throws(
      () => resolveGitHubAppConfig({ APP_ID: "4250652" }, { app_id: 4250652 }),
      /Missing GitHub App Worker secret\(s\): PRIVATE_KEY/,
    );
  });
});

describe("webhook helpers", () => {
  it("normalizes escaped private key newlines", () => {
    assert.equal(normalizePrivateKey("a\\nb"), "a\nb");
  });

  it("accepts natural senpai PR comments", () => {
    assert.equal(parseReviewCommand("can senpai look at this?"), "review");
  });
});
