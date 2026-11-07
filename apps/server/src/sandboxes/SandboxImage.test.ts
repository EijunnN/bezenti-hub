import { assert, it } from "@effect/vitest";

import { stagingEnvironment } from "./SandboxImage.ts";

it("stages with the registry's proxy, CA and package manager settings, never provider keys", () => {
  const staged = stagingEnvironment({
    HOME: "/home/ada",
    PATH: "/usr/bin",
    HTTPS_PROXY: "http://proxy.corp:3128",
    no_proxy: "localhost",
    NODE_EXTRA_CA_CERTS: "/etc/corp-ca.pem",
    SSL_CERT_FILE: "/etc/ssl/cert.pem",
    npm_config_registry: "https://npm.corp/",
    PNPM_HOME: "/home/ada/.pnpm",
    ANTHROPIC_API_KEY: "sk-ant-secret",
    GITHUB_TOKEN: "ghp_secret",
    NODE_OPTIONS: "--inspect",
  });
  assert.equal(staged.HTTPS_PROXY, "http://proxy.corp:3128");
  assert.equal(staged.no_proxy, "localhost");
  assert.equal(staged.NODE_EXTRA_CA_CERTS, "/etc/corp-ca.pem");
  assert.equal(staged.SSL_CERT_FILE, "/etc/ssl/cert.pem");
  assert.equal(staged.npm_config_registry, "https://npm.corp/");
  assert.equal(staged.PNPM_HOME, "/home/ada/.pnpm");
  assert.equal(staged.HOME, "/home/ada");
  assert.isUndefined(staged.ANTHROPIC_API_KEY);
  assert.isUndefined(staged.GITHUB_TOKEN);
  assert.isUndefined(staged.NODE_OPTIONS);
});
