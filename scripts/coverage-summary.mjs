#!/usr/bin/env node
/**
 * Parse an LCOV file and generate:
 *   - coverage-summary.json (totals + per-file table for PR comments)
 *   - badge.json (shields.io endpoint)
 *
 * Usage:
 *   node scripts/coverage-summary.mjs <lcov-file> [output-dir] [--repo owner/repo] [--sha commit-sha]
 *
 * Examples:
 *   node scripts/coverage-summary.mjs combined.info pages-output
 *   node scripts/coverage-summary.mjs combined.info pages-output --repo mandric/sitemgr --sha abc123
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";

// Parse args
const args = process.argv.slice(2);
const lcovFile = args.find(a => !a.startsWith("--"));
const outputDir = args.filter(a => !a.startsWith("--"))[1] || ".";
const repoFlag = args.indexOf("--repo");
const shaFlag = args.indexOf("--sha");
const repo = repoFlag >= 0 ? args[repoFlag + 1] : null;
const sha = shaFlag >= 0 ? args[shaFlag + 1] : null;

if (!lcovFile) {
  console.error("Usage: node scripts/coverage-summary.mjs <lcov-file> [output-dir] [--repo owner/repo] [--sha sha]");
  process.exit(1);
}

const lcov = readFileSync(lcovFile, "utf8");

// Parse LCOV into per-file stats
const files = {};
let current = null;
for (const line of lcov.split("\n")) {
  if (line.startsWith("SF:")) {
    current = line.slice(3);
    files[current] = { linesHit: 0, linesTotal: 0, fnHit: 0, fnTotal: 0, brHit: 0, brTotal: 0 };
  } else if (current && line.startsWith("LH:")) files[current].linesHit = +line.slice(3);
  else if (current && line.startsWith("LF:")) files[current].linesTotal = +line.slice(3);
  else if (current && line.startsWith("FNH:")) files[current].fnHit = +line.slice(4);
  else if (current && line.startsWith("FNF:")) files[current].fnTotal = +line.slice(4);
  else if (current && line.startsWith("BRH:")) files[current].brHit = +line.slice(4);
  else if (current && line.startsWith("BRF:")) files[current].brTotal = +line.slice(4);
  else if (line === "end_of_record") current = null;
}

// Totals
let tl = 0, tlh = 0, tf = 0, tfh = 0, tb = 0, tbh = 0;
for (const f of Object.values(files)) {
  tl += f.linesTotal; tlh += f.linesHit;
  tf += f.fnTotal; tfh += f.fnHit;
  tb += f.brTotal; tbh += f.brHit;
}
const pct = (n, d) => d > 0 ? (n / d * 100).toFixed(1) + "%" : "N/A";

// Build file link (GitHub blob URL if repo+sha provided, otherwise just code block)
function fileRef(name) {
  if (repo && sha) {
    // Files are relative to web/, so prefix with web/ for the GitHub URL
    const path = name.startsWith("web/") ? name : `web/${name}`;
    return `[\`${name}\`](https://github.com/${repo}/blob/${sha}/${path})`;
  }
  return `\`${name}\``;
}

// Build file table rows sorted by line coverage ascending (worst first)
const sorted = Object.entries(files).sort((a, b) => {
  const pa = a[1].linesTotal > 0 ? a[1].linesHit / a[1].linesTotal : 1;
  const pb = b[1].linesTotal > 0 ? b[1].linesHit / b[1].linesTotal : 1;
  return pa - pb;
});
const rows = sorted.map(([name, f]) => {
  const lp = pct(f.linesHit, f.linesTotal);
  const fp = pct(f.fnHit, f.fnTotal);
  const bp = pct(f.brHit, f.brTotal);
  const icon = f.linesTotal === 0 ? "⚪" : f.linesHit / f.linesTotal >= 0.8 ? "🟢" : f.linesHit / f.linesTotal >= 0.5 ? "🟡" : "🔴";
  return `| ${icon} | ${fileRef(name)} | ${lp} | ${fp} | ${bp} |`;
}).join("\n");

// Detect which input LCOV sources contributed (check for well-known artifact dirs)
const sources = [];
for (const dir of ["unit-coverage", "integration-coverage", "e2e-cli-coverage", "e2e-web-coverage"]) {
  try {
    const entries = readdirSync(dir);
    if (entries.includes("lcov.info")) {
      sources.push(dir.replace("-coverage", ""));
    }
  } catch { /* dir doesn't exist */ }
}

// Badge
const linesPct = tl > 0 ? (tlh / tl * 100) : 0;
const color = linesPct >= 80 ? "brightgreen" : linesPct >= 60 ? "green" : linesPct >= 40 ? "yellow" : linesPct >= 20 ? "orange" : "red";

// Write outputs
mkdirSync(outputDir, { recursive: true });

writeFileSync(`${outputDir}/badge.json`, JSON.stringify({
  schemaVersion: 1, label: "coverage", message: linesPct.toFixed(1) + "%", color,
}));

writeFileSync(`${outputDir}/coverage-summary.json`, JSON.stringify({
  lines: pct(tlh, tl),
  functions: pct(tfh, tf),
  branches: pct(tbh, tb),
  fileTable: rows,
  fileCount: sorted.length,
  sources,
}));

console.log(`Coverage: ${linesPct.toFixed(1)}% lines (${tlh}/${tl}), ${sorted.length} files`);
console.log(`Sources: ${sources.length > 0 ? sources.join(", ") : "unknown"}`);
console.log(`Written: ${outputDir}/badge.json, ${outputDir}/coverage-summary.json`);
