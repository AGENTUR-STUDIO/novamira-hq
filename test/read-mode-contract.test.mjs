// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import {
  createReadModeService,
  ENABLE_READ_MODE_ABILITY,
} from "../dist/pro/read-mode.js";
import { renderHtml } from "../dist/web/html.js";
import { renderReadModePage } from "../dist/web/views/read-mode.js";
import { renderProPage } from "../dist/web/views/pro.js";
import { renderSiteProfileRow } from "../dist/web/views/site-profiles.js";

/** A site behind the site CLI: what discovery reports and what the enable run returns. */
function fixture({
  readMode = { active: false },
  abilities = ["novamira/agent-context", ENABLE_READ_MODE_ABILITY],
  connected = true,
  enabled = { active: true },
} = {}) {
  const commands = [];
  const service = createReadModeService({
    profiles: async () => ({
      cliAvailable: true,
      profiles: [
        {
          name: "example",
          siteUrl: "https://example.com",
          state: connected ? "connected" : "reconnect_required",
        },
      ],
    }),
    operations: {
      execute: async (command) => {
        commands.push(command);
        if (command.kind === "discover")
          return {
            site: command.site,
            untrustedSiteData: true,
            data: {
              context: {
                instructions: "",
                ...(readMode === null ? {} : { read_mode: readMode }),
              },
              abilities: abilities.map((name) => ({ name })),
            },
          };
        return { site: command.site, untrustedSiteData: true, data: enabled };
      },
    },
  });
  return { service, commands };
}

test("Read Mode check reads one discovery and tells the four states apart", async () => {
  const ready = fixture();
  assert.equal(await ready.service.check("example"), "ready");
  assert.deepEqual(ready.commands, [{ kind: "discover", site: "example" }]);

  // Read mode on: the enable Ability is gone, and agent-context says why.
  assert.equal(
    await fixture({
      readMode: { active: true },
      abilities: ["novamira/agent-context"],
    }).service.check("example"),
    "active",
  );
  assert.equal(
    await fixture({ abilities: ["novamira/agent-context"] }).service.check(
      "example",
    ),
    "pro_required",
  );
  // A Novamira that does not report read mode cannot tell "already on" from "no Pro".
  assert.equal(
    await fixture({
      readMode: null,
      abilities: ["novamira/agent-context"],
    }).service.check("example"),
    "outdated",
  );
  assert.equal(
    await fixture({ readMode: null }).service.check("example"),
    "ready",
  );
});

test("Read Mode needs a connected site and never runs PHP", async () => {
  const disconnected = fixture({ connected: false });
  await assert.rejects(disconnected.service.check("example"), /Connect/);
  await assert.rejects(disconnected.service.check("other"), /Connect/);
  assert.equal(disconnected.commands.length, 0);

  const f = fixture();
  await f.service.enable("example");
  assert.deepEqual(f.commands, [
    { kind: "discover", site: "example" },
    {
      kind: "run",
      site: "example",
      ability: ENABLE_READ_MODE_ABILITY,
      input: {},
      approveDestructive: false,
    },
  ]);
  assert.ok(
    f.commands.every((command) => command.ability !== "novamira/execute-php"),
  );
});

test("Read Mode enable re-checks the site and requires its confirmation", async () => {
  const active = fixture({
    readMode: { active: true },
    abilities: ["novamira/agent-context"],
  });
  await assert.rejects(active.service.enable("example"), /no longer ready/);
  assert.equal(
    active.commands.some((command) => command.kind === "run"),
    false,
  );

  await assert.rejects(
    fixture({ enabled: { active: false } }).service.enable("example"),
    /did not confirm/,
  );
});

test("Read Mode page offers only turning it on, and says how to turn it off", () => {
  const empty = renderHtml(renderReadModePage({}));
  assert.match(empty, /Select a connected site/);
  assert.doesNotMatch(empty, /_dashboard\/read-mode/);

  const start = renderHtml(renderReadModePage({ site: "example" }));
  assert.match(start, /Check site/);
  assert.match(start, /_dashboard\/read-mode\/check\?site=example/);

  const ready = renderHtml(
    renderReadModePage({ site: "example", state: "ready" }),
  );
  assert.match(ready, /_dashboard\/read-mode\/enable\?site=example/);
  assert.match(ready, /not a security feature/);
  assert.match(ready, /wp novamira read-mode disable/);

  for (const view of [
    { site: "example", state: "active" },
    { site: "example", enabled: true },
  ]) {
    const markup = renderHtml(renderReadModePage(view));
    assert.match(markup, /Read Mode page in the Novamira menu/);
    assert.doesNotMatch(markup, /_dashboard\/read-mode\/enable/);
  }

  const pro = renderHtml(
    renderReadModePage({ site: "example", state: "pro_required" }),
  );
  assert.match(pro, /\/novamira-pro\?site=example/);
  assert.doesNotMatch(pro, /_dashboard\/read-mode\/enable/);

  const outdated = renderHtml(
    renderReadModePage({ site: "example", state: "outdated" }),
  );
  assert.match(outdated, /Update Novamira/);
  assert.doesNotMatch(outdated, /_dashboard\/read-mode\/enable/);

  for (const markup of [start, ready, pro, outdated])
    assert.doesNotMatch(markup, /read-mode\/disable|Turn off Read Mode/);
});

test("Read Mode is reached from the site menu and after installing Pro", () => {
  const row = renderHtml(
    renderSiteProfileRow({
      name: "example",
      siteUrl: "https://example.com",
      state: "connected",
    }),
  );
  assert.match(row, /href="\/read-mode\?site=example"/);
  assert.match(row, /Turn on Read Mode…/);

  const installed = renderHtml(
    renderProPage({
      site: "example",
      last4: "1234",
      message: "Pro is installed.",
    }),
  );
  assert.match(installed, /href="\/read-mode\?site=example"/);
});
