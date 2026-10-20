// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * SandyWP provider contract test.
 *
 * The suite drives the client against a local `node:http` server on
 * 127.0.0.1:0 that asserts on the request line (`METHOD /path?query`), the
 * bearer key, the optional workspace header and a request-body substring. The
 * response shapes follow SandyWP's published OpenAPI document and the fields a
 * real account returned on a read-only check.
 *
 * Nothing here touches the network beyond loopback and no credential is real.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createHttpClient } from "../dist/hosting/http-client.js";
import { createSandyWpClient } from "../dist/hosting/providers/sandywp.js";

/** Obvious fakes. None of them may ever appear in an error, detail or result. */
const KEY = "not-a-real-sandywp-key";
const ADMIN_PASSWORD = "not-a-real-admin-password";
const MAGIC_LOGIN = "https://app.sandywp.com/magic/not-a-real-login-link";

const WORKSPACE_HEADER = "x-sandywp-workspace";

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/**
 * A mock SandyWP API. Every request is matched against the next queued route.
 * A route may also require headers (`headers`) or forbid them (`absentHeaders`).
 */
async function startSandyWp(routes) {
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
        failures.push(
          `authorization = ${String(request.headers.authorization)}, want Bearer ${KEY}`,
        );
      for (const [name, value] of Object.entries(route.headers ?? {})) {
        if (request.headers[name] !== value)
          failures.push(
            `header ${name} = ${String(request.headers[name])}, want ${value}`,
          );
      }
      for (const name of route.absentHeaders ?? []) {
        if (request.headers[name] !== undefined)
          failures.push(`header ${name} must be absent`);
      }
      if (route.bodyLike !== undefined && !body.includes(route.bodyLike))
        failures.push(
          `request body = ${body}, want substring ${route.bodyLike}`,
        );
      response.writeHead(route.status ?? 200, {
        "content-type": "application/json",
      });
      response.end(route.body ?? "");
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
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

/** A `ProviderClientContext` shaped exactly like `factory.ts` builds one. */
function sandyWpContext(baseUrl, overrides = {}) {
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
    createHttpClient: (httpOverrides) =>
      createHttpClient({
        baseUrl,
        providerLabel: "SandyWP",
        retry: { maxAttempts: 1 },
        ...httpOverrides,
      }),
    ...overrides,
  };
}

