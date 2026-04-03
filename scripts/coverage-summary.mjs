#!/usr/bin/env node
/**
 * Parse an LCOV file and generate:
 *   - coverage-summary.json (totals + per-file table for PR comments)
 *   - badge.json (shields.io endpoint)
 *
 * Usage:
 *   node scripts/coverage-summary.mjs <lcov-file> [output-dir]
 *
 * Example:
 *   node scripts/coverage-summary.mjs combined.info pages-output
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const lcovFile = process.argv[2];
const outputDir = process.argv[3] || ".";

if (!lcovFile) {
  console.error("Usage: node scripts/coverage-summary.mjs <lcov-file> [output-dir]");
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
  return `| ${icon} | \`${name}\` | ${lp} | ${fp} | ${bp} |`;
}).join("\n");

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
}));

console.log(`Coverage: ${linesPct.toFixed(1)}% lines (${tlh}/${tl}), ${sorted.length} files`);
console.log(`Written: ${outputDir}/badge.json, ${outputDir}/coverage-summary.json`);
