// SPDX-FileCopyrightText: 2026 Ovation S.r.l. <dev@novamira.ai>
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Prints a version's CHANGELOG section as GitHub release notes, with each
 * wrapped list item joined onto one line.
 *
 *   node scripts/release-notes.mjs 1.0.0-beta7 [CHANGELOG.md]
 */

import { readFile } from "node:fs/promises";
import { argv, exit, stderr, stdout } from "node:process";

export function releaseNotes(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) =>
    new RegExp(
      `^## ${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`,
    ).test(line),
  );
  if (start < 0) return undefined;
  const length = lines
    .slice(start + 1)
    .findIndex((line) => line.startsWith("## "));
  const section = lines
    .slice(start + 1, length < 0 ? undefined : start + 1 + length)
    .join("\n")
    .trim()
    .replace(/\n {2}(?=\S)/g, " ");
  return section === "" ? undefined : `${section}\n`;
}

if (import.meta.url === `file://${argv[1]}`) {
  const [version, path = "CHANGELOG.md"] = argv.slice(2);
  const notes = version
    ? releaseNotes(await readFile(path, "utf8"), version)
    : undefined;
  if (notes === undefined) {
    stderr.write(`release-notes: no CHANGELOG section for ${version}\n`);
    exit(1);
  }
  stdout.write(notes);
}
