import { SettingsLegalDocumentRouteScreen } from "./components/SettingsLegalDocumentRouteScreen";
import { LEGAL_URL } from "./lib/legal-document-url";

export function SettingsLegalRouteScreen() {
  // About lists Legal only when the build names a legal site.
  return LEGAL_URL === null ? null : (
    <SettingsLegalDocumentRouteScreen documentName="Legal" documentUrl={LEGAL_URL} />
  );
}
