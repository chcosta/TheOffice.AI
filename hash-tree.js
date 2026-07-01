'use strict';

// Shared, dependency-free file-tree hashing used by the desktop delta-update
// pipeline:
//   - desktop/scripts/stage-sidecar.mjs  bakes a server-manifest.json at build time
//   - desktop/scripts/build-delta.mjs    diffs two manifests to build a delta zip
//   - apply-update.js                    verifies staged files before applying
//   - updater.js                         diffs the local manifest vs the new one
//
// A manifest is: { version, commit, generatedAt, files: { "<rel>": {sha256, size} } }
// Relative paths always use forward slashes so a manifest is portable/stable.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256File(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

// Recursively list files under `dir` as forward-slash relative paths.
// `exclude(rel)` may skip a file or directory (tested per-entry).
function listFiles(dir, exclude) {
  const out = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const abs = rel ? path.join(dir, rel) : dir;
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (exclude && exclude(childRel)) continue;
      if (e.isDirectory()) stack.push(childRel);
      else if (e.isFile()) out.push(childRel);
    }
  }
  out.sort();
  return out;
}

// Build a manifest { files: { rel: {sha256,size} } } over `dir`.
function hashTree(dir, opts = {}) {
  const exclude = opts.exclude || null;
  const files = {};
  for (const rel of listFiles(dir, exclude)) {
    const abs = path.join(dir, rel);
    let size = 0;
    try { size = fs.statSync(abs).size; } catch { /* ignore */ }
    files[rel] = { sha256: sha256File(abs), size };
  }
  return { files };
}

// Compare two manifests' file maps -> { changed:[rel], added:[rel], deleted:[rel] }
// `changed` = present in both with a different sha; `added` = only in next;
// `deleted` = only in prev.
function diffManifests(prev, next) {
  const pf = (prev && prev.files) || {};
  const nf = (next && next.files) || {};
  const changed = [];
  const added = [];
  const deleted = [];
  for (const rel of Object.keys(nf)) {
    if (!(rel in pf)) added.push(rel);
    else if (pf[rel].sha256 !== nf[rel].sha256) changed.push(rel);
  }
  for (const rel of Object.keys(pf)) {
    if (!(rel in nf)) deleted.push(rel);
  }
  changed.sort(); added.sort(); deleted.sort();
  return { changed, added, deleted };
}

module.exports = { sha256File, hashTree, listFiles, diffManifests, toPosix };
