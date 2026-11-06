// The Owner's own legal pages, if the build names a site for them (EXPO_PUBLIC_MARKETING_SITE_URL).
// pingdotgg's site is not this Installation's (ADR 0007), so without one there is no Legal page.
function resolveMarketingSiteUrl(override: string | undefined): URL | null {
  try {
    if (!override?.trim()) return null;
    const url = new URL(override.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;

    url.search = "";
    url.hash = "";
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
    return url;
  } catch {
    return null;
  }
}

const MARKETING_SITE_URL = resolveMarketingSiteUrl(process.env.EXPO_PUBLIC_MARKETING_SITE_URL);

function marketingSiteDocumentUrl(path: string): string | null {
  return MARKETING_SITE_URL === null ? null : new URL(path, MARKETING_SITE_URL).toString();
}

const PRIVACY_POLICY_URL = marketingSiteDocumentUrl("privacy-policy");
const SECURITY_POLICY_URL = marketingSiteDocumentUrl("security-policy");
const TERMS_OF_SERVICE_URL = marketingSiteDocumentUrl("terms-of-service");
export const LEGAL_URL = marketingSiteDocumentUrl("legal");

const ALLOWED_LEGAL_DOCUMENT_URLS = [
  LEGAL_URL,
  PRIVACY_POLICY_URL,
  TERMS_OF_SERVICE_URL,
  SECURITY_POLICY_URL,
] as const;

function webDocumentIdentity(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;

    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.origin}${pathname}`;
  } catch {
    return null;
  }
}

const ALLOWED_LEGAL_DOCUMENT_IDENTITIES = new Set(
  ALLOWED_LEGAL_DOCUMENT_URLS.flatMap((url) => (url === null ? [] : [url]))
    .map(webDocumentIdentity)
    .filter((value): value is string => value !== null),
);

export function isLegalDocumentUrl(value: string): boolean {
  const identity = webDocumentIdentity(value);
  return identity !== null && ALLOWED_LEGAL_DOCUMENT_IDENTITIES.has(identity);
}
