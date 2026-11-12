/**
 * The `config.yaml` the Hub writes for CLIProxyAPI (v8 layout), 0600, beside the `auth-dir`:
 * loopback only, management from loopback behind a random key, no panel, discovery, plugins,
 * usage statistics or request logs (they would keep prompts), and one client key, the Hub's.
 */
import { stringify } from "yaml";

export interface CliproxyConfigInput {
  readonly port: number;
  readonly managementKey: string;
  readonly clientKey: string;
  readonly authDir: string;
}

export const CLIPROXY_HOST = "127.0.0.1";

export const renderCliproxyConfig = (input: CliproxyConfigInput) =>
  stringify({
    "config-version": 8,
    server: {
      host: CLIPROXY_HOST,
      port: input.port,
      tls: { enable: false },
      "trusted-proxies": [],
      discovery: { enabled: false },
    },
    management: {
      "allow-remote": false,
      "secret-key": input.managementKey,
      "disable-control-panel": true,
      "disable-auto-update-panel": true,
    },
    access: { "api-keys": [input.clientKey] },
    oauth: { "auth-dir": input.authDir },
    observability: {
      logs: { debug: false, "logging-to-file": false, "request-log": false },
      usage: { "usage-statistics-enabled": false },
      pprof: { enable: false },
    },
    plugins: { enabled: false },
  });
