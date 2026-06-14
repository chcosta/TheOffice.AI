'use strict';

// Windows console apps (like the copilot CLI) frequently emit UTF-8 bytes that
// get reinterpreted through the legacy OEM code page (CP437) before reaching a
// pipe. The result is classic mojibake, e.g. the bullet "●" (UTF-8 E2 97 8F)
// shows up as "ΓùÅ" and the box char "│" (E2 94 82) shows up as "Γöé".
//
// repairConsoleMojibake reverses that transformation deterministically: it maps
// each character back to the CP437 byte it came from, then decodes the byte
// sequence as UTF-8. The mapping is only applied when it round-trips cleanly, so
// legitimate text (plain ASCII, or genuinely CP437-only content) is left intact.

// CP437 -> Unicode code point for bytes 0x80..0xFF.
const CP437_HIGH = [
  0x00C7, 0x00FC, 0x00E9, 0x00E2, 0x00E4, 0x00E0, 0x00E5, 0x00E7,
  0x00EA, 0x00EB, 0x00E8, 0x00EF, 0x00EE, 0x00EC, 0x00C4, 0x00C5,
  0x00C9, 0x00E6, 0x00C6, 0x00F4, 0x00F6, 0x00F2, 0x00FB, 0x00F9,
  0x00FF, 0x00D6, 0x00DC, 0x00A2, 0x00A3, 0x00A5, 0x20A7, 0x0192,
  0x00E1, 0x00ED, 0x00F3, 0x00FA, 0x00F1, 0x00D1, 0x00AA, 0x00BA,
  0x00BF, 0x2310, 0x00AC, 0x00BD, 0x00BC, 0x00A1, 0x00AB, 0x00BB,
  0x2591, 0x2592, 0x2593, 0x2502, 0x2524, 0x2561, 0x2562, 0x2556,
  0x2555, 0x2563, 0x2551, 0x2557, 0x255D, 0x255C, 0x255B, 0x2510,
  0x2514, 0x2534, 0x252C, 0x251C, 0x2500, 0x253C, 0x255E, 0x255F,
  0x255A, 0x2554, 0x2569, 0x2566, 0x2560, 0x2550, 0x256C, 0x2567,
  0x2568, 0x2564, 0x2565, 0x2559, 0x2558, 0x2552, 0x2553, 0x256B,
  0x256A, 0x2518, 0x250C, 0x2588, 0x2584, 0x258C, 0x2590, 0x2580,
  0x03B1, 0x00DF, 0x0393, 0x03C0, 0x03A3, 0x03C3, 0x00B5, 0x03C4,
  0x03A6, 0x0398, 0x03A9, 0x03B4, 0x221E, 0x03C6, 0x03B5, 0x2229,
  0x2261, 0x00B1, 0x2265, 0x2264, 0x2320, 0x2321, 0x00F7, 0x2248,
  0x00B0, 0x2219, 0x00B7, 0x221A, 0x207F, 0x00B2, 0x25A0, 0x00A0
];

// Reverse map: Unicode code point -> CP437 byte (0x80..0xFF).
const REV = new Map();
for (let i = 0; i < CP437_HIGH.length; i += 1) {
  REV.set(CP437_HIGH[i], 0x80 + i);
}

// Characters that are strong signals of CP437-decoded UTF-8 (box drawing,
// greek used by the copilot CLI's bullets/rules, common accented bytes).
const SIGNATURE = /[\u0393\u00F9\u00C5\u00F6\u00E9\u2261\u0192\u00F4\u00EF\u2502\u2500\u2510\u2514\u2518\u250C\u2588\u2219\u00B7]/;

function repairConsoleMojibake(input) {
  if (typeof input !== 'string' || !input) return input;
  if (!SIGNATURE.test(input)) return input;

  const bytes = [];
  for (const ch of input) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) {
      bytes.push(cp);
      continue;
    }
    const b = REV.get(cp);
    if (b === undefined) {
      // Contains a character that isn't representable as a single CP437 byte,
      // so this isn't the mojibake we know how to reverse — leave it untouched.
      return input;
    }
    bytes.push(b);
  }

  let decoded;
  try {
    decoded = Buffer.from(bytes).toString('utf8');
  } catch {
    return input;
  }
  // If decoding produced replacement chars, the byte stream wasn't valid UTF-8,
  // meaning the original wasn't actually mojibake — keep the original.
  if (decoded.includes('\uFFFD')) return input;
  return decoded;
}

module.exports = { repairConsoleMojibake };
