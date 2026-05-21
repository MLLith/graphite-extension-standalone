#!/usr/bin/env node
// Downloads the Graphite GTI VSCode extension as a .vsix from open-vsx and
// extracts the runtime bits (extension bundle, native binding, webview assets,
// package.json, resources) into ./graphite/. Runs as part of `npm run build`.
//
// Usage:
//   node scripts/fetch-graphite.mjs              # download + extract if missing
//   FORCE=1 node scripts/fetch-graphite.mjs      # re-download even if present
//   GRAPHITE_VERSION=0.7.82 node scripts/fetch-graphite.mjs
//   GRAPHITE_TARGET=darwin-arm64 node ...        # override platform target

import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

// Pinned: newer GTI versions may add vscode-API surface our shim doesn't
// cover (or rename the .settings-dropdown class the standalone client hooks
// into). Bump and test before changing the default.
const VERSION = process.env.GRAPHITE_VERSION ?? "0.7.82";

const SUPPORTED_TARGETS = new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-x64",
]);

function detectTarget() {
  if (process.env.GRAPHITE_TARGET) return process.env.GRAPHITE_TARGET;
  const t = `${process.platform}-${process.arch}`;
  if (!SUPPORTED_TARGETS.has(t)) {
    throw new Error(
      `no published Graphite .vsix for ${t}. ` +
        `Supported: ${[...SUPPORTED_TARGETS].join(", ")}. ` +
        `Override with GRAPHITE_TARGET=<one-of-those>.`,
    );
  }
  return t;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "graphite");
const marker = join(dest, ".version");

if (existsSync(join(dest, "dist", "extension.js")) && !process.env.FORCE) {
  console.log(
    `graphite bundle already present at ${dest} — skipping ` +
      `(set FORCE=1 to redownload, or delete graphite/)`,
  );
  process.exit(0);
}

const target = detectTarget();
const url =
  `https://open-vsx.org/api/Graphite/gti-vscode/${target}/${VERSION}/` +
  `file/Graphite.gti-vscode-${VERSION}@${target}.vsix`;

console.log(`fetching ${url}`);
// open-vsx's CDN returns 429 for requests with no User-Agent, so set one.
const res = await fetch(url, {
  headers: { "user-agent": "graphite-extension-standalone/0.1.0 (build script)" },
});
if (!res.ok) {
  throw new Error(`download failed: HTTP ${res.status} ${res.statusText}`);
}
const buf = Buffer.from(await res.arrayBuffer());
console.log(`downloaded ${(buf.length / 1024 / 1024).toFixed(1)} MB`);

await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });

// Extract everything under extension/ that the host might need at runtime.
// The vsix also contains a vsixmanifest, [Content_Types].xml, and large
// sourcemaps that we skip.
const INCLUDE_PREFIXES = ["extension/dist/", "extension/resources/"];
const INCLUDE_EXACT = new Set([
  "extension/package.json",
  "extension/README.md",
  "extension/LICENSE",
  "extension/LICENSE.txt",
]);
const EXCLUDE_SUFFIX = [".map"];
// The vsix bundles better-sqlite3 with prebuilts for a narrow set of Node
// ABIs that current Nodes generally don't match. We install our own and the
// server.ts module-loader patch redirects `require("better-sqlite3")` to it,
// so we can skip the (~10 MB) vendored copy entirely.
const EXCLUDE_PREFIXES = ["extension/dist/node_modules/better-sqlite3/"];

const zip = new AdmZip(buf);
let count = 0;
let bytes = 0;
for (const entry of zip.getEntries()) {
  if (entry.isDirectory) continue;
  const name = entry.entryName;
  const included = INCLUDE_EXACT.has(name) || INCLUDE_PREFIXES.some((p) => name.startsWith(p));
  if (!included) continue;
  if (EXCLUDE_SUFFIX.some((s) => name.endsWith(s))) continue;
  if (EXCLUDE_PREFIXES.some((p) => name.startsWith(p))) continue;

  const rel = name.replace(/^extension\//, "");
  const out = join(dest, rel);
  // eslint-disable-next-line no-await-in-loop -- Keep extraction simple and bounded instead of launching all writes at once.
  await mkdir(dirname(out), { recursive: true });
  const data = entry.getData();
  // eslint-disable-next-line no-await-in-loop -- Keep extraction simple and bounded instead of launching all writes at once.
  await writeFile(out, data);
  count++;
  bytes += data.length;
}

await writeFile(
  marker,
  JSON.stringify({ version: VERSION, target, fetchedAt: new Date().toISOString() }, null, 2),
);

if (count === 0) {
  throw new Error(
    `vsix downloaded but no expected entries matched. The archive layout may ` +
      `have changed since v${VERSION}.`,
  );
}

console.log(
  `extracted ${count} files (${(bytes / 1024 / 1024).toFixed(1)} MB) into ${dest} ` +
    `(version ${VERSION}, target ${target})`,
);
