// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The SandyWP provider client.
 *
 * SandyWP creates disposable WordPress sandboxes. A sandbox *is* the
 * environment, so HQ synthesizes exactly one environment per sandbox
 * (`name: "site"`, with the sandbox id as its id), as it does for InstaWP.
 *
 * The profile's key is a personal API token sent as a bearer token. The
 * profile's optional `companyId` names the workspace to act in and is sent as
 * `X-SandyWP-Workspace` on every request; without it SandyWP uses the caller's
 * personal workspace.
 *
 * Creation always asks SandyWP to provision in the background. The create
 * response then returns at once with the sandbox in `creating`, and the sandbox
 * id is the operation id: `operationStatus` reads the sandbox until it leaves
 * `creating`. A synchronous create would hold one request open for up to a
 * minute, longer than the shared HTTP client's per-attempt timeout.
 *
 * SandyWP puts the sandbox's plaintext admin password and a one-click login
 * link in its responses. HQ never emits either: both are replaced before a
 * result can reach stdout, a log or the dashboard, and no field of a
 * `HostingSite` carries them.
 */

import type { ProviderKind } from "../../config/schema.js";
import { CliError } from "../../errors.js";
import { asRecord } from "../../json.js";
import {
  registerSensitiveValues,
  registeredSensitiveValues,
} from "../../output/redact.js";
import {
  type ActionRequest,
  type ListSitesOptions,
  type ProviderClient,
  type ReadRequest,
  assertNever,
  unsupportedActionRequest,
  unsupportedReadRequest,
} from "../client.js";
import type {
  ProviderClientContext,
  ProviderClientFactory,
} from "../factory.js";
import { type HttpClient, bearerAuth, jsonBody } from "../http-client.js";
import { setupSandyWpNovamira } from "./sandywp-setup.js";
import {
  type ActionResult,
  type HostingEnvironment,
  type HostingSite,
  type OperationStatus,
  type ProviderValidation,
  type SiteCreateMode,
  providerCapabilities,
  providerLabel,
} from "../types.js";

const PROVIDER: ProviderKind = "sandywp";
const LABEL = providerLabel(PROVIDER);

const ACCOUNT_PATH = "/api/account/me";
const SITES_PATH = "/api/app/sites";

/** SandyWP reads the workspace from this header; HTTP header names are case-blind. */
const WORKSPACE_HEADER = "X-SandyWP-Workspace";

/** The synthetic environment's name, the same one InstaWP uses. */
const SYNTHETIC_ENVIRONMENT_NAME = "site";

const NOTE_SINGLE_ENV =
  "SandyWP sandboxes are exposed as one synthetic environment";
const NOTE_NOT_MAPPED = "not mapped for SandyWP in Novamira";
const NOTE_UNSUPPORTED =
  "not supported by SandyWP's provider-neutral Novamira mapping";

/** The capability list is documented output, so its order is preserved. */
const CAPABILITIES = providerCapabilities([
  [
    "novamira.setup",
    true,
    "Installs and activates Novamira through the plugin deploy endpoint; AI Abilities may need enabling in WordPress before connecting.",
  ],
  "providers.validate",
  "providers.capabilities",
  "sites.list",
  "sites.get",
  ["envs.list", true, NOTE_SINGLE_ENV],
  ["envs.get", true, NOTE_SINGLE_ENV],
  [
    "ops.get",
    true,
    "reads the sandbox status; the sandbox id is the operation id",
  ],
  [
    "ops.wait",
    true,
    "reads the sandbox status; the sandbox id is the operation id",
  ],
  ["regions.list", false, NOTE_NOT_MAPPED],
  ["activity.list", false, NOTE_NOT_MAPPED],
  [
    "sites.create",
    true,
    "uses POST /api/app/sites and provisions in the background",
  ],
  ["sites.create-plain", true, "uses POST /api/app/sites"],
  [
    "sites.clone",
    true,
    "restores a Template with POST /api/app/sites when templateId is supplied",
  ],
  ["envs.create", false, NOTE_SINGLE_ENV],
  ["envs.create-plain", false, NOTE_SINGLE_ENV],
  ["envs.clone", false, NOTE_SINGLE_ENV],
  ["envs.push", false, NOTE_SINGLE_ENV],
  ["domains.list", false, NOTE_NOT_MAPPED],
  ["dns.domains.list", false, NOTE_NOT_MAPPED],
  ["backups.list", false, NOTE_NOT_MAPPED],
  ["backups.create", false, NOTE_NOT_MAPPED],
  ["backups.restore", false, NOTE_NOT_MAPPED],
  ["cache.clear", false, NOTE_UNSUPPORTED],
  ["php.restart", false, NOTE_UNSUPPORTED],
  ["php.set-version", false, NOTE_NOT_MAPPED],
  ["wp.plugins.list", false, NOTE_NOT_MAPPED],
  ["wp.plugins.install", false, NOTE_NOT_MAPPED],
  ["wp.themes.list", false, NOTE_NOT_MAPPED],
  ["wp-cli.run", false, NOTE_UNSUPPORTED],
  ["logs.get", false, NOTE_NOT_MAPPED],
  ["analytics.usage", false, NOTE_NOT_MAPPED],
  ["analytics.env", false, NOTE_NOT_MAPPED],
]);

