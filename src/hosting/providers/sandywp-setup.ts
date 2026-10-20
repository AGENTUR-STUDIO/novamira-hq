// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Novamira setup for SandyWP sandboxes.
 *
 * SandyWP can install a plugin from an uploaded ZIP (`deploy-plugin`), so setup
 * downloads the official Novamira archive, uploads it with `activate`, and
 * waits for SandyWP's deploy job. This is a bounded installer, not a file
 * manager or command bridge: the only writes are that one upload.
 *
 * SandyWP has no plugin inventory, so two things are inferred instead of read:
 *
 * - An existing install is detected from the `wp-content/plugins` listing of
 *   its read-only file bridge, and is never overwritten, because neither its
 *   version nor its activation state can be verified.
 * - The installed version is the one in the archive HQ uploaded, read from the
 *   plugin header before anything is sent.
 *
 * HQ does not change Novamira's AI Abilities on SandyWP: only a paid plan's
 * Blueprints could, and setup behaves the same on every plan. The result
 * reports `aiEnabled: null` and the operator enables them in WordPress.
 */

import { inflateRawSync } from "node:zlib";

import { CliError } from "../../errors.js";
import { asRecord } from "../../json.js";
import { compareSemverStrings, isSemver } from "../../semver.js";
import type { HttpClient } from "../http-client.js";
import { downloadNovamiraArchive } from "../novamira-archive.js";
import type { ActionResult } from "../types.js";

const LABEL = "SandyWP";
const PLUGIN_ENTRY = "novamira/novamira.php";
const PLUGINS_DIRECTORY = "wp-content/plugins";
const SETUP_DEADLINE_MS = 300_000;
const UPLOAD_TIMEOUT_MS = 120_000;
/** A plugin header sits in the first lines; a bigger file is not one. */
const HEADER_MAX_BYTES = 1024 * 1024;
const MINIMUM_WORDPRESS = "6.9.0";
const MINIMUM_PHP_MAJOR = 8;

export interface SandyWpSetupRequest {
  readonly envId: string;
  readonly signal?: AbortSignal;
}

function fail(message: string): never {
  throw new CliError("provider_error", message);
}

function unsupported(message: string): never {
  throw new CliError("server_unsupported", message);
}

export async function setupSandyWpNovamira(
  http: HttpClient,
  fetcher: typeof fetch,
  request: SandyWpSetupRequest,
): Promise<ActionResult> {
  if (request.envId === "")
    throw new CliError(
      "usage_error",
      `${LABEL} setup needs the id of the sandbox to install Novamira on.`,
    );
  const deadline = AbortSignal.timeout(SETUP_DEADLINE_MS);
  const signal = request.signal
    ? AbortSignal.any([request.signal, deadline])
    : deadline;
  signal.throwIfAborted();

  const base = `/api/app/sites/${encodeURIComponent(request.envId)}`;
  const siteUrl = await verifiedSandboxUrl(http, base, signal);

  const pluginNames = async (): Promise<string[]> => {
    const body = asRecord(
      await http.json({
        path: `${base}/fs/list`,
        query: [["path", Buffer.from(PLUGINS_DIRECTORY).toString("base64url")]],
        signal,
      }),
    );
    const entries = body?.entries;
    if (!Array.isArray(entries))
      fail(
        `${LABEL} returned an unreadable plugin listing. No changes were made.`,
      );
    return entries.map((entry: unknown) => {
      const name = asRecord(entry)?.name;
      if (typeof name !== "string")
        fail(
          `${LABEL} returned an unreadable plugin listing. No changes were made.`,
        );
      return name;
    });
  };
  const hasNovamira = (names: readonly string[]): boolean =>
    names.some((name) => name.toLowerCase() === "novamira");

  // Never replace an install whose version and state SandyWP cannot report.
  if (hasNovamira(await pluginNames()))
    unsupported(
      `Novamira is already installed in this ${LABEL} sandbox. ${LABEL} cannot report its version or activation state, so setup will not overwrite it. Connect the site directly instead.`,
    );

  const archive = await downloadNovamiraArchive(fetcher, signal, LABEL);
  const version = novamiraVersionFromArchive(archive);
  if (version === undefined)
    fail(
      "The Novamira archive has no readable plugin version. Nothing was uploaded.",
    );

  // One upload, never repeated: a lost answer must be checked on the sandbox.
  const queued = asRecord(
    await http.json({
      path: `${base}/deploy-plugin`,
      method: "POST",
      signal,
      timeoutMs: UPLOAD_TIMEOUT_MS,
      retry: { maxAttempts: 1 },
      // SandyWP rejects a form upload without an Origin header of its own
      // origin ("Cross-site POST form submissions are forbidden"). The upload
      // goes to that origin, so this names the true origin, not a borrowed one.
      headers: { Origin: new URL(http.baseUrl).origin },
      body: {
        kind: "multipart",
        fields: { activate: "true" },
        files: [
          {
            field: "file",
            filename: "novamira.zip",
            contentType: "application/zip",
            bytes: archive,
          },
        ],
      },
    }),
  );
  const jobId = queued?.jobId;
  if (typeof jobId !== "string" || jobId === "")
    fail(
      `${LABEL} accepted the upload without a deploy job. Verify the sandbox before retrying.`,
    );

  const finished = await http.poll(
    {
      path: `${base}/deploy-plugin`,
      query: [["jobId", jobId]],
      signal,
    },
    {
      signal,
      deadlineMs: SETUP_DEADLINE_MS,
      initialIntervalMs: 2_000,
      maxIntervalMs: 5_000,
      isComplete: (response) => {
        const status = asRecord(asRecord(response.data)?.job)?.status;
        return status === "succeeded" || status === "failed";
      },
    },
  );
  const job = asRecord(asRecord(finished.data)?.job);
  if (job?.status !== "succeeded") {
    const reason =
      typeof job?.lastError === "string" && job.lastError !== ""
        ? ` ${job.lastError.slice(0, 300)}`
        : "";
    fail(`${LABEL} could not install Novamira.${reason}`);
  }

  if (!hasNovamira(await pluginNames()))
    fail(
      `${LABEL} reported the install finished, but the Novamira plugin could not be verified on the sandbox. Check the sandbox before retrying.`,
    );

  return {
    provider: "sandywp",
    action: "novamira.setup",
    status: 200,
    raw: { siteUrl, version, aiEnabled: null, warnings: [] },
  };
}

