#!/usr/bin/env node
// Copies the workflow package's skills (packages/job-assistant/skills/<name>/)
// into this extension's source tree (extension/skills/<name>/) so that
// `eve extension build` packages them. Runs as the first half of `build`.
//
// Why a copy and not a reference: eve 0.63.0 rejects every way of pointing an
// extension at files outside its own package root. A symlinked skills
// directory or SKILL.md fails with "must be a regular file or directory", and
// an asset import (`?raw`) that leaves the package fails with "resolves
// outside package root". A defineSkill module cannot read the file either,
// because eve evaluates it from a bundle under node_modules/.cache.
//
// extension/skills/ is therefore generated and gitignored: the package's
// skills/ directory stays the one source of truth, and editing a skill never
// needs a second commit here. Never edit extension/skills/ by hand.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const adapterRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.resolve(adapterRoot, "../../skills");
const targetRoot = path.join(adapterRoot, "extension", "skills");

export function syncSkills({ from = sourceRoot, to = targetRoot } = {}) {
  if (!existsSync(from) || !statSync(from).isDirectory()) {
    throw new Error(`skills source not found: ${from}`);
  }
  const names = readdirSync(from, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(from, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) {
    throw new Error(`no <name>/SKILL.md directories under ${from}`);
  }
  // Start from an empty target so a skill removed from the package disappears here too.
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  for (const name of names) {
    // A real copy (dereference) of the whole skill directory: SKILL.md plus
    // any references/, assets/ or scripts/ siblings a later skill may add.
    cpSync(path.join(from, name), path.join(to, name), { recursive: true, dereference: true });
  }
  return names;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const names = syncSkills();
  process.stdout.write(`synced ${names.length} skills into extension/skills: ${names.join(", ")}\n`);
}
