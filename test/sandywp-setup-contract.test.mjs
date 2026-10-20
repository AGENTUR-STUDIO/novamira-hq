// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * SandyWP Novamira setup contract test.
 *
 * Setup uploads the official Novamira ZIP to the sandbox's `deploy-plugin`
 * endpoint and polls the returned job. The suite drives the client against a
 * local `node:http` server on 127.0.0.1:0 that checks each request line in
 * order, and replaces the archive download with an injected `transferFetch`.
 * Response shapes follow SandyWP's published OpenAPI document and the
 * `fs/list` answer a real sandbox returned on a read-only check.
 *
 * Nothing here touches the network beyond loopback and no credential is real.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { deflateRawSync } from "node:zlib";

import { createHttpClient } from "../dist/hosting/http-client.js";
import { createSandyWpClient } from "../dist/hosting/providers/sandywp.js";
import { novamiraVersionFromArchive } from "../dist/hosting/providers/sandywp-setup.js";
import { provisionNovamira } from "../dist/provisioning/index.js";

const KEY = "not-a-real-sandywp-key";
const ADMIN_PASSWORD = "not-a-real-admin-password";
const MAGIC_LOGIN = "https://app.sandywp.com/magic/not-a-real-login-link";

const SITE = "/api/app/sites/site_abc123";
const PLUGINS_PATH = Buffer.from("wp-content/plugins").toString("base64url");
const LIST_PLUGINS = `GET ${SITE}/fs/list?path=${PLUGINS_PATH}`;
const DEPLOY = `POST ${SITE}/deploy-plugin`;
const JOB = `GET ${SITE}/deploy-plugin?jobId=job_1`;