/**
 * Reads the sandbox and returns its site origin, or refuses before any write:
 * the sandbox must be `ready` and served from an HTTPS root domain. A version
 * SandyWP reports below Novamira's minimum is refused; one it does not report
 * is left to the readiness check that follows setup.
 */
async function verifiedSandboxUrl(
  http: HttpClient,
  base: string,
  signal: AbortSignal,
): Promise<string> {
  const sandbox = asRecord(
    asRecord(await http.json({ path: base, signal }))?.site,
  );
  if (sandbox === undefined)
    fail(`${LABEL} returned no sandbox to install Novamira on.`);
  const status = typeof sandbox.status === "string" ? sandbox.status : "";
  if (status !== "ready")
    unsupported(
      `The ${LABEL} sandbox is ${status || "in an unknown state"}. Novamira can only be installed on a ready sandbox.`,
    );
  let site: URL;
  try {
    site = new URL(String(sandbox.publicUrl));
  } catch {
    unsupported(`${LABEL} did not report a usable site URL for the sandbox.`);
  }
  if (
    site.protocol !== "https:" ||
    site.username ||
    site.password ||
    site.search ||
    site.hash ||
    site.pathname !== "/"
  )
    unsupported(`${LABEL} setup requires an HTTPS root-domain sandbox.`);
  const wordpress = leadingVersion(sandbox.wordpressVersion);
  if (
    wordpress !== undefined &&
    compareSemverStrings(`${wordpress}.0`, MINIMUM_WORDPRESS) < 0
  )
    unsupported(
      `The ${LABEL} sandbox runs WordPress ${wordpress}; Novamira needs 6.9 or newer.`,
    );
  const php = leadingVersion(sandbox.phpVersion);
  if (php !== undefined && Number(php.split(".")[0]) < MINIMUM_PHP_MAJOR)
    unsupported(
      `The ${LABEL} sandbox runs PHP ${php}; Novamira needs PHP ${String(MINIMUM_PHP_MAJOR)} or newer.`,
    );
  return site.origin;
}

/** `major.minor` from the start of a version string, or `undefined`. */
function leadingVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d+)\.(\d+)/.exec(value);
  return match ? `${match[1] ?? ""}.${match[2] ?? ""}` : undefined;
}

/* -------------------------------------------------------------------------- */
/* The version in the archive                                                 */
/* -------------------------------------------------------------------------- */

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

/**
 * The `Version:` of the plugin header in `novamira/novamira.php`, read straight
 * from the ZIP's central directory, or `undefined` when the archive is not a
 * readable Novamira package. Only the one header file is ever decompressed,
 * and only up to a fixed size.
 */
export function novamiraVersionFromArchive(
  archive: Uint8Array,
): string | undefined {
  try {
    const bytes = Buffer.from(
      archive.buffer,
      archive.byteOffset,
      archive.length,
    );
    const source = pluginSource(bytes);
    if (source === undefined) return undefined;
    const header = /^[ \t/*#@]*Version:[ \t]*(\S+)[ \t]*\r?$/m.exec(
      source.toString("utf8"),
    );
    const version = header?.[1];
    return version !== undefined && isSemver(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

function pluginSource(zip: Buffer): Buffer | undefined {
  // The end record is the last 22 bytes unless a comment follows it.
  let end = -1;
  for (
    let at = zip.length - 22;
    at >= Math.max(0, zip.length - 22 - 0xffff);
    at -= 1
  ) {
    if (zip.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY) {
      end = at;
      break;
    }
  }
  if (end < 0) return undefined;
  const entries = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  for (let index = 0; index < entries; index += 1) {
    if (zip.readUInt32LE(at) !== CENTRAL_DIRECTORY_ENTRY) return undefined;
    const method = zip.readUInt16LE(at + 10);
    const compressed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (name !== PLUGIN_ENTRY) continue;
    if (zip.readUInt32LE(local) !== LOCAL_FILE_HEADER) return undefined;
    const start =
      local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + compressed);
    if (data.length !== compressed) return undefined;
    if (method === 0) return data.subarray(0, HEADER_MAX_BYTES);
    if (method === 8)
      return inflateRawSync(data, { maxOutputLength: HEADER_MAX_BYTES });
    return undefined;
  }
  return undefined;
}