/**
 * The fields of `POST /api/app/sites` HQ forwards. `background` is not among
 * them: HQ always sets it. Anything else is refused before a request is sent,
 * so a typo cannot reach SandyWP as a silently ignored option.
 */
const CREATE_FIELDS: ReadonlySet<string> = new Set([
  "siteName",
  "wordpressVersion",
  "phpVersion",
  "workerCode",
  "provisioningPreset",
  "debugOptions",
  "duration",
  "expirationMode",
  "multisite",
  "plugins",
  "themes",
  "templateId",
]);

/** The generic site-name options of `hosting sites create`, in precedence order. */
const SITE_NAME_ALIASES = ["site_name", "display_name", "site_title"] as const;

/** Sandbox statuses in which the sandbox cannot serve a site. */
const BLOCKED_STATUSES: ReadonlySet<string> = new Set([
  "expired",
  "failed",
  "pending_delete",
  "deleted",
  "cleanup_failed",
]);

/**
 * Construct the SandyWP client. The registry wires this module by this name; it
 * reads nothing from the environment, the config, or credential storage.
 */
export const createSandyWpClient: ProviderClientFactory = (
  context: ProviderClientContext,
): ProviderClient => {
  // `reveal()` is called exactly here, to build the `Authorization` header. The
  // resulting key is registered as a secret with the HTTP client, which scrubs
  // it from every diagnostic and error message.
  const http: HttpClient = context.createHttpClient({
    auth: bearerAuth(context.secret.reveal()),
    ...(context.companyId === undefined || context.companyId === ""
      ? {}
      : { defaultHeaders: { [WORKSPACE_HEADER]: context.companyId } }),
  });
  // The official Novamira archive is downloaded outside the SandyWP API origin.
  const transferFetch = context.transferFetch ?? globalThis.fetch;

  async function validate(): Promise<ProviderValidation> {
    const account = asRecord(await http.json({ path: ACCOUNT_PATH }));
    if (account === undefined) {
      throw new CliError(
        "provider_error",
        `The ${LABEL} API returned an unexpected account response.`,
        { details: { provider: PROVIDER, path: ACCOUNT_PATH } },
      );
    }
    const workspace = asRecord(account.activeWorkspace);
    const reported =
      workspace === undefined
        ? undefined
        : (nonEmpty(stringField(workspace, "slug")) ??
          nonEmpty(stringField(workspace, "id")));
    return {
      provider: PROVIDER,
      status: "active",
      companyId: nonEmpty(context.companyId) ?? reported ?? null,
      credential: context.credentialSource,
    };
  }

  async function listSites(options?: ListSitesOptions): Promise<HostingSite[]> {
    const includeEnvironments = options?.includeEnvironments ?? false;
    const body = asRecord(await http.json({ path: SITES_PATH }));
    const sites = Array.isArray(body?.sites) ? body.sites : undefined;
    if (sites === undefined) {
      throw new CliError(
        "provider_error",
        `The ${LABEL} API returned an unexpected sandbox list.`,
        { details: { provider: PROVIDER, path: SITES_PATH } },
      );
    }
    return sites.map((entry) => toHostingSite(entry, includeEnvironments));
  }

  async function readSandbox(siteId: string): Promise<Record<string, unknown>> {
    const path = `${SITES_PATH}/${encodePathSegment(siteId)}`;
    const body = asRecord(await http.json({ path }));
    const sandbox = asRecord(body?.site);
    if (sandbox === undefined) {
      throw new CliError(
        "provider_error",
        `The ${LABEL} API returned no sandbox for ${siteId}.`,
        { details: { provider: PROVIDER, path } },
      );
    }
    return sandbox;
  }

  async function getSite(siteId: string): Promise<HostingSite> {
    return toHostingSite(await readSandbox(siteId), true);
  }

  async function listEnvironments(
    siteId: string,
  ): Promise<HostingEnvironment[]> {
    if (siteId === "") {
      throw new CliError(
        "usage_error",
        `A site id is required to list ${LABEL} environments.`,
        { details: { provider: PROVIDER } },
      );
    }
    const site = await getSite(siteId);
    return site.environments === undefined ? [] : [...site.environments];
  }

  /**
   * SandyWP maps exactly one read request. Every other variant gets an explicit
   * `case` so a new union member fails to compile rather than silently becoming
   * "unsupported"; `default` is unreachable by construction.
   */
  function read(request: ReadRequest): Promise<unknown> {
    switch (request.kind) {
      case "capabilities":
        return Promise.resolve([...CAPABILITIES]);
      case "regions":
      case "activity":
      case "site-domains":
      case "site-domain-verification":
      case "dns-domains":
      case "dns-records":
      case "backups":
      case "downloadable-backups":
      case "logs":
      case "redirects":
      case "denied-ips":
      case "plugins":
      case "themes":
      case "company-plugins":
      case "company-themes":
      case "analytics-usage":
      case "analytics-env":
      case "file-list":
        return Promise.reject(unsupportedReadRequest(PROVIDER, request));
      default:
        return assertNever(request);
    }
  }

  function action(request: ActionRequest): Promise<ActionResult> {
    switch (request.kind) {
      case "create-site":
        return createSite(request.mode, request.body);
      case "setup-novamira":
        return setupSandyWpNovamira(http, transferFetch, {
          envId: request.envId,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
      case "create-environment":
      case "push-environment":
      case "clear-cache":
      case "restart-php":
      case "set-php-version":
      case "add-domain":
      case "change-primary-domain":
      case "create-backup":
      case "restore-backup":
      case "update-plugin":
      case "bulk-update-plugins":
      case "update-theme":
      case "bulk-update-themes":
      case "run-wp-cli":
      case "set-denied-ips":
      case "apply-redirects":
        return Promise.reject(unsupportedActionRequest(PROVIDER, request));
      default:
        return assertNever(request);
    }
  }

  async function createSite(
    mode: SiteCreateMode,
    body: unknown,
  ): Promise<ActionResult> {
    const payload = siteCreatePayload(mode, body);
    const response = await http.request({
      path: SITES_PATH,
      method: "POST",
      body: jsonBody(payload),
    });
    const name =
      mode === "clone"
        ? "sites.clone"
        : mode === "plain"
          ? "sites.create-plain"
          : "sites.create";
    return buildActionResult(name, response.status, response.data);
  }

  async function operationStatus(
    operationId: string,
  ): Promise<OperationStatus> {
    const path = `${SITES_PATH}/${encodePathSegment(operationId)}`;
    const response = await http.request({ path });
    const raw = redactSecrets(response.data);
    const sandbox = asRecord(asRecord(raw)?.site);
    const status = stringField(sandbox, "status") ?? "";
    const failed = status === "failed" || status === "cleanup_failed";
    const reason = nonEmpty(stringField(sandbox, "failureReason"));
    return {
      provider: PROVIDER,
      operationId,
      status: response.status,
      done: status !== "" && status !== "creating",
      failed,
      ...(failed && reason !== undefined ? { message: reason } : {}),
      raw,
    };
  }

  return {
    provider: PROVIDER,
    validate,
    listSites,
    getSite,
    listEnvironments,
    read,
    action,
    operationStatus,
  };
};

/* -------------------------------------------------------------------------- */
/* Request shaping                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The body of `POST /api/app/sites`: the generic site-name options promoted to
 * `siteName`, unknown fields refused, and `background` set so the call returns
 * while the sandbox is still `creating`. Restoring a Template needs its id.
 */
function siteCreatePayload(
  mode: SiteCreateMode,
  body: unknown,
): Record<string, unknown> {
  const source = objectBody(body);
  const aliases: ReadonlySet<string> = new Set(SITE_NAME_ALIASES);
  const payload = Object.fromEntries(
    Object.entries(source).filter(([key]) => !aliases.has(key)),
  );
  if (!("siteName" in payload)) {
    for (const alias of SITE_NAME_ALIASES) {
      const value = source[alias];
      if (typeof value === "string" && value !== "") {
        payload.siteName = value;
        break;
      }
    }
  }

  const unknown = Object.keys(payload).filter((key) => !CREATE_FIELDS.has(key));
  if (unknown.length > 0) {
    throw new CliError(
      "usage_error",
      `${LABEL} does not accept ${unknown.join(", ")} when creating a sandbox. Supported fields: ${[...CREATE_FIELDS].join(", ")}.`,
      { details: { provider: PROVIDER, action: "sites.create" } },
    );
  }
  if (mode === "clone" && typeof payload.templateId !== "string") {
    throw new CliError(
      "usage_error",
      `${LABEL} requires templateId to restore a sandbox from a Template.`,
      { details: { provider: PROVIDER, action: "sites.clone" } },
    );
  }
  return { ...payload, background: true };
}

/** The object is copied, so shaping a request never rewrites the caller's payload. */
function objectBody(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body === "object" && !Array.isArray(body))
    return { ...(body as Record<string, unknown>) };
  throw new CliError(
    "usage_error",
    `The ${LABEL} request body must be a JSON object.`,
    { details: { provider: PROVIDER } },
  );
}

/** `encodeURIComponent` escapes `/`, so an id can never leave its path segment. */
function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

/* -------------------------------------------------------------------------- */
/* Response shaping                                                           */
/* -------------------------------------------------------------------------- */

function buildActionResult(
  name: string,
  status: number,
  raw: unknown,
): ActionResult {
  const sanitized = redactSecrets(raw);
  const operationId = nonEmpty(
    stringField(asRecord(asRecord(sanitized)?.site), "id"),
  );
  return {
    provider: PROVIDER,
    action: name,
    status,
    ...(operationId === undefined ? {} : { operationId }),
    raw: sanitized,
  };
}

/**
 * SandyWP embeds the sandbox's plaintext admin password and its one-click
 * login link in ordinary success payloads, so the raw body is walked and every
 * secret-shaped key replaced before it can reach stdout, a log or the
 * dashboard. The walk copies instead of mutating the parsed body in place.
 */
function redactSecrets(value: unknown): unknown {
  let safe: unknown;
  if (Array.isArray(value)) safe = value.map((child) => redactSecrets(child));
  else if (typeof value === "object" && value !== null) {
    const redacted: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>))
      redacted[key] = isSecretKey(key) ? "redacted" : redactSecrets(child);
    safe = redacted;
  } else safe = value;
  registerSensitiveValues(safe, registeredSensitiveValues(value));
  return safe;
}

