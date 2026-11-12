/**
 * One line of CLIProxyAPI's output, made safe for the Hub's logs: the Hub's own keys, the value of
 * anything named like a credential (`refresh_token=`, `"api_key": "…"`, `Authorization: Bearer …`)
 * and anything shaped like a known token (Google, OpenAI, Anthropic, GitHub, JWT) become `[redacted]`.
 */
const MAX_LOG_LINE = 400;
const REDACTED = "[redacted]";

/** Names whose value is a credential, in JSON, YAML, headers, query strings or `key=value`. */
const CREDENTIAL_NAMES = [
  "access[_-]?token",
  "refresh[_-]?token",
  "id[_-]?token",
  "session[_-]?token",
  "auth[_-]?token",
  "token",
  "api[_-]?key",
  "apikey",
  "x-api-key",
  "x-goog-api-key",
  "client[_-]?secret",
  "secret[_-]?key",
  "secret",
  "password",
  "passwd",
  "authorization",
  "cookie",
  "key",
  "code",
].join("|");

const NAMED_VALUE = new RegExp(
  // name, then `=`, `:` or `": "`, then the value up to a delimiter.
  `((?:^|[^A-Za-z0-9])(?:${CREDENTIAL_NAMES})["']?\\s*[:=]\\s*["']?)(?:bearer\\s+|basic\\s+)?[^\\s"'&,;)}\\]]{4,}`,
  "giu",
);

const TOKEN_SHAPES = [
  /AIza[0-9A-Za-z_-]{20,}/gu, // Google API key
  /ya29\.[0-9A-Za-z_.-]{10,}/gu, // Google OAuth access token
  /1\/\/[0-9A-Za-z_-]{10,}/gu, // Google OAuth refresh token
  /\bsk-[A-Za-z0-9_-]{10,}/gu, // OpenAI, Anthropic (`sk-ant-…`), DeepSeek and others
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{10,}/gu, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{10,}/gu,
  /\bxai-[A-Za-z0-9_-]{10,}/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/gu, // JWT
  /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/giu,
];

export const filterGatewayLine = (line: string, secrets: ReadonlyArray<string>) => {
  let safe = line;
  for (const secret of secrets) {
    if (secret.length > 0) safe = safe.split(secret).join(REDACTED);
  }
  safe = safe.replace(NAMED_VALUE, `$1${REDACTED}`);
  for (const shape of TOKEN_SHAPES) safe = safe.replace(shape, REDACTED);
  return safe.length > MAX_LOG_LINE ? `${safe.slice(0, MAX_LOG_LINE)}…` : safe;
};
