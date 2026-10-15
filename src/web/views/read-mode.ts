// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ReadModeView } from "../../pro/read-mode.js";
import { html, hrefAttr, url, type Html } from "../html.js";
import { post } from "../expr.js";
import { pageHeader, actionButton } from "./components.js";

const TURN_OFF =
  "Only a WordPress administrator can turn it off, on the Read Mode page in the Novamira menu or with wp novamira read-mode disable.";

function body(view: ReadModeView & { site: string }): Html {
  const params = { site: view.site };
  if (view.enabled)
    return html`<h3>Read Mode is on</h3><p role="status">AI agents connected to this site can now only read it.</p><p>${TURN_OFF}</p>`;
  switch (view.state) {
    case "active":
      return html`<h3>Read Mode is already on</h3><p>${TURN_OFF}</p>`;
    case "pro_required":
      return html`<h3>Novamira Pro is required</h3><p>Turning on Read Mode from Novamira HQ needs an up-to-date Novamira Pro with an active license.</p><div><a class="button secondary"${hrefAttr(url("/novamira-pro", params))}>Install Novamira Pro…</a></div>`;
    case "outdated":
      return html`<h3>Update Novamira</h3><p>This site does not report whether Read Mode is on. Update Novamira and Novamira Pro, or check the Read Mode page in the Novamira menu in WordPress.</p>`;
    case "ready":
      return html`<h3>Turn on Read Mode</h3><ul><li>AI agents keep only the abilities that read the site: they cannot change content, files or settings, or run PHP or WP-CLI.</li><li>${TURN_OFF}</li><li>Read Mode is not a security feature: it limits what Novamira offers an agent, not what an administrator can do.</li></ul><div>${actionButton({ label: "Turn on Read Mode", action: post(url("/_dashboard/read-mode/enable", params), { include: [] }), busy: "proForm.busy", pending: "Turning on Read Mode…", inlinePending: true })}</div>`;
    default:
      return html`<p>Read Mode lets AI agents inspect this site without changing it.</p><p>Check whether this site can turn it on.</p><div>${actionButton({ label: "Check site", action: post(url("/_dashboard/read-mode/check", params), { include: [] }), busy: "proForm.busy", pending: "Checking site…", inlinePending: true })}</div>`;
  }
}

export function renderReadModePage(view: ReadModeView): Html {
  return html`<section class="page flow-page">${pageHeader("Read Mode", { description: "Let AI agents read a WordPress site without changing it. Requires Novamira Pro.", back: { label: "Back to Sites", href: url("/sites") } })}<section class="panel">${view.site === undefined ? html`<div class="form-grid"><p>Select a connected site from Sites to turn on Read Mode.</p></div>` : html`<div class="panel-head"><div><h2>${view.site}</h2><p>Novamira Read Mode</p></div></div><div class="form-grid">${body({ ...view, site: view.site })}</div>`}</section></section>`;
}
