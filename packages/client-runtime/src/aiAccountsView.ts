/**
 * What a client shows of the Hub's AI accounts, as the Hub answered: the Owner's full list or a
 * User's narrowed one. Pure; no credential ever enters a row (the Hub sends none).
 */
import {
  type AiAccountDetails,
  type AiAccountStatus,
  type AiAccountSummary,
  WS_METHODS,
} from "@t3tools/contracts";

import { AI_PROVIDER_LABEL } from "./aiAccountPicker.ts";

export const AI_ACCOUNT_STATUS_LABELS: Readonly<Record<AiAccountStatus, string>> = {
  pending: "Waiting for the AI gateway",
  working: "Working",
  unverified: "In the gateway, unverified",
  error: "Error",
  disabled: "Disabled",
  removing: "Still live in the gateway",
  "needs-sign-in": "Needs sign-in again",
  "quota-exhausted": "Quota exhausted",
};

/** A subscription's quota windows, as its provider reports them. */
export const quotaText = (details: AiAccountDetails | null | undefined): string | null =>
  details?.usageLimits == null || details.usageLimits.windows.length === 0
    ? null
    : `Quota: ${details.usageLimits.windows
        .map((window) => `${window.label} ${Math.round(window.usedPercent)}% used`)
        .join(", ")}.`;

export interface AiAccountRow {
  readonly id: string;
  readonly name: string;
  readonly providerLabel: string;
  readonly kindLabel: string;
  readonly priority: number;
  readonly status: AiAccountStatus;
  readonly statusLabel: string;
  readonly statusMessage: string | null;
  readonly disabled: boolean;
  readonly quota: string | null;
  readonly signedInAs: string | null;
}

const KIND_LABEL = {
  subscription: "Subscription",
  "api-key": "API key",
  direct: "Direct",
} as const;

/** The accounts first to last by the Installation's priority, in words; read-only. */
export function accountRows(
  accounts: ReadonlyArray<AiAccountSummary>,
): ReadonlyArray<AiAccountRow> {
  return [...accounts]
    .sort((left, right) => left.priority - right.priority)
    .map((account) => ({
      id: account.id,
      name: account.name,
      providerLabel: AI_PROVIDER_LABEL[account.provider],
      kindLabel: KIND_LABEL[account.type],
      priority: account.priority,
      status: account.status,
      statusLabel: AI_ACCOUNT_STATUS_LABELS[account.status],
      statusMessage: account.statusMessage,
      disabled: account.disabled,
      quota: quotaText(account.details),
      signedInAs: account.details?.signedInAs ?? null,
    }));
}

/**
 * What the phone never calls: signing in, managing AI accounts and the gateway's update. They
 * stay on web and desktop (spec 4, «Clientes»); the Hub refuses them from a Member anyway.
 */
export const MOBILE_FORBIDDEN_AI_METHODS: ReadonlyArray<string> = [
  WS_METHODS.aiAccountsLoginStart,
  WS_METHODS.aiAccountsLoginComplete,
  WS_METHODS.aiAccountsImportVertex,
  WS_METHODS.aiAccountsCreate,
  WS_METHODS.aiAccountsUpdate,
  WS_METHODS.aiAccountsDelete,
  WS_METHODS.aiAccountsAllow,
  WS_METHODS.aiAccountsReorder,
  WS_METHODS.aiGatewayUpdate,
  WS_METHODS.aiGatewayRollback,
  WS_METHODS.aiGatewaySetEnabled,
];
