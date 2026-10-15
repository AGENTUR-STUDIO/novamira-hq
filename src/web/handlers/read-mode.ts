// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { asCliError, CliError } from "../../errors.js";
import type { ReadModeView } from "../../pro/read-mode.js";
import { isSiteProfileName } from "../../site-profiles.js";
import { patchPage, patchToast } from "../patch.js";
import { defaultDashboardSignals } from "../signals.js";
import type { RouteContext, RouteHandler } from "../routes.js";

/** The page's site, from the query: a valid profile name or none. */
export function readModeSite(site: string | null): ReadModeView {
  return site !== null && isSiteProfileName(site) ? { site } : {};
}

export function createReadModeHandler(
  context: RouteContext,
  action: "check" | "enable",
): RouteHandler {
  return (request) => ({
    kind: "sse",
    run: async (stream) => {
      try {
        const { site } = readModeSite(request.query.get("site"));
        if (site === undefined)
          throw new CliError("usage_error", "Choose a connected site.");
        if (!context.pro)
          throw new CliError(
            "provider_unsupported",
            "Read Mode is unavailable in this instance.",
          );
        let readMode: ReadModeView;
        if (action === "check")
          readMode = { site, state: await context.pro.readMode.check(site) };
        else {
          await context.pro.readMode.enable(site);
          readMode = { site, enabled: true };
        }
        const notice = { level: "neutral" as const, message: "" };
        patchPage(stream, {
          page: "read-mode",
          notice,
          model: {
            view: await context.loadConfigView(),
            notice,
            signals: defaultDashboardSignals(context.token),
            readMode,
          },
        });
      } catch (error) {
        stream.patchSignals({ proForm: { busy: false } });
        patchToast(stream, {
          level: "danger",
          message: asCliError(error).message,
        });
      }
      stream.close();
    },
  });
}
