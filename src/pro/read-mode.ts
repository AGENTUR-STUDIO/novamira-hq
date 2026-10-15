// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

import { CliError } from "../errors.js";
import type { SiteOperations } from "../integration/index.js";
import { asRecord } from "../json.js";
import type { SiteProfileListing } from "../site-profiles.js";

/** Novamira Pro's Ability; registered only while read mode is off and the Pro license is active. */
export const ENABLE_READ_MODE_ABILITY = "novamira/enable-read-mode";

/**
 * What a site offers, read from one discovery:
 * - `active`: read mode is on (agent-context says so);
 * - `ready`: the enable Ability is available;
 * - `pro_required`: read mode is off but the Ability is missing, so Novamira Pro is missing,
 *   outdated or unlicensed;
 * - `outdated`: Novamira does not report read mode and the Ability is missing, so read mode
 *   may be on with an older Novamira, or Pro is missing.
 */
export type ReadModeState = "active" | "ready" | "pro_required" | "outdated";

export interface ReadModeView {
  readonly site?: string;
  readonly state?: ReadModeState;
  readonly enabled?: boolean;
}

export interface ReadModeService {
  check(site: string): Promise<ReadModeState>;
  enable(site: string): Promise<void>;
}

/** Turning read mode on goes only through the Ability; there is deliberately no way to turn it off. */
export function createReadModeService(options: {
  operations: SiteOperations;
  profiles: () => Promise<SiteProfileListing>;
}): ReadModeService {
  async function check(site: string): Promise<ReadModeState> {
    const listing = await options.profiles();
    const profile = listing.profiles.find((item) => item.name === site);
    if (!listing.cliAvailable || profile?.state !== "connected")
      throw new CliError(
        "usage_error",
        "Connect this site to Novamira before turning on Read Mode.",
      );
    const result = asRecord(
      await options.operations.execute({ kind: "discover", site }),
    );
    const data = asRecord(result?.data);
    const abilities = data?.abilities;
    if (!Array.isArray(abilities))
      throw new CliError(
        "provider_error",
        "The site did not return its abilities.",
      );
    const active = asRecord(asRecord(data?.context)?.read_mode)?.active;
    if (active === true) return "active";
    if (
      abilities.some(
        (ability) => asRecord(ability)?.name === ENABLE_READ_MODE_ABILITY,
      )
    )
      return "ready";
    return active === false ? "pro_required" : "outdated";
  }
  return {
    check,
    async enable(site) {
      if ((await check(site)) !== "ready")
        throw new CliError(
          "conflict",
          "The site is no longer ready to turn on Read Mode. Check the site again.",
        );
      const result = asRecord(
        await options.operations.execute({
          kind: "run",
          site,
          ability: ENABLE_READ_MODE_ABILITY,
          input: {},
          approveDestructive: false,
        }),
      );
      if (asRecord(result?.data)?.active !== true)
        throw new CliError(
          "provider_error",
          "The site did not confirm that Read Mode is on. Check the Read Mode page in the Novamira menu in WordPress.",
        );
    },
  };
}
