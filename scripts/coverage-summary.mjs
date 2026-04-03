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
import { readFileSync, writeFileSync } from "node:fs";

// Parse args
const args = process.argv.slice(2);
const lcovFile = args.find(a => !a.startsWith("--"));
const outputDir = args.filter(a => !a.startsWith("--"))[1] || ".";
const repoFlag = args.indexOf("--repo");
const shaFlag = args.indexOf("--sha");
const summaryFlag = args.indexOf("--job-summary");
const titleFlag = args.indexOf("--title");
const repo = repoFlag >= 0 ? args[repoFlag + 1] : null;
const sha = shaFlag >= 0 ? args[shaFlag + 1] : null;
const jobSummaryFile = summaryFlag >= 0 ? args[summaryFlag + 1] : null;
const title = titleFlag >= 0 ? args[titleFlag + 1] : "Combined Coverage Report";

if (!lcovFile) {
  console.error("Usage: node scripts/coverage-summary.mjs <lcov-file> [output-dir] [--repo owner/repo] [--sha sha]");
  process.exit(1);
}

const lcov = readFileSync(lcovFile, "utf8");

// Paths to include in the report (app source code only)
const INCLUDE = [
  /^lib\//,
  /^app\//,
  /^components\//,
  /^bin\//,
  /^\.next\/.*\/app\/api\/.*route\.(js|ts)$/,  // compiled route handlers (server V8 coverage)
];

function shouldInclude(path) {
  return INCLUDE.some((re) => re.test(path));
}

// Parse LCOV into per-file stats
const files = {};
let current = null;
let skip = false;
for (const line of lcov.split("\n")) {
  if (line.startsWith("SF:")) {
    const path = line.slice(3);
    if (shouldInclude(path)) {
      current = path;
      files[current] = { linesHit: 0, linesTotal: 0, fnHit: 0, fnTotal: 0, brHit: 0, brTotal: 0, uncoveredLines: [] };
      skip = false;
    } else {
      skip = true;
      current = null;
    }
  } else if (skip && line === "end_of_record") {
    skip = false;
  } else if (current && line.startsWith("DA:")) {
    const parts = line.slice(3).split(",");
    if (parts[1] === "0") files[current].uncoveredLines.push(+parts[0]);
  } else if (current && line.startsWith("LH:")) files[current].linesHit = +line.slice(3);
  else if (current && line.startsWith("LF:")) files[current].linesTotal = +line.slice(3);
  else if (current && line.startsWith("FNH:")) files[current].fnHit = +line.slice(4);
  else if (current && line.startsWith("FNF:")) files[current].fnTotal = +line.slice(4);
  else if (current && line.startsWith("BRH:")) files[current].brHit = +line.slice(4);
  else if (current && line.startsWith("BRF:")) files[current].brTotal = +line.slice(4);
  else if (current && line === "end_of_record") current = null;
}

// Collapse consecutive line numbers into ranges: [1,2,3,5,7,8] → "1-3, 5, 7-8"
function formatLineRanges(lines, repo, sha, filePath) {
  if (lines.length === 0) return "";
  const sorted = [...lines].sort((a, b) => a - b);
  const ranges = [];
  let start = sorted[0], end = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) {
      end = sorted[i];
    } else {
      ranges.push([start, end]);
      start = end = sorted[i];
    }
  }
  ranges.push([start, end]);

  // Limit to first 5 ranges to avoid huge cells
  const display = ranges.slice(0, 5);
  const more = ranges.length > 5 ? `, +${ranges.length - 5} more` : "";

  return display.map(([s, e]) => {
    const label = s === e ? `${s}` : `${s}-${e}`;
    if (repo && sha) {
      const path = filePath.startsWith("web/") ? filePath : `web/${filePath}`;
      return `[${label}](https://github.com/${repo}/blob/${sha}/${path}#L${s}-L${e})`;
    }
    return label;
  }).join(", ") + more;
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
  const uncovered = formatLineRanges(f.uncoveredLines, repo, sha, name);
  return `| ${icon} | ${fileRef(name)} | ${lp} | ${fp} | ${lp} | ${uncovered} |`;
}).join("\n");

const linesPct = tl > 0 ? (tlh / tl * 100) : 0;

console.log(`Coverage: ${linesPct.toFixed(1)}% lines (${tlh}/${tl}), ${sorted.length} files`);

// Job summary (for GitHub Actions $GITHUB_STEP_SUMMARY)
if (jobSummaryFile) {
  const fileRows = sorted.map(([name, f]) => {
    const lp = pct(f.linesHit, f.linesTotal);
    const fp = pct(f.fnHit, f.fnTotal);
    const bp = pct(f.brHit, f.brTotal);
    const ref = repo && sha
      ? `<a href="https://github.com/${repo}/blob/${sha}/web/${name}">${name}</a>`
      : name;
    const uncovered = [];
    // Note: LCOV line-level detail not available in summary, so just show percentages
    return `<tr><td>${ref}</td><td>${lp}</td><td>${bp}</td><td>${fp}</td><td>${lp}</td><td></td></tr>`;
  }).join("\n");

  const summary = `## ${title}

### Summary

- **Sources:** ${sources.length > 0 ? sources.join(", ") : "all available"}
- **Files:** ${sorted.length} total

| Metric | Percentage | Covered / Total |
|--------|-----------|-----------------|
| Lines | ${pct(tlh, tl)} | ${tlh} / ${tl} |
| Functions | ${pct(tfh, tf)} | ${tfh} / ${tf} |
| Branches | ${pct(tbh, tb)} | ${tbh} / ${tb} |

<details>
<summary>File Coverage</summary>

| | File | Stmts | Functions | Lines | Uncovered Lines |
|---|------|-------|-----------|-------|-----------------|
${rows}

</details>
`;
  writeFileSync(jobSummaryFile, summary);
  console.log(`Written: ${jobSummaryFile} (job summary)`);
}
