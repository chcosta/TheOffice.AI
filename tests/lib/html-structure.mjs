// HTML structural-balance checker for TheOffice.AI's single-file SPA.
//
// public/app.html is a ~1.8MB hand-authored Alpine.js SPA. A single stray or
// missing container tag (a rogue </div>, an unbalanced <template>/<section>)
// silently re-parents large swaths of the DOM at browser parse time — e.g. the
// bug where a dropped `<div class="mr-metrics">` open let a trailing </div>
// close .content-inner early and ejected ~17 route sections below the fold.
//
// `node -c` / _syntax.mjs only validate inline <script> JS — they do NOT see
// HTML tag imbalance. This checker fills that gap: it walks the markup with a
// real, quote-aware tokenizer and verifies every structural container element
// is explicitly and correctly balanced.
//
// Why a custom tokenizer instead of a DOM lib:
//   * Attribute values here routinely contain `>` and `<` inside JS expressions
//     (x-show="count > 0", :class="a < b ? .."), so a naive /<[^>]*>/ split is
//     wrong. We scan attributes respecting ' and " quotes.
//   * <script>/<style>/<textarea> hold raw text (including `<div>`-looking
//     strings); their contents must be skipped.
//   * <template> contents are an inert document fragment at parse time, and this
//     SPA legitimately interleaves <div>/<template> in ways the HTML tree
//     construction algorithm tolerates. So instead of a strict cross-type stack
//     (which false-positives on that interleaving), we verify each structural
//     tag TYPE is COUNT-balanced with a running depth that never goes negative —
//     precisely the invariant a missing/stray tag violates.

// Elements that never have children / are always self-contained.
const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// Elements whose content is raw text (no nested tag parsing).
const RAWTEXT = new Set(['script', 'style', 'textarea', 'title']);

// Only these container tags are subject to the strict balanced-stack check.
// They are the structural elements this codebase always closes explicitly, and
// the ones whose imbalance corrupts layout. Restricting the check to this set
// avoids false positives from HTML's optional-close elements (<p>, <li>, <tr>,
// <td>, <option>, …) which the browser auto-closes and this file may leave open.
const STRUCTURAL = new Set([
  'div', 'section', 'template', 'main', 'header', 'footer',
  'nav', 'aside', 'form', 'table', 'ul', 'ol',
]);

function lineColAt(src, idx) {
  let line = 1, last = 0;
  for (let i = 0; i < idx; i++) {
    if (src[i] === '\n') { line++; last = i + 1; }
  }
  return { line, col: idx - last + 1 };
}

// Tokenize `src` into a flat list of tag events, quote- and rawtext-aware.
// Returns [{ kind:'open'|'close'|'selfclose', tag, index }].
export function tokenizeTags(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    const next = src[lt + 1];

    // Not a markup start (e.g. text "a < b") — treat `<` as literal, move on.
    if (!next || !/[a-zA-Z/!]/.test(next)) { i = lt + 1; continue; }

    // Comment or CDATA/declaration.
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (next === '!') { // doctype / declaration
      const end = src.indexOf('>', lt + 1);
      i = end < 0 ? n : end + 1;
      continue;
    }

    const isClose = next === '/';
    const nameStart = lt + (isClose ? 2 : 1);
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9:-]*/.exec(src.slice(nameStart));
    if (!nameMatch) { i = lt + 1; continue; }
    const tag = nameMatch[0].toLowerCase();

    // Find the tag's closing `>`, honoring quoted attribute values that may
    // themselves contain `>` or `<` (JS expressions in Alpine directives).
    let j = nameStart + nameMatch[0].length;
    let quote = null;
    let selfClose = false;
    for (; j < n; j++) {
      const c = src[j];
      if (quote) { if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '>') {
        if (src[j - 1] === '/') selfClose = true;
        break;
      }
    }
    const tagEnd = j; // index of '>'

    if (isClose) {
      tokens.push({ kind: 'close', tag, index: lt });
    } else if (VOID.has(tag) || selfClose) {
      tokens.push({ kind: 'selfclose', tag, index: lt });
    } else if (RAWTEXT.has(tag)) {
      // Skip raw-text content to the matching close tag.
      const closeRe = new RegExp(`</${tag}\\b`, 'i');
      const rest = src.slice(tagEnd + 1);
      const rel = rest.search(closeRe);
      tokens.push({ kind: 'open', tag, index: lt });
      tokens.push({ kind: 'close', tag, index: tagEnd + 1 + (rel < 0 ? 0 : rel) });
      i = rel < 0 ? n : tagEnd + 1 + rel;
      continue;
    } else {
      tokens.push({ kind: 'open', tag, index: lt });
    }
    i = tagEnd + 1;
  }
  return tokens;
}

// Run the structural-balance check. For each structural container tag TYPE we
// track a running depth across the document in source order and assert two
// invariants:
//   (a) depth never goes negative — a close before any matching open means a
//       stray/premature close tag (the browser would silently drop it, then a
//       LATER legitimate-looking close ends up terminating an ancestor early —
//       exactly the .content-inner ejection bug).
//   (b) depth ends at exactly zero — equal opens and closes, so nothing is left
//       dangling or doubly-closed.
//
// We deliberately track each tag type INDEPENDENTLY rather than a single
// cross-type stack: this SPA legitimately interleaves <div>/<template> in ways
// the HTML tree-construction algorithm tolerates and repairs, so a strict
// cross-type stack yields false positives. A missing/extra tag — the class of
// bug that actually corrupts layout — is always a per-type COUNT imbalance,
// which this catches precisely.
//
// Returns { ok, errors:[{line,col,tag,message}], counts:{tag:{open,close}} }.
export function checkHtmlStructure(src) {
  const tokens = tokenizeTags(src);
  const errors = [];
  const depth = {};            // tag -> current running depth
  const counts = {};           // tag -> { open, close }
  const wentNegative = {};     // tag -> true once reported (avoid spam)

  for (const t of STRUCTURAL) { depth[t] = 0; counts[t] = { open: 0, close: 0 }; }

  for (const tk of tokens) {
    if (!STRUCTURAL.has(tk.tag)) continue;
    if (tk.kind === 'open') {
      depth[tk.tag]++;
      counts[tk.tag].open++;
    } else if (tk.kind === 'close') {
      depth[tk.tag]--;
      counts[tk.tag].close++;
      if (depth[tk.tag] < 0 && !wentNegative[tk.tag]) {
        wentNegative[tk.tag] = true;
        const { line, col } = lineColAt(src, tk.index);
        errors.push({
          line, col, tag: tk.tag,
          message: `stray/premature </${tk.tag}> — closed more <${tk.tag}> than were opened at this point (a missing <${tk.tag}> open or an extra </${tk.tag}>)`,
        });
      }
    }
  }

  for (const tag of STRUCTURAL) {
    const c = counts[tag];
    if (c.open !== c.close) {
      errors.push({
        line: 0, col: 0, tag,
        message: `<${tag}> is unbalanced: ${c.open} opened vs ${c.close} closed (delta ${c.open - c.close})`,
      });
    }
  }

  return { ok: errors.length === 0, errors, counts };
}