/* -------------------------------------------------------------------------- */
/* A minimal ZIP writer, so the archive under test is a real one              */
/* -------------------------------------------------------------------------- */

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** `entries` maps a path to its text; `deflate` picks the compression method. */
function zip(entries, { deflate = true } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text);
    const stored = deflate ? deflateRawSync(data) : data;
    const method = deflate ? 8 : 0;
    const path = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(path.length, 26);
    locals.push(local, path, stored);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(crc32(data), 16);
    entry.writeUInt32LE(stored.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(path.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, path);
    offset += local.length + path.length + stored.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function pluginHeader(version) {
  return `<?php\n/**\n * Plugin Name: Novamira\n * Version: ${version}\n */\n`;
}

const ARCHIVE = zip({
  "novamira/readme.txt": "Novamira",
  "novamira/novamira.php": pluginHeader("1.12.4"),
});

/* -------------------------------------------------------------------------- */
/* The mock SandyWP API                                                       */
/* -------------------------------------------------------------------------- */

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function startSandyWp(routes) {
  let origin = "";
  const failures = [];
  const seen = [];
  let index = 0;
  const server = createServer((request, response) => {
    void readBody(request).then((body) => {
      const line = `${request.method} ${request.url}`;
      seen.push(line);
      const route = routes[index];
      index += 1;
      if (route === undefined) {
        failures.push(`unexpected request: ${line}`);
        response.writeHead(500, { "content-type": "application/json" });
        response.end('{"error":{"code":"unexpected","message":"unexpected"}}');
        return;
      }
      if (line !== route.expected)
        failures.push(`request line = ${line}, want ${route.expected}`);
      if (request.headers.authorization !== `Bearer ${KEY}`)
        failures.push("missing or wrong bearer key");
      for (const [name, value] of Object.entries(route.headers ?? {})) {
        const want = value === "<api-origin>" ? origin : value;
        if (request.headers[name] !== want)
          failures.push(
            `header ${name} = ${String(request.headers[name])}, want ${want}`,
          );
      }
      for (const part of route.bodyIncludes ?? []) {
        if (!body.includes(part))
          failures.push(`request body lacks ${String(part).slice(0, 60)}`);
      }
      response.writeHead(route.status ?? 200, {
        "content-type": "application/json",
      });
      response.end(route.body ?? "");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  origin = `http://127.0.0.1:${port}`;
  return {
    baseUrl: origin,
    failures,
    seen,
    get consumed() {
      return index;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** The official download, served from memory. `calls` counts the requests. */
function archiveFetch(archive = ARCHIVE) {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(String(url));
    return new Response(new Uint8Array(archive), {
      status: 200,
      headers: { "content-type": "application/zip" },
    });
  };
  return { fetcher, calls };
}

function sandyWpContext(baseUrl, transferFetch, overrides = {}) {
  const secret = {
    source: "env",
    description: "env:SANDYWP_API_KEY",
    length: KEY.length,
    reveal: () => KEY,
    toString: () => "[redacted]",
    toJSON: () => "[redacted]",
  };
  return {
    provider: "sandywp",
    providerLabel: "SandyWP",
    profileName: "sandywp-test",
    profile: {
      provider: "sandywp",
      credential: { type: "env", name: "SANDYWP_API_KEY" },
    },
    baseUrl,
    secret,
    credentialSource: "env:SANDYWP_API_KEY",
    companyId: undefined,
    identity: undefined,
    tokenUrl: undefined,
    env: {},
    transferFetch,
    createHttpClient: (httpOverrides) =>
      createHttpClient({
        baseUrl,
        providerLabel: "SandyWP",
        retry: { maxAttempts: 1 },
        sleep: async () => undefined,
        ...httpOverrides,
      }),
    ...overrides,
  };
}

/** Runs `body` against a fresh mock server and always closes it. */
async function withSetup(routes, body, { archive } = {}) {
  const server = await startSandyWp(routes);
  const download = archiveFetch(archive);
  try {
    const client = await createSandyWpClient(
      sandyWpContext(server.baseUrl, download.fetcher),
    );
    await body(client, server, download);
  } finally {
    await server.close();
  }
  assert.deepEqual(server.failures, []);
  assert.equal(
    server.consumed,
    routes.length,
    `consumed ${String(server.consumed)} of ${String(routes.length)} routes: ${server.seen.join(", ")}`,
  );
}

function sandbox(overrides = {}) {
  return JSON.stringify({
    site: {
      id: "site_abc123",
      name: "Demo",
      slug: "demo-abc",
      status: "ready",
      publicUrl: "https://demo-abc.sandywp.app",
      wordpressVersion: "7.0.4",
      phpVersion: "8.3",
      adminUsername: "admin",
      adminPassword: ADMIN_PASSWORD,
      magicLoginUrl: MAGIC_LOGIN,
      ...overrides,
    },
    events: [],
    jobs: {},
  });
}

const listing = (...names) =>
  JSON.stringify({
    path: "wp-content/plugins",
    entries: names.map((name) => ({
      name,
      path: `wp-content/plugins/${name}`,
      type: name.includes(".") ? "file" : "dir",
      size: 0,
      mtime: 1401983954,
      protected: false,
    })),
  });

const job = (status, lastError = null) =>
  JSON.stringify({
    job: { id: "job_1", type: "deploy_plugin", status, lastError },
  });

const QUEUED = JSON.stringify({ jobId: "job_1", artifactId: "art_1" });

/** The routes of a clean install, optionally replacing the job answers. */
function installRoutes({ jobs = [job("succeeded")], after } = {}) {
  return [
    { expected: `GET ${SITE}`, body: sandbox() },
    { expected: LIST_PLUGINS, body: listing("index.php") },
    {
      expected: DEPLOY,
      body: QUEUED,
      // SandyWP answers 403 "Cross-site POST form submissions are forbidden" to
      // a multipart upload that carries no Origin header of its own origin.
      headers: { origin: "<api-origin>" },
      bodyIncludes: [
        'name="file"',
        'filename="novamira.zip"',
        'name="activate"',
        "true",
        ARCHIVE,
      ],
    },
    ...jobs.map((body) => ({ expected: JOB, body })),
    {
      expected: LIST_PLUGINS,
      body: after ?? listing("index.php", "novamira"),
    },
  ];
}

const setupRequest = { kind: "setup-novamira", envId: "site_abc123" };

/* -------------------------------------------------------------------------- */
/* The install                                                                */
/* -------------------------------------------------------------------------- */

test("sandywp setup uploads the official ZIP, waits for the job and reports the archive version", async () => {
  await withSetup(installRoutes(), async (client, server, download) => {
    const result = await client.action(setupRequest);
    assert.equal(result.provider, "sandywp");
    assert.equal(result.action, "novamira.setup");
    assert.equal(result.status, 200);
    assert.deepEqual(result.raw, {
      siteUrl: "https://demo-abc.sandywp.app",
      version: "1.12.4",
      aiEnabled: null,
      warnings: [],
    });
    assert.deepEqual(download.calls, [
      "https://license.dynamic.ooo/api/novamira/download",
    ]);
  });
});

test("sandywp setup keeps polling while the job is running or will be retried", async () => {
  await withSetup(
    installRoutes({
      jobs: [
        job("pending"),
        job("claimed"),
        job("running"),
        job("retryable", "worker restarted"),
        job("succeeded"),
      ],
    }),
    async (client) => {
      const result = await client.action(setupRequest);
      assert.equal(result.raw.version, "1.12.4");
    },
  );
});

test("sandywp setup reads the version from a stored (uncompressed) archive", async () => {
  const archive = zip(
    { "novamira/novamira.php": pluginHeader("2.0.1") },
    { deflate: false },
  );
  const routes = installRoutes();
  routes[2] = { ...routes[2], bodyIncludes: ['name="file"', archive] };
  await withSetup(
    routes,
    async (client) => {
      const result = await client.action(setupRequest);
      assert.equal(result.raw.version, "2.0.1");
    },
    { archive },
  );
});

test("sandywp setup never puts a sandbox credential in its result", async () => {
  await withSetup(installRoutes(), async (client) => {
    const result = await client.action(setupRequest);
    const text = JSON.stringify(result);
    assert.equal(text.includes(ADMIN_PASSWORD), false);
    assert.equal(text.includes(MAGIC_LOGIN), false);
    assert.equal(text.includes(KEY), false);
  });
});

/* -------------------------------------------------------------------------- */
/* Fail closed before any write                                               */
/* -------------------------------------------------------------------------- */

test("sandywp setup refuses to overwrite an existing Novamira directory", async () => {
  await withSetup(
    [
      { expected: `GET ${SITE}`, body: sandbox() },
      { expected: LIST_PLUGINS, body: listing("index.php", "novamira") },
    ],
    async (client, server, download) => {
      await assert.rejects(client.action(setupRequest), (error) => {
        assert.equal(error.code, "server_unsupported");
        assert.match(error.message, /already installed/i);
        assert.match(error.message, /not overwrite/i);
        return true;
      });
      assert.deepEqual(download.calls, []);
    },
  );
});

for (const status of ["creating", "expired", "failed"]) {
  test(`sandywp setup needs a ready sandbox, not ${status}`, async () => {
    await withSetup(
      [{ expected: `GET ${SITE}`, body: sandbox({ status }) }],
      async (client, server, download) => {
        await assert.rejects(client.action(setupRequest), (error) => {
          assert.equal(error.code, "server_unsupported");
          assert.match(error.message, new RegExp(status));
          return true;
        });
        assert.deepEqual(download.calls, []);
      },
    );
  });
}

for (const [label, overrides] of [
  ["http", { publicUrl: "http://demo-abc.sandywp.app" }],
  ["a path", { publicUrl: "https://demo-abc.sandywp.app/blog" }],
  ["a query", { publicUrl: "https://demo-abc.sandywp.app/?x=1" }],
  ["credentials", { publicUrl: "https://user:pw@demo-abc.sandywp.app" }],
  ["no url", { publicUrl: null }],
]) {
  test(`sandywp setup needs an HTTPS root-domain sandbox, not ${label}`, async () => {
    await withSetup(
      [{ expected: `GET ${SITE}`, body: sandbox(overrides) }],
      async (client, server, download) => {
        await assert.rejects(client.action(setupRequest), {
          code: "server_unsupported",
        });
        assert.deepEqual(download.calls, []);
      },
    );
  });
}

for (const [label, overrides] of [
  ["WordPress 6.8", { wordpressVersion: "6.8.3" }],
  ["PHP 7.4", { phpVersion: "7.4" }],
]) {
  test(`sandywp setup refuses ${label} before any write`, async () => {
    await withSetup(
      [{ expected: `GET ${SITE}`, body: sandbox(overrides) }],
      async (client, server, download) => {
        await assert.rejects(client.action(setupRequest), {
          code: "server_unsupported",
        });
        assert.deepEqual(download.calls, []);
      },
    );
  });
}

test("sandywp setup lets the readiness check judge versions SandyWP does not report", async () => {
  await withSetup(
    [
      {
        expected: `GET ${SITE}`,
        body: sandbox({ wordpressVersion: null, phpVersion: "latest" }),
      },
      ...installRoutes().slice(1),
    ],
    async (client) => {
      const result = await client.action(setupRequest);
      assert.equal(result.raw.version, "1.12.4");
    },
  );
});

for (const [label, archive] of [
  ["not a ZIP", Buffer.from("<html>not a zip</html>")],
  [
    "no Novamira plugin file",
    zip({ "other/other.php": pluginHeader("1.0.0") }),
  ],
  [
    "no version header",
    zip({ "novamira/novamira.php": "<?php\n// Plugin Name: Novamira\n" }),
  ],
]) {
  test(`sandywp setup rejects an archive with ${label} before uploading`, async () => {
    await withSetup(
      [
        { expected: `GET ${SITE}`, body: sandbox() },
        { expected: LIST_PLUGINS, body: listing("index.php") },
      ],
      async (client) => {
        await assert.rejects(client.action(setupRequest), (error) => {
          assert.equal(error.code, "provider_error");
          return true;
        });
      },
      { archive },
    );
  });
}

test("sandywp setup rejects an invalid sandbox id and a cancelled request without calling out", async () => {
  await withSetup([], async (client, server, download) => {
    await assert.rejects(client.action({ ...setupRequest, envId: "" }), {
      code: "usage_error",
    });
    await assert.rejects(
      client.action({ ...setupRequest, signal: AbortSignal.abort() }),
    );
    assert.deepEqual(server.seen, []);
    assert.deepEqual(download.calls, []);
  });
});

/* -------------------------------------------------------------------------- */
/* The upload and the job                                                     */
/* -------------------------------------------------------------------------- */

test("sandywp setup surfaces the provider message when the role lacks the integrations capability", async () => {
  const routes = installRoutes().slice(0, 3);
  routes[2] = {
    ...routes[2],
    status: 403,
    body: JSON.stringify({
      error: {
        code: "capability_required",
        message: "Your role cannot install plugins.",
      },
    }),
  };
  await withSetup(routes, async (client) => {
    await assert.rejects(client.action(setupRequest), (error) => {
      assert.match(error.message, /cannot install plugins/);
      return true;
    });
  });
});

test("sandywp setup never repeats an upload whose outcome is unknown", async () => {
  const routes = installRoutes().slice(0, 3);
  routes[2] = {
    ...routes[2],
    status: 502,
    body: JSON.stringify({ error: { code: "bad_gateway", message: "x" } }),
  };
  await withSetup(routes, async (client, server) => {
    await assert.rejects(client.action(setupRequest));
    assert.equal(
      server.seen.filter((line) => line.startsWith("POST ")).length,
      1,
    );
  });
});

test("sandywp setup reports a failed job with SandyWP's reason", async () => {
  await withSetup(
    installRoutes({ jobs: [job("failed", "Plugin requires PHP 8.0")] }).slice(
      0,
      4,
    ),
    async (client) => {
      await assert.rejects(client.action(setupRequest), (error) => {
        assert.equal(error.code, "provider_error");
        assert.match(error.message, /Plugin requires PHP 8\.0/);
        return true;
      });
    },
  );
});

test("sandywp setup refuses an upload answer without a job id", async () => {
  const routes = installRoutes().slice(0, 3);
  routes[2] = { ...routes[2], body: JSON.stringify({ artifactId: "art_1" }) };
  await withSetup(routes, async (client) => {
    await assert.rejects(client.action(setupRequest), {
      code: "provider_error",
    });
  });
});

test("sandywp setup does not trust a finished job until the plugin is on disk", async () => {
  await withSetup(
    installRoutes({ after: listing("index.php") }),
    async (client) => {
      await assert.rejects(client.action(setupRequest), (error) => {
        assert.equal(error.code, "provider_error");
        assert.match(error.message, /could not be verified/);
        return true;
      });
    },
  );
});

test("sandywp setup refuses an unreadable plugin listing before writing", async () => {
  await withSetup(
    [
      { expected: `GET ${SITE}`, body: sandbox() },
      { expected: LIST_PLUGINS, body: JSON.stringify({ path: "x" }) },
    ],
    async (client, server, download) => {
      await assert.rejects(client.action(setupRequest), {
        code: "provider_error",
      });
      assert.deepEqual(download.calls, []);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* The archive header                                                         */
/* -------------------------------------------------------------------------- */

test("novamiraVersionFromArchive reads the plugin header and nothing else", () => {
  assert.equal(novamiraVersionFromArchive(ARCHIVE), "1.12.4");
  assert.equal(
    novamiraVersionFromArchive(
      zip({
        "novamira/novamira.php": "<?php\n * Version: 1.13.0-beta.1\n",
      }),
    ),
    "1.13.0-beta.1",
  );
  assert.equal(novamiraVersionFromArchive(Buffer.from("PK nope")), undefined);
  assert.equal(
    novamiraVersionFromArchive(
      zip({ "novamira/other.php": pluginHeader("9.9.9") }),
    ),
    undefined,
  );
});

/* -------------------------------------------------------------------------- */
/* Inside the setup flow                                                      */
/* -------------------------------------------------------------------------- */

test("setup runs SandyWP through the provider API flow and explains the AI Abilities step", async () => {
  const dependencies = {
    hostingProfile: "test",
    environment: {},
    client: {
      provider: "sandywp",
      action: async (request) => {
        assert.equal(request.kind, "setup-novamira");
        assert.equal(request.envId, "site_abc123");
        return {
          status: 200,
          raw: {
            siteUrl: "https://demo-abc.sandywp.app",
            version: "1.12.4",
            aiEnabled: null,
            warnings: [],
          },
        };
      },
    },
    fetch: async () => {
      throw new Error("offline");
    },
  };
  const result = await provisionNovamira(dependencies, {
    envId: "site_abc123",
    compatCheck: false,
  });
  assert.equal(result.ready, null);
  assert.equal(result.aiAbilities.enabled, false);
  assert.equal(result.plugin.version, "1.12.4");
  const notice = result.warnings.find(
    (warning) => warning.code === "ai_abilities_not_checked",
  );
  assert.match(
    notice?.message ?? "",
    /HQ does not enable AI Abilities on SandyWP/,
  );
  await assert.rejects(
    provisionNovamira(dependencies, { envId: "site_abc123" }),
    (error) => {
      assert.equal(error.code, "server_unsupported");
      assert.match(error.message, /enable AI Abilities/);
      assert.match(
        error.message,
        /HQ does not change these settings on SandyWP/,
      );
      return true;
    },
  );
});