function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.includes("password") ||
    lower.includes("secret") ||
    lower.includes("token") ||
    lower.includes("magiclogin")
  );
}

function toHostingSite(
  value: unknown,
  includeEnvironment: boolean,
): HostingSite {
  const record = asRecord(value) ?? {};
  const id = stringField(record, "id") ?? "";
  const label =
    nonEmpty(stringField(record, "name")) ??
    nonEmpty(stringField(record, "slug")) ??
    id;
  const rawStatus = stringField(record, "status") ?? "";
  const primaryDomain = hostOf(stringField(record, "publicUrl"));
  const wordpressVersion = nonEmpty(stringField(record, "wordpressVersion"));

  const environment: HostingEnvironment = {
    id,
    name: SYNTHETIC_ENVIRONMENT_NAME,
    displayName: label,
    isBlocked: BLOCKED_STATUSES.has(rawStatus),
    isPremium: false,
    ...(wordpressVersion === undefined ? {} : { wordpressVersion }),
    ...(primaryDomain === undefined ? {} : { primaryDomain }),
  };

  return {
    id,
    name: label,
    displayName: label,
    status: normalizeStatus(rawStatus),
    ...(primaryDomain === undefined ? {} : { primaryDomain }),
    ...(includeEnvironment ? { environments: [environment] } : {}),
  };
}

function normalizeStatus(status: string): string {
  switch (status) {
    case "ready":
      return "active";
    case "creating":
      return "pending";
    case "pending_delete":
    case "deleted":
    case "cleanup_failed":
      return "deleted";
    case "":
      return "unknown";
    default:
      return status.toLowerCase();
  }
}

function hostOf(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  try {
    const host = new URL(value).host;
    return host === "" ? undefined : host;
  } catch {
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* JSON narrowing                                                             */
/* -------------------------------------------------------------------------- */

function stringField(value: unknown, key: string): string | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const field = record[key];
  return typeof field === "string" ? field : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}