/** Runs `body` against a fresh mock server and always closes it. */
async function withSandyWp(routes, body, contextOverrides = {}) {
  const server = await startSandyWp(routes);
  try {
    const client = await createSandyWpClient(
      sandyWpContext(server.baseUrl, contextOverrides),
    );
    await body(client, server);
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

/** A sandbox as `GET /api/app/sites/{id}` and the create endpoint return it. */
function site(overrides = {}) {
  return {
    id: "site_abc123",
    name: "Demo",
    slug: "demo-abc",
    status: "ready",
    publicUrl: "https://demo-abc.sandywp.app",
    wordpressVersion: "7.0.4",
    phpVersion: "8.3",
    workerCode: "eu1",
    adminUsername: "admin",
    adminPassword: ADMIN_PASSWORD,
    magicLoginUrl: MAGIC_LOGIN,
    permanent: false,
    expiresAt: "2026-10-27T10:00:00.000Z",
    expirationMode: "fixed",
    idleTimeoutMinutes: null,
    createdAt: "2026-10-20T10:00:00.000Z",
    readyAt: "2026-10-20T10:00:30.000Z",
    failureReason: null,
    ...overrides,
  };
}

/** A list item: the same fields without the plaintext admin password. */
function listItem(overrides = {}) {
  const { adminPassword: _omitted, ...rest } = site(overrides);
  return rest;
}

const ME = JSON.stringify({
  id: "usr_1",
  email: "dev@example.com",
  activeWorkspace: { id: "ws_1", slug: "acme", name: "Acme" },
  workspaces: [
    {
      id: "ws_1",
      slug: "acme",
      name: "Acme",
      kind: "workspace",
      role: "owner",
    },
  ],
});

/* -------------------------------------------------------------------------- */
/* Validation and workspace                                                   */
/* -------------------------------------------------------------------------- */

test("sandywp validates the key and reports the active workspace", async () => {
  await withSandyWp(
    [
      {
        expected: "GET /api/account/me",
        absentHeaders: [WORKSPACE_HEADER],
        body: ME,
      },
    ],
    async (client) => {
      const validation = await client.validate();
      assert.equal(validation.provider, "sandywp");
      assert.equal(validation.status, "active");
      assert.equal(validation.companyId, "acme");
      assert.equal(validation.credential, "env:SANDYWP_API_KEY");
      assert.equal(client.provider, "sandywp");
    },
  );
});

test("sandywp keeps the profile workspace and sends it on every request", async () => {
  await withSandyWp(
    [
      {
        expected: "GET /api/account/me",
        headers: { [WORKSPACE_HEADER]: "team-b" },
        body: ME,
      },
      {
        expected: "GET /api/app/sites",
        headers: { [WORKSPACE_HEADER]: "team-b" },
        body: JSON.stringify({ sites: [] }),
      },
    ],
    async (client) => {
      const validation = await client.validate();
      assert.equal(validation.companyId, "team-b");
      assert.deepEqual(await client.listSites(), []);
    },
    { companyId: "team-b" },
  );
});

test("sandywp tolerates an account without an active workspace", async () => {
  await withSandyWp(
    [
      {
        expected: "GET /api/account/me",
        body: JSON.stringify({
          id: "usr_1",
          email: null,
          activeWorkspace: null,
          workspaces: [],
        }),
      },
    ],
    async (client) => {
      const validation = await client.validate();
      assert.equal(validation.status, "active");
      assert.equal(validation.companyId, null);
    },
  );
});

test("sandywp reports a rejected key as credential_invalid without leaking it", async () => {
  await withSandyWp(
    [
      {
        expected: "GET /api/account/me",
        status: 401,
        body: JSON.stringify({
          error: { code: "auth_required", message: "Sign in again." },
        }),
      },
    ],
    async (client) => {
      await assert.rejects(client.validate(), (error) => {
        assert.equal(error.code, "credential_invalid");
        assert.ok(!JSON.stringify(error).includes(KEY));
        assert.ok(!String(error.message).includes(KEY));
        return true;
      });
    },
  );
});

/* -------------------------------------------------------------------------- */
/* Sites and environments                                                     */
/* -------------------------------------------------------------------------- */

test("sandywp lists sandboxes without environments by default", async () => {
  await withSandyWp(
    [
      {
        expected: "GET /api/app/sites",
        body: JSON.stringify({ sites: [listItem()] }),
      },
    ],
    async (client) => {
      const sites = await client.listSites();
      assert.equal(sites.length, 1);
      const [first] = sites;
      assert.equal(first.id, "site_abc123");
      assert.equal(first.name, "Demo");
      assert.equal(first.displayName, "Demo");
      assert.equal(first.status, "active");
      assert.equal(first.primaryDomain, "demo-abc.sandywp.app");
      assert.equal(first.environments, undefined);
    },
  );
});

test("sandywp exposes each sandbox as one environment", async () => {
  await withSandyWp(
    [
      {
        expected: "GET /api/app/sites",
        body: JSON.stringify({ sites: [listItem()] }),
      },
    ],
    async (client) => {
      const [first] = await client.listSites({ includeEnvironments: true });
      assert.equal(first.environments?.length, 1);
      const [environment] = first.environments;
      assert.equal(environment.id, "site_abc123");
      assert.equal(environment.name, "site");
      assert.equal(environment.displayName, "Demo");
      assert.equal(environment.isBlocked, false);
      assert.equal(environment.isPremium, false);
      assert.equal(environment.wordpressVersion, "7.0.4");
      assert.equal(environment.primaryDomain, "demo-abc.sandywp.app");
    },
  );
});

test("sandywp maps every sandbox status and blocks the unusable ones", async () => {
  const cases = [
    ["creating", "pending", false],
    ["ready", "active", false],
    ["expired", "expired", true],
    ["failed", "failed", true],
    ["pending_delete", "deleted", true],
    ["deleted", "deleted", true],
    ["cleanup_failed", "deleted", true],
  ];
  await withSandyWp(
    [
      {
        expected: "GET /api/app/sites",
        body: JSON.stringify({
          sites: cases.map(([status], position) =>
            listItem({ id: `site_${String(position)}`, status }),
          ),
        }),
      },
    ],
    async (client) => {
      const sites = await client.listSites({ includeEnvironments: true });
      assert.deepEqual(
        sites.map((entry) => [entry.status, entry.environments[0].isBlocked]),
        cases.map(([, mapped, blocked]) => [mapped, blocked]),
      );
    },
  );
});

test("sandywp falls back to the slug and the id when a name is missing", async () => {
  await withSandyWp(
    [
      {
        expected: "GET /api/app/sites",
        body: JSON.stringify({
          sites: [
            listItem({ id: "site_1", name: "", slug: "only-slug" }),
            listItem({ id: "site_2", name: "", slug: "", publicUrl: "" }),
          ],
        }),
      },
    ],
    async (client) => {
      const [first, second] = await client.listSites();
      assert.equal(first.name, "only-slug");
      assert.equal(second.name, "site_2");
      assert.equal(second.primaryDomain, undefined);
    },
  );
});

test("sandywp reads one sandbox from the status envelope", async () => {
  await withSandyWp(
    [
      {
        expected: "GET /api/app/sites/site_abc123",
        body: JSON.stringify({ site: site(), events: [], jobs: [] }),
      },
    ],
    async (client) => {
      const found = await client.getSite("site_abc123");
      assert.equal(found.id, "site_abc123");
      assert.equal(found.environments?.length, 1);
      assert.equal(found.environments[0].id, "site_abc123");
      assert.ok(!JSON.stringify(found).includes(ADMIN_PASSWORD));
      assert.ok(!JSON.stringify(found).includes(MAGIC_LOGIN));
    },
  );
});

test("sandywp lists the environments of a sandbox", async () => {
  await withSandyWp(
    [
      {
        expected: "GET /api/app/sites/site_abc123",
        body: JSON.stringify({ site: site(), events: [], jobs: [] }),
      },
    ],
    async (client) => {
      const environments = await client.listEnvironments("site_abc123");
      assert.deepEqual(
        environments.map((environment) => environment.id),
        ["site_abc123"],
      );
    },
  );
});

test("sandywp escapes a sandbox id into one path segment", async () => {
  await withSandyWp(
    [
      {
        expected: "GET /api/app/sites/a%2Fb%3Fc",
        body: JSON.stringify({
          site: site({ id: "a/b?c" }),
          events: [],
          jobs: [],
        }),
      },
    ],
    async (client) => {
      await client.getSite("a/b?c");
    },
  );
});

/* -------------------------------------------------------------------------- */
/* Creation and operations                                                    */
/* -------------------------------------------------------------------------- */

test("sandywp creates a sandbox in the background and redacts its credentials", async () => {
  await withSandyWp(
    [
      {
        expected: "POST /api/app/sites",
        bodyLike: '"siteName":"Demo"',
        status: 202,
        body: JSON.stringify({ site: site({ status: "creating" }) }),
      },
    ],
    async (client, server) => {
      const result = await client.action({
        kind: "create-site",
        mode: "wordpress",
        body: { siteName: "Demo", phpVersion: "8.3" },
      });
      assert.equal(result.provider, "sandywp");
      assert.equal(result.action, "sites.create");
      assert.equal(result.status, 202);
      assert.equal(result.operationId, "site_abc123");
      const serialized = JSON.stringify(result);
      assert.ok(!serialized.includes(ADMIN_PASSWORD), serialized);
      assert.ok(!serialized.includes(MAGIC_LOGIN), serialized);
      assert.equal(result.raw.site.adminPassword, "redacted");
      assert.equal(result.raw.site.magicLoginUrl, "redacted");
      assert.equal(result.raw.site.adminUsername, "admin");
      assert.equal(result.raw.site.publicUrl, "https://demo-abc.sandywp.app");
      assert.deepEqual(server.failures, []);
    },
  );
});

test("sandywp asks SandyWP not to hold the request while it provisions", async () => {
  await withSandyWp(
    [
      {
        expected: "POST /api/app/sites",
        bodyLike: '"background":true',
        status: 202,
        body: JSON.stringify({ site: site({ status: "creating" }) }),
      },
    ],
    async (client) => {
      await client.action({ kind: "create-site", mode: "wordpress", body: {} });
    },
  );
});

test("sandywp promotes the generic site name options", async () => {
  await withSandyWp(
    [
      {
        expected: "POST /api/app/sites",
        bodyLike: '"siteName":"From CLI"',
        status: 202,
        body: JSON.stringify({ site: site({ status: "creating" }) }),
      },
      {
        expected: "POST /api/app/sites",
        bodyLike: '"siteName":"From display name"',
        status: 202,
        body: JSON.stringify({ site: site({ status: "creating" }) }),
      },
    ],
    async (client) => {
      await client.action({
        kind: "create-site",
        mode: "wordpress",
        body: { site_name: "From CLI" },
      });
      await client.action({
        kind: "create-site",
        mode: "plain",
        body: { display_name: "From display name" },
      });
    },
  );
});

test("sandywp names a template restore sites.clone and needs a template", async () => {
  await withSandyWp(
    [
      {
        expected: "POST /api/app/sites",
        bodyLike: '"templateId":"tpl_xyz789"',
        status: 202,
        body: JSON.stringify({ site: site({ status: "creating" }) }),
      },
    ],
    async (client, server) => {
      await assert.rejects(
        client.action({ kind: "create-site", mode: "clone", body: {} }),
        (error) => {
          assert.equal(error.code, "usage_error");
          assert.match(error.message, /templateId/);
          return true;
        },
      );
      assert.deepEqual(server.seen, []);
      const result = await client.action({
        kind: "create-site",
        mode: "clone",
        body: { templateId: "tpl_xyz789" },
      });
      assert.equal(result.action, "sites.clone");
    },
  );
});

test("sandywp names a plain creation sites.create-plain", async () => {
  await withSandyWp(
    [
      {
        expected: "POST /api/app/sites",
        status: 202,
        body: JSON.stringify({ site: site({ status: "creating" }) }),
      },
    ],
    async (client) => {
      const result = await client.action({
        kind: "create-site",
        mode: "plain",
        body: {},
      });
      assert.equal(result.action, "sites.create-plain");
    },
  );
});

test("sandywp rejects unknown creation fields before sending a request", async () => {
  await withSandyWp([], async (client, server) => {
    await assert.rejects(
      client.action({
        kind: "create-site",
        mode: "wordpress",
        body: { siteName: "Demo", sshKey: "x" },
      }),
      (error) => {
        assert.equal(error.code, "usage_error");
        assert.match(error.message, /sshKey/);
        return true;
      },
    );
    assert.deepEqual(server.seen, []);
  });
});

test("sandywp rejects a creation body that is not an object", async () => {
  await withSandyWp([], async (client) => {
    await assert.rejects(
      client.action({ kind: "create-site", mode: "wordpress", body: [] }),
      (error) => {
        assert.equal(error.code, "usage_error");
        return true;
      },
    );
  });
});

test("sandywp surfaces the provider message when the plan limit is reached", async () => {
  await withSandyWp(
    [
      {
        expected: "POST /api/app/sites",
        status: 402,
        body: JSON.stringify({
          error: {
            code: "plan_limit_reached",
            message: "Workspace is at its active-sandbox limit.",
            details: { plan: "free", limit: 2 },
          },
        }),
      },
    ],
    async (client) => {
      await assert.rejects(
        client.action({ kind: "create-site", mode: "wordpress", body: {} }),
        (error) => {
          assert.equal(error.code, "provider_error");
          assert.match(error.message, /active-sandbox limit/);
          return true;
        },
      );
    },
  );
});

test("sandywp reads a pending sandbox as an unfinished operation", async () => {
  await withSandyWp(
    [
      {
        expected: "GET /api/app/sites/site_abc123",
        body: JSON.stringify({
          site: site({ status: "creating" }),
          events: [],
          jobs: [],
        }),
      },
    ],
    async (client) => {
      const status = await client.operationStatus("site_abc123");
      assert.equal(status.provider, "sandywp");
      assert.equal(status.operationId, "site_abc123");
      assert.equal(status.done, false);
      assert.equal(status.failed, false);
      assert.ok(!JSON.stringify(status).includes(ADMIN_PASSWORD));
      assert.ok(!JSON.stringify(status).includes(MAGIC_LOGIN));
    },
  );
});

test("sandywp reads a ready sandbox as a finished operation", async () => {
  await withSandyWp(
    [
      {
        expected: "GET /api/app/sites/site_abc123",
        body: JSON.stringify({ site: site(), events: [], jobs: [] }),
      },
    ],
    async (client) => {
      const status = await client.operationStatus("site_abc123");
      assert.equal(status.done, true);
      assert.equal(status.failed, false);
    },
  );
});

test("sandywp reports why a sandbox failed to provision", async () => {
  await withSandyWp(
    [
      {
        expected: "GET /api/app/sites/site_abc123",
        body: JSON.stringify({
          site: site({
            status: "failed",
            failureReason: "Worker ran out of capacity.",
          }),
          events: [],
          jobs: [],
        }),
      },
    ],
    async (client) => {
      const status = await client.operationStatus("site_abc123");
      assert.equal(status.done, true);
      assert.equal(status.failed, true);
      assert.equal(status.message, "Worker ran out of capacity.");
    },
  );
});

/* -------------------------------------------------------------------------- */
/* Capabilities and the deliberate gaps                                       */
/* -------------------------------------------------------------------------- */

test("sandywp publishes only the operations it implements", async () => {
  await withSandyWp([], async (client) => {
    const capabilities = await client.read({ kind: "capabilities" });
    const supported = capabilities
      .filter((capability) => capability.supported)
      .map((capability) => capability.name)
      .sort();
    assert.deepEqual(supported, [
      "envs.get",
      "envs.list",
      "novamira.setup",
      "ops.get",
      "ops.wait",
      "providers.capabilities",
      "providers.validate",
      "sites.clone",
      "sites.create",
      "sites.create-plain",
      "sites.get",
      "sites.list",
    ]);
  });
});

test("sandywp reports its deliberate gaps as provider_unsupported", async () => {
  await withSandyWp([], async (client, server) => {
    for (const request of [
      { kind: "backups", envId: "site_abc123" },
      { kind: "logs", envId: "site_abc123", fileName: "debug.log", lines: 5 },
      { kind: "site-domains", envId: "site_abc123" },
      { kind: "plugins", envId: "site_abc123" },
    ]) {
      await assert.rejects(client.read(request), (error) => {
        assert.equal(error.code, "provider_unsupported");
        return true;
      });
    }
    for (const request of [
      { kind: "run-wp-cli", envId: "site_abc123", body: {} },
      { kind: "create-backup", envId: "site_abc123", body: {} },
      { kind: "restore-backup", targetEnvId: "site_abc123", body: {} },
      { kind: "add-domain", envId: "site_abc123", body: {} },
      { kind: "create-environment", siteId: "x", mode: "wordpress", body: {} },
      { kind: "push-environment", siteId: "x", body: {} },
      { kind: "set-php-version", body: {} },
    ]) {
      await assert.rejects(client.action(request), (error) => {
        assert.equal(error.code, "provider_unsupported");
        return true;
      });
    }
    assert.deepEqual(server.seen, []);
  });
});
