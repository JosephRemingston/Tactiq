// Deterministic random inputs for property-based and fuzz tests. Same seed, same inputs, on every machine and run,
// so a failing case can always be reproduced. Set FUZZ_SEED to explore other inputs locally.

export const SEED = Number(process.env.FUZZ_SEED ?? 20261112);

/** mulberry32: small, fast, good enough for test inputs. */
export function rng(seed = SEED) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min, max) => min + Math.floor(next() * (max - min + 1));
  const pick = (arr) => arr[int(0, arr.length - 1)];
  return { next, int, pick };
}

/** Hostile and unusual strings: injection payloads, markup, unicode, control characters, very long input. */
export const NASTY_STRINGS = [
  "",
  " ",
  "   \t\n ",
  "' OR 1=1--",
  "1'; DROP TABLE users;--",
  "%' UNION SELECT email, clerk_user_id FROM users--",
  "'||pg_sleep(5)||'",
  "$$; select pg_sleep(5); $$",
  "\\\\x00",
  "%",
  "%%",
  "_",
  "\\",
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "javascript:alert(1)",
  "\"><svg/onload=alert(1)>",
  "{{7*7}}",
  "${7*7}",
  "../../../../etc/passwd",
  "..%2f..%2fetc%2fpasswd",
  "\r\nSet-Cookie: pwned=1",
  "‮لا RTL override",
  "Zalgo t̷̢̛e̵̡͝x̴̨̛t̸̢͠",
  "😀⚽🏆👨‍👩‍👧‍👦",
  "ﷺ ﷽ 𒐫 𝕳𝖊𝖑𝖑𝖔",
  "﻿bom",
  "\u0007\u0008\u001b[31mred",
  "a".repeat(5000),
  "{\"__proto__\":{\"polluted\":true}}",
  "null",
  "undefined",
  "NaN",
  "Infinity",
  "-1",
  "0x41",
  "1e309",
];

/** A random string drawn from printable ASCII, unicode blocks, emoji and control characters. */
export function randomString(r, maxLen = 64) {
  const len = r.int(0, maxLen);
  const pools = [
    () => String.fromCharCode(r.int(0x20, 0x7e)),
    () => String.fromCharCode(r.int(0xa0, 0x2fff)),
    () => String.fromCodePoint(r.int(0x1f300, 0x1f6ff)),
    () => String.fromCharCode(r.int(0x01, 0x1f)),
    () => r.pick(["'", '"', "\\", "%", "_", ";", "--", "/*", "*/", "<", ">", "&", "$", "{", "}"]),
  ];
  let s = "";
  for (let i = 0; i < len; i++) s += r.pick(pools)();
  return s;
}
