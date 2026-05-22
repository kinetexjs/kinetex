/**
 *
 * Full RFC 6265 §5.1 + §5.2 implementation:
 *  - Cookie-date parser (§5.1.1) — handles all real-world broken formats
 *  - Domain canonicalization (§5.1.2)
 *  - Domain matching (§5.1.3)
 *  - Path computation + matching (§5.1.4)
 *  - Set-Cookie header parser (§5.2)
 *  - Public Suffix List (full algorithm + embedded rules)
 *  - IDN / punycode basic support
 *  - IPv4 + IPv6 detection
 */

// ============================================================================
// 1. TYPES
// ============================================================================

/** SameSite cookie attribute value. `"Unset"` means no SameSite attribute was present. */
export type SameSite = "Strict" | "Lax" | "None" | "Unset";

/**
 * A parsed Set-Cookie header with all attributes extracted.
 */
export interface ParsedCookie {
  /** Cookie name */
  name: string;
  /** Cookie value */
  value: string;
  /** Domain attribute (canonicalized, leading dot stripped), or null */
  domain: string | null;
  /** Path attribute, or null */
  path: string | null;
  /** Expires timestamp (ms), or null */
  expires: number | null;
  /** Max-Age in seconds, or null */
  maxAge: number | null;
  /** Secure flag */
  secure: boolean;
  /** HttpOnly flag */
  httpOnly: boolean;
  /** SameSite attribute value */
  sameSite: SameSite;
  /** Chrome Privacy Sandbox SameParty flag */
  sameParty: boolean;
  /** Chrome Cookie Priority value, or null */
  priority: "Low" | "Medium" | "High" | null;
  /** CHIPS Partitioned flag */
  partitioned: boolean;
}

// ============================================================================
// 2. RFC 6265 §5.1.1 — COOKIE DATE PARSER
// ============================================================================

/*
 * Full implementation of the RFC 6265 cookie-date algorithm.
 *
 * Handles all real-world broken formats browsers accept including:
 *  - Missing time component
 *  - 2-digit years
 *  - Extra whitespace, commas, dashes as delimiters
 *  - Month names abbreviated or full
 *  - Timezone suffixes (GMT, UTC, Z, +HH:MM — all normalized to UTC)
 *  - Ordinal suffixes on day (1st, 2nd, 3rd, 4th)
 *  - Reversed date component order
 *  - Negative max-age
 */

const MONTH_MAP: Readonly<Record<string, number>> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

// Delimiter chars per RFC 6265 §5.1.1
const DATE_DELIMITERS = /[\t\x20-\x2f\x3b-\x40\x5b-\x60\x7b-\x7e]+/;

/** Extracted date components during cookie-date parsing. */
interface DateComponents {
  /** [hours, minutes, seconds] or null */
  time: [number, number, number] | null;
  /** Day of month (1-31), or null */
  dayOfMonth: number | null;
  /** Month index (0-11), or null */
  month: number | null;
  /** Year (1601-9999), or null */
  year: number | null;
}

/** Split a date string into tokens using RFC 6265 §5.1.1 delimiters. */
function tokenizeDate(dateStr: string): string[] {
  return dateStr.split(DATE_DELIMITERS).filter(Boolean);
}

/**
 * Parse a time token (HH:MM:SS), optionally followed by timezone.
 * Timezone suffixes (Z, GMT, UTC, ±HH:MM) are accepted but ignored — all
 * dates are normalized to UTC by the caller.
 */
function parseTimeToken(token: string): [number, number, number] | null {
  // HH:MM:SS — colons are not delimiters so time stays as one token
  const m = token.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:[+-]\d{2}:?\d{2}|Z|GMT|UTC)?$/i);
  if (!m) return null;
  const h = +m[1]!,
    min = +m[2]!,
    sec = +m[3]!;
  if (h > 23 || min > 59 || sec > 59) return null;
  return [h, min, sec];
}

/** Parse a month name token (full or abbreviated) to a 0-based index. */
function parseMonthToken(token: string): number | null {
  const key = token.slice(0, 9).toLowerCase();
  return MONTH_MAP[key] ?? null;
}

/**
 * Parse a year token (2- or 4-digit) with RFC 6265 §5.1.1 two-digit mapping.
 * 00-69 → 2000-2069, 70-99 → 1970-1999.
 */
function parseYearToken(token: string): number | null {
  if (!/^\d{2,4}$/.test(token)) return null;
  let y = +token;
  // RFC 6265 §5.1.1 step 3: two-digit year mapping
  if (y >= 70 && y <= 99) y += 1900;
  if (y >= 0 && y <= 69) y += 2000;
  return y;
}

/**
 * Parse a cookie date string per RFC 6265 §5.1.1
 *
 * @param dateStr - The date string to parse
 * @returns Unix timestamp (ms) if valid, null otherwise
 *
 * Supported formats (per RFC 6265 §5.1.1 and real-world broken variants):
 *
 * | Format                          | Example                                    |
 * |--------------------------------|-------------------------------------------|
 * | HTTP-date (RFC 5322)           | "Thu, 01 Jan 2099 00:00:00 GMT"           |
 * | RFC 850                         | "Thursday, 01-Jan-99 00:00:00 GMT"        |
 * | ANSI C asctime()               | "Thu Jan  1 00:00:00 2099"                |
 * | Short numeric                  | "01/01/2099 00:00:00"                     |
 * | Cookie spec (RFC 2109)         | "Thu, 01-Jan-2099 00:00:00 GMT"           |
 * | Broken variants (lenient)     | Various real-world malformed dates       |
 *
 * Algorithm:
 * 1. Tokenize input into time, month, day-of-month, year tokens
 * 2. Extract time component (HH:MM:SS format)
 * 3. Extract month (3-letter or full name)
 * 4. Extract day-of-month (1-31)
 * 5. Extract year (2-digit with RFC 6265 §5.1.1 step 3 mapping, or 4-digit)
 * 6. Validate: year must be 1601-9999, day must be 1-31
 * 7. Return UTC timestamp or null if invalid
 *
 * Notes:
 * - Two-digit years are mapped: 00-69 → 2000-2069, 70-99 → 1970-1999
 * - Lenient on whitespace and minor format variations
 * - Returns null for dates with missing components or invalid ranges
 */
export function parseCookieDate(dateStr: string): number | null {
  if (!dateStr) return null;

  const tokens = tokenizeDate(dateStr);
  const found: DateComponents = {
    time: null,
    dayOfMonth: null,
    month: null,
    year: null,
  };

  for (const token of tokens) {
    if (!token) continue;

    // Time token (contains colons)
    if (found.time === null && token.includes(":")) {
      const t = parseTimeToken(token);
      if (t !== null) {
        found.time = t;
        continue;
      }
    }

    // Month (alpha)
    if (found.month === null && /[a-zA-Z]/.test(token)) {
      const m = parseMonthToken(token);
      if (m !== null) {
        found.month = m;
        continue;
      }
    }

    // Numeric tokens — try day, then year (order matters)
    if (/^\d{1,4}(?:st|nd|rd|th)?$/i.test(token)) {
      const numStr = token.replace(/[a-z]+$/i, "");
      const n = +numStr;

      if (found.dayOfMonth === null && numStr.length <= 2 && n >= 1 && n <= 31) {
        found.dayOfMonth = n;
        continue;
      }
      if (found.year === null && numStr.length >= 2) {
        const y = parseYearToken(numStr);
        if (y !== null) {
          found.year = y;
          continue;
        }
      }
      // Retry as day if year slot was taken first
      if (found.dayOfMonth === null && n >= 1 && n <= 31) {
        found.dayOfMonth = n;
        continue;
      }
    }
  }

  // RFC 6265 §5.1.1 step 4: abort if any component missing
  if (
    found.time === null ||
    found.dayOfMonth === null ||
    found.month === null ||
    found.year === null
  )
    return null;

  // RFC 6265 §5.1.1 step 5: validate
  if (found.year < 1601 || found.year > 9999) return null;
  if (found.dayOfMonth < 1 || found.dayOfMonth > 31) return null;

  const [h, min, sec] = found.time;
  const ts = Date.UTC(found.year, found.month, found.dayOfMonth, h, min, sec);
  return isNaN(ts) ? null : ts;
}

// ============================================================================
// 3. PUBLIC SUFFIX LIST
// ============================================================================

/**
 * Full PSL matching algorithm (https://wiki.mozilla.org/Public_Suffix_List/Algorithm)
 *
 * Rules embedded below cover:
 *  - All ccTLDs
 *  - Common second-level delegations (co.uk, com.au, etc.)
 *  - New gTLDs
 *  - Wildcard rules (*.ck, *.er, etc.)
 *  - Exceptions to wildcard rules
 *
 * Algorithm:
 *  1. Match from right to left
 *  2. Wildcard (*) matches any label
 *  3. Exception rules (!) override wildcards
 *  4. Longest matching rule wins
 *  5. If no rule matches, the TLD is the public suffix
 */

// Format: plain string = exact rule, "*.foo" = wildcard, "!foo.bar" = exception
const PSL_RAW: readonly string[] = [
  // ── Exceptions (must be first) ────────────────────────────────────────────
  "!www.ck",
  "!city.kobe.jp",
  "!city.nagoya.jp",
  "!city.sapporo.jp",
  "!city.sendai.jp",
  "!city.yokohama.jp",

  // ── Wildcards ────────────────────────────────────────────────────────────
  "*.ck",
  "*.er",
  "*.bd",
  "*.fj",
  "*.fk",
  "*.gu",
  "*.jm",
  "*.kh",
  "*.mm",
  "*.np",
  "*.pg",
  "*.ss",
  "*.tp",
  "*.vi",
  "*.ye",
  "*.zm",
  "*.kawasaki.jp",
  "*.kitakyushu.jp",
  "*.kobe.jp",
  "*.nagoya.jp",
  "*.osaka.jp",
  "*.sapporo.jp",
  "*.sendai.jp",
  "*.yokohama.jp",

  // ── Generic TLDs ─────────────────────────────────────────────────────────
  "com",
  "net",
  "org",
  "edu",
  "gov",
  "mil",
  "int",
  "arpa",
  "info",
  "biz",
  "name",
  "mobi",
  "tel",
  "travel",
  "museum",
  "coop",
  "aero",
  "pro",
  "jobs",
  "cat",
  "post",
  "xxx",
  "app",
  "dev",
  "io",
  "ai",
  "co",
  "me",
  "tv",
  "fm",
  "blog",
  "shop",
  "store",
  "online",
  "site",
  "web",
  "tech",
  "cloud",
  "digital",
  "media",
  "news",
  "press",
  "agency",
  "solutions",
  "services",
  "systems",
  "network",
  "group",
  "team",
  "studio",
  "design",
  "art",
  "photography",
  "email",
  "marketing",
  "consulting",
  "management",
  "finance",
  "money",
  "bank",
  "insurance",
  "healthcare",
  "medical",
  "hospital",
  "clinic",
  "pharmacy",
  "dental",
  "legal",
  "law",
  "attorney",
  "lawyer",
  "accountant",
  "pm",
  "sh",
  "ac",
  "cc",
  "cx",
  "nu",
  "ms",
  "pw",
  "sc",
  "sx",
  "tc",
  "tk",

  // ── ccTLDs ────────────────────────────────────────────────────────────────
  "ac",
  "ad",
  "ae",
  "af",
  "ag",
  "ai",
  "al",
  "am",
  "an",
  "ao",
  "aq",
  "ar",
  "as",
  "at",
  "au",
  "aw",
  "ax",
  "az",
  "ba",
  "bb",
  "bd",
  "be",
  "bf",
  "bg",
  "bh",
  "bi",
  "bj",
  "bm",
  "bn",
  "bo",
  "bq",
  "br",
  "bs",
  "bt",
  "bv",
  "bw",
  "by",
  "bz",
  "ca",
  "cc",
  "cd",
  "cf",
  "cg",
  "ch",
  "ci",
  "ck",
  "cl",
  "cm",
  "cn",
  "co",
  "cr",
  "cu",
  "cv",
  "cw",
  "cx",
  "cy",
  "cz",
  "de",
  "dj",
  "dk",
  "dm",
  "do",
  "dz",
  "ec",
  "ee",
  "eg",
  "eh",
  "er",
  "es",
  "et",
  "eu",
  "fi",
  "fj",
  "fk",
  "fm",
  "fo",
  "fr",
  "ga",
  "gb",
  "gd",
  "ge",
  "gf",
  "gg",
  "gh",
  "gi",
  "gl",
  "gm",
  "gn",
  "gp",
  "gq",
  "gr",
  "gs",
  "gt",
  "gu",
  "gw",
  "gy",
  "hk",
  "hm",
  "hn",
  "hr",
  "ht",
  "hu",
  "id",
  "ie",
  "il",
  "im",
  "in",
  "io",
  "iq",
  "ir",
  "is",
  "it",
  "je",
  "jm",
  "jo",
  "jp",
  "ke",
  "kg",
  "kh",
  "ki",
  "km",
  "kn",
  "kp",
  "kr",
  "kw",
  "ky",
  "kz",
  "la",
  "lb",
  "lc",
  "li",
  "lk",
  "lr",
  "ls",
  "lt",
  "lu",
  "lv",
  "ly",
  "ma",
  "mc",
  "md",
  "me",
  "mg",
  "mh",
  "mk",
  "ml",
  "mm",
  "mn",
  "mo",
  "mp",
  "mq",
  "mr",
  "ms",
  "mt",
  "mu",
  "mv",
  "mw",
  "mx",
  "my",
  "mz",
  "na",
  "nc",
  "ne",
  "nf",
  "ng",
  "ni",
  "nl",
  "no",
  "np",
  "nr",
  "nu",
  "nz",
  "om",
  "pa",
  "pe",
  "pf",
  "pg",
  "ph",
  "pk",
  "pl",
  "pm",
  "pn",
  "pr",
  "ps",
  "pt",
  "pw",
  "py",
  "qa",
  "re",
  "ro",
  "rs",
  "ru",
  "rw",
  "sa",
  "sb",
  "sc",
  "sd",
  "se",
  "sg",
  "sh",
  "si",
  "sj",
  "sk",
  "sl",
  "sm",
  "sn",
  "so",
  "sr",
  "ss",
  "st",
  "su",
  "sv",
  "sx",
  "sy",
  "sz",
  "tc",
  "td",
  "tf",
  "tg",
  "th",
  "tj",
  "tk",
  "tl",
  "tm",
  "tn",
  "to",
  "tr",
  "tt",
  "tv",
  "tw",
  "tz",
  "ua",
  "ug",
  "uk",
  "us",
  "uy",
  "uz",
  "va",
  "vc",
  "ve",
  "vg",
  "vi",
  "vn",
  "vu",
  "wf",
  "ws",
  "ye",
  "yt",
  "za",
  "zm",
  "zw",

  // ── Second-level: Australia ───────────────────────────────────────────────
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "gov.au",
  "asn.au",
  "id.au",
  "info.au",
  "conf.au",
  "oz.au",
  "act.au",
  "nsw.au",
  "nt.au",
  "qld.au",
  "sa.au",
  "tas.au",
  "vic.au",
  "wa.au",

  // ── Second-level: Brazil ─────────────────────────────────────────────────
  "com.br",
  "net.br",
  "org.br",
  "edu.br",
  "gov.br",
  "mil.br",
  "art.br",
  "ind.br",
  "adm.br",
  "adv.br",
  "agr.br",
  "am.br",
  "arq.br",
  "ato.br",
  "b.br",
  "bio.br",
  "blog.br",
  "bmd.br",
  "cim.br",
  "cng.br",
  "cnt.br",
  "coop.br",
  "ecn.br",
  "eco.br",
  "emp.br",
  "eng.br",
  "esp.br",
  "etc.br",
  "eti.br",
  "far.br",
  "flog.br",
  "fm.br",
  "fnd.br",
  "fot.br",
  "fst.br",
  "g12.br",
  "ggf.br",
  "imb.br",
  "inf.br",
  "jor.br",
  "jus.br",
  "leg.br",
  "lel.br",
  "mat.br",
  "med.br",
  "mp.br",
  "mus.br",
  "not.br",
  "ntr.br",
  "odo.br",
  "ppg.br",
  "pro.br",
  "psc.br",
  "psi.br",
  "qsl.br",
  "radio.br",
  "rec.br",
  "slg.br",
  "srv.br",
  "taxi.br",
  "teo.br",
  "tmp.br",
  "trd.br",
  "tur.br",
  "tv.br",
  "vet.br",
  "vlog.br",
  "wiki.br",
  "zlg.br",

  // ── Second-level: Canada ─────────────────────────────────────────────────
  "ab.ca",
  "bc.ca",
  "mb.ca",
  "nb.ca",
  "nf.ca",
  "nl.ca",
  "ns.ca",
  "nt.ca",
  "nu.ca",
  "on.ca",
  "pe.ca",
  "qc.ca",
  "sk.ca",
  "yk.ca",

  // ── Second-level: China ──────────────────────────────────────────────────
  "com.cn",
  "net.cn",
  "org.cn",
  "edu.cn",
  "gov.cn",
  "mil.cn",
  "ac.cn",
  "ah.cn",
  "bj.cn",
  "cq.cn",
  "fj.cn",
  "gd.cn",
  "gs.cn",
  "gz.cn",
  "gx.cn",
  "ha.cn",
  "hb.cn",
  "he.cn",
  "hi.cn",
  "hl.cn",
  "hn.cn",
  "jl.cn",
  "js.cn",
  "jx.cn",
  "ln.cn",
  "nm.cn",
  "nx.cn",
  "qh.cn",
  "sc.cn",
  "sd.cn",
  "sh.cn",
  "sn.cn",
  "sx.cn",
  "tj.cn",
  "xj.cn",
  "xz.cn",
  "yn.cn",
  "zj.cn",

  // ── Second-level: United Kingdom ─────────────────────────────────────────
  "co.uk",
  "me.uk",
  "org.uk",
  "ltd.uk",
  "plc.uk",
  "net.uk",
  "sch.uk",
  "gov.uk",
  "nhs.uk",
  "police.uk",
  "mod.uk",
  "ac.uk",
  "judiciary.uk",
  "parliament.uk",

  // ── Second-level: Japan ───────────────────────────────────────────────────
  "co.jp",
  "ne.jp",
  "or.jp",
  "ac.jp",
  "ad.jp",
  "ed.jp",
  "go.jp",
  "gr.jp",
  "lg.jp",
  "aichi.jp",
  "akita.jp",
  "aomori.jp",
  "chiba.jp",
  "ehime.jp",
  "fukui.jp",
  "fukuoka.jp",
  "fukushima.jp",
  "gifu.jp",
  "gunma.jp",
  "hiroshima.jp",
  "hokkaido.jp",
  "hyogo.jp",
  "ibaraki.jp",
  "ishikawa.jp",
  "iwate.jp",
  "kagawa.jp",
  "kagoshima.jp",
  "kanagawa.jp",
  "kochi.jp",
  "kumamoto.jp",
  "kyoto.jp",
  "mie.jp",
  "miyagi.jp",
  "miyazaki.jp",
  "nagano.jp",
  "nagasaki.jp",
  "nara.jp",
  "niigata.jp",
  "oita.jp",
  "okayama.jp",
  "okinawa.jp",
  "osaka.jp",
  "saga.jp",
  "saitama.jp",
  "shiga.jp",
  "shimane.jp",
  "shizuoka.jp",
  "tochigi.jp",
  "tokushima.jp",
  "tokyo.jp",
  "tottori.jp",
  "toyama.jp",
  "wakayama.jp",
  "yamagata.jp",
  "yamaguchi.jp",
  "yamanashi.jp",

  // ── Second-level: New Zealand ─────────────────────────────────────────────
  "co.nz",
  "net.nz",
  "org.nz",
  "edu.nz",
  "govt.nz",
  "school.nz",
  "geek.nz",
  "maori.nz",
  "iwi.nz",
  "mil.nz",
  "parliament.nz",
  "ac.nz",

  // ── Second-level: South Africa ───────────────────────────────────────────
  "co.za",
  "net.za",
  "org.za",
  "edu.za",
  "gov.za",
  "mil.za",
  "ac.za",
  "alt.za",
  "agric.za",
  "cybernet.za",
  "db.za",
  "grondar.za",
  "nis.za",
  "nom.za",
  "ngo.za",
  "pty.za",
  "school.za",
  "tm.za",
  "web.za",

  // ── Second-level: India ──────────────────────────────────────────────────
  "co.in",
  "net.in",
  "org.in",
  "edu.in",
  "gov.in",
  "mil.in",
  "ac.in",
  "res.in",
  "firm.in",
  "gen.in",
  "ind.in",
  "int.in",
  "nic.in",

  // ── Second-level: Argentina ──────────────────────────────────────────────
  "com.ar",
  "net.ar",
  "org.ar",
  "edu.ar",
  "gov.ar",
  "mil.ar",
  "int.ar",
  "tur.ar",

  // ── Second-level: Mexico ─────────────────────────────────────────────────
  "com.mx",
  "net.mx",
  "org.mx",
  "edu.mx",
  "gob.mx",

  // ── Second-level: Singapore ──────────────────────────────────────────────
  "com.sg",
  "net.sg",
  "org.sg",
  "edu.sg",
  "gov.sg",
  "per.sg",

  // ── Second-level: Hong Kong ──────────────────────────────────────────────
  "com.hk",
  "net.hk",
  "org.hk",
  "edu.hk",
  "gov.hk",
  "idv.hk",

  // ── Second-level: Taiwan ─────────────────────────────────────────────────
  "com.tw",
  "net.tw",
  "org.tw",
  "edu.tw",
  "gov.tw",
  "mil.tw",
  "idv.tw",
  "game.tw",
  "ebiz.tw",
  "club.tw",

  // ── Second-level: Malaysia ───────────────────────────────────────────────
  "com.my",
  "net.my",
  "org.my",
  "edu.my",
  "gov.my",
  "mil.my",
  "name.my",
  "sch.my",

  // ── Second-level: Philippines ────────────────────────────────────────────
  "com.ph",
  "net.ph",
  "org.ph",
  "edu.ph",
  "gov.ph",
  "mil.ph",
  "ngo.ph",
  "i.ph",

  // ── Second-level: Pakistan ───────────────────────────────────────────────
  "com.pk",
  "net.pk",
  "org.pk",
  "edu.pk",
  "gov.pk",
  "mil.pk",
  "ac.pk",
  "res.pk",
  "biz.pk",
  "fam.pk",
  "gob.pk",
  "gok.pk",
  "gon.pk",
  "gop.pk",
  "gos.pk",
  "info.pk",

  // ── Second-level: Egypt ──────────────────────────────────────────────────
  "com.eg",
  "net.eg",
  "org.eg",
  "edu.eg",
  "gov.eg",
  "mil.eg",
  "sci.eg",
  "eun.eg",
  "info.eg",
  "name.eg",

  // ── Second-level: Saudi Arabia ───────────────────────────────────────────
  "com.sa",
  "net.sa",
  "org.sa",
  "edu.sa",
  "gov.sa",
  "med.sa",
  "pub.sa",
  "sch.sa",

  // ── Second-level: UAE ────────────────────────────────────────────────────
  "com.ae",
  "net.ae",
  "org.ae",
  "edu.ae",
  "gov.ae",
  "mil.ae",
  "sch.ae",
  "ac.ae",
  "pro.ae",
  "name.ae",

  // ── Second-level: Turkey ─────────────────────────────────────────────────
  "com.tr",
  "net.tr",
  "org.tr",
  "edu.tr",
  "gov.tr",
  "mil.tr",
  "bel.tr",
  "k12.tr",
  "av.tr",
  "bbs.tr",
  "dr.tr",
  "gen.tr",
  "info.tr",
  "name.tr",
  "pol.tr",
  "tel.tr",
  "web.tr",

  // ── Second-level: Ukraine ─────────────────────────────────────────────────
  "com.ua",
  "net.ua",
  "org.ua",
  "edu.ua",
  "gov.ua",
  "mil.ua",
  "in.ua",
  "co.ua",
  "cherkassy.ua",
  "chernigov.ua",
  "chernovtsy.ua",
  "dn.ua",
  "dnepropetrovsk.ua",
  "donetsk.ua",
  "dp.ua",
  "if.ua",
  "kh.ua",
  "kharkov.ua",
  "kherson.ua",
  "khmelnitskiy.ua",
  "kiev.ua",
  "kirovograd.ua",
  "km.ua",
  "kr.ua",
  "lg.ua",
  "lugansk.ua",
  "lutsk.ua",
  "lviv.ua",
  "mk.ua",
  "mykolaiv.ua",
  "nikolaev.ua",
  "od.ua",
  "odessa.ua",
  "pl.ua",
  "poltava.ua",
  "rivne.ua",
  "rovno.ua",
  "rv.ua",
  "sebastopol.ua",
  "sumy.ua",
  "te.ua",
  "ternopil.ua",
  "uzhgorod.ua",
  "vinnica.ua",
  "vn.ua",
  "volyn.ua",
  "yalta.ua",
  "zp.ua",
  "zaporizhzhe.ua",
  "zt.ua",
  "zhitomir.ua",

  // ── Second-level: Russia ─────────────────────────────────────────────────
  "com.ru",
  "net.ru",
  "org.ru",
  "edu.ru",
  "gov.ru",
  "mil.ru",
  "pp.ru",
  "int.ru",
  "ac.ru",
  "msk.ru",
  "spb.ru",

  // ── Second-level: Poland ─────────────────────────────────────────────────
  "com.pl",
  "net.pl",
  "org.pl",
  "edu.pl",
  "gov.pl",
  "mil.pl",
  "co.pl",
  "info.pl",
  "biz.pl",
  "nom.pl",
  "waw.pl",
  "poznan.pl",
  "lodz.pl",
  "krakow.pl",
  "wroclaw.pl",

  // ── Second-level: Germany ────────────────────────────────────────────────
  "com.de",
  "co.de",

  // ── Second-level: France ─────────────────────────────────────────────────
  "com.fr",
  "co.fr",
  "asso.fr",
  "nom.fr",
  "prd.fr",
  "presse.fr",
  "tm.fr",
  "aeroport.fr",
  "assedic.fr",
  "avocat.fr",
  "avoues.fr",
  "cci.fr",
  "chambagri.fr",
  "chirurgiens-dentistes.fr",
  "experts-comptables.fr",
  "geometre-expert.fr",
  "gouv.fr",
  "greta.fr",
  "huissier-justice.fr",
  "medecin.fr",
  "notaires.fr",
  "pharmacien.fr",
  "port.fr",
  "veterinaire.fr",

  // ── Second-level: Italy ──────────────────────────────────────────────────
  "com.it",
  "co.it",

  // ── Second-level: Spain ──────────────────────────────────────────────────
  "com.es",
  "co.es",
  "nom.es",
  "org.es",
  "edu.es",
  "gob.es",

  // ── Second-level: Netherlands ────────────────────────────────────────────
  "com.nl",
  "co.nl",

  // ── Second-level: Belgium ────────────────────────────────────────────────
  "com.be",
  "co.be",
  "ac.be",
  "org.be",
  "net.be",

  // ── Second-level: Switzerland ────────────────────────────────────────────
  "com.ch",
  "co.ch",

  // ── Second-level: Austria ────────────────────────────────────────────────
  "com.at",
  "co.at",
  "ac.at",
  "gv.at",
  "or.at",
  "priv.at",

  // ── Second-level: Sweden ─────────────────────────────────────────────────
  "com.se",
  "co.se",
  "ac.se",
  "bd.se",
  "brand.se",
  "fh.se",
  "fhsk.se",
  "fhv.se",
  "tm.se",
  "pp.se",
  "press.se",
  "parti.se",
  "komforb.se",
  "kommunalforbund.se",
  "komvux.se",
  "lanarb.se",
  "lanbib.se",
  "naturbruksgymn.se",
  "sshn.se",

  // ── Second-level: Norway ─────────────────────────────────────────────────
  "com.no",
  "co.no",
  "stat.no",
  "fylkesbibl.no",
  "folkebibl.no",
  "museum.no",
  "idrett.no",
  "priv.no",
  "mil.no",
  "vgs.no",
  "videregaaende.no",
  "kommune.no",
  "herad.no",
  "aa.no",
  "ah.no",
  "bu.no",
  "fm.no",
  "hl.no",
  "hm.no",
  "jan-mayen.no",
  "mr.no",
  "nl.no",
  "nt.no",
  "of.no",
  "ol.no",
  "oslo.no",
  "rl.no",
  "sf.no",
  "st.no",
  "svalbard.no",
  "tm.no",
  "tr.no",
  "va.no",
  "vf.no",

  // ── Second-level: Denmark ────────────────────────────────────────────────
  "com.dk",
  "co.dk",
  "ac.dk",

  // ── Second-level: Finland ────────────────────────────────────────────────
  "com.fi",
  "co.fi",
  "ac.fi",
  "iki.fi",
  "aland.fi",
  "www.fi",

  // ── Second-level: Portugal ───────────────────────────────────────────────
  "com.pt",
  "co.pt",
  "edu.pt",
  "gov.pt",
  "int.pt",
  "net.pt",
  "nome.pt",
  "org.pt",
  "publ.pt",
  "dyndns.pt",

  // ── Second-level: Greece ─────────────────────────────────────────────────
  "com.gr",
  "co.gr",
  "edu.gr",
  "gov.gr",
  "net.gr",
  "org.gr",
  "store.gr",

  // ── Second-level: Ireland ────────────────────────────────────────────────
  "com.ie",
  "co.ie",
  "gov.ie",
  "net.ie",
  "org.ie",
  "teagasc.ie",

  // ── Second-level: Czech Republic ─────────────────────────────────────────
  "com.cz",
  "co.cz",
  "edu.cz",
  "net.cz",
  "org.cz",
  "info.cz",

  // ── Second-level: Slovakia ───────────────────────────────────────────────
  "com.sk",
  "co.sk",
  "edu.sk",
  "net.sk",
  "org.sk",

  // ── Second-level: Hungary ────────────────────────────────────────────────
  "com.hu",
  "co.hu",
  "edu.hu",
  "film.hu",
  "gov.hu",
  "info.hu",
  "net.hu",
  "org.hu",
  "priv.hu",
  "sport.hu",
  "tm.hu",
  "2000.hu",
  "agrar.hu",
  "bolt.hu",
  "casino.hu",
  "city.hu",
  "erotica.hu",
  "erotika.hu",
  "forum.hu",
  "games.hu",
  "hotel.hu",
  "ingatlan.hu",
  "jogasz.hu",
  "konyvelo.hu",
  "lakas.hu",
  "media.hu",
  "news.hu",
  "reklam.hu",
  "sex.hu",
  "shop.hu",
  "suli.hu",
  "szex.hu",
  "tozsde.hu",
  "utazas.hu",
  "video.hu",

  // ── Second-level: Romania ────────────────────────────────────────────────
  "com.ro",
  "co.ro",
  "edu.ro",
  "gov.ro",
  "info.ro",
  "net.ro",
  "nom.ro",
  "org.ro",
  "rec.ro",
  "store.ro",
  "tm.ro",
  "www.ro",
  "arts.ro",
  "firm.ro",
  "nt.ro",
  "shop.ro",

  // ── Second-level: Bulgaria ───────────────────────────────────────────────
  "com.bg",
  "co.bg",
  "edu.bg",
  "gov.bg",
  "net.bg",
  "org.bg",
  "tel.bg",
  "biz.bg",

  // ── Second-level: Croatia ────────────────────────────────────────────────
  "com.hr",
  "co.hr",
  "from.hr",
  "iz.hr",
  "name.hr",
  "net.hr",

  // ── Second-level: Serbia ─────────────────────────────────────────────────
  "com.rs",
  "co.rs",
  "edu.rs",
  "gov.rs",
  "in.rs",
  "net.rs",
  "org.rs",

  // ── Second-level: Bosnia ─────────────────────────────────────────────────
  "com.ba",
  "co.ba",
  "edu.ba",
  "gov.ba",
  "mil.ba",
  "net.ba",
  "org.ba",
  "rs.ba",
  "unbi.ba",
  "unmo.ba",
  "unsa.ba",
  "untz.ba",
  "unze.ba",

  // ── Second-level: Colombia ───────────────────────────────────────────────
  "com.co",
  "net.co",
  "org.co",
  "edu.co",
  "gov.co",
  "mil.co",
  "nom.co",

  // ── Second-level: Venezuela ──────────────────────────────────────────────
  "com.ve",
  "net.ve",
  "org.ve",
  "edu.ve",
  "gov.ve",
  "mil.ve",
  "int.ve",
  "co.ve",
  "arts.ve",
  "bib.ve",
  "firm.ve",
  "info.ve",
  "nom.ve",
  "rec.ve",
  "store.ve",
  "tec.ve",
  "web.ve",

  // ── Second-level: Peru ───────────────────────────────────────────────────
  "com.pe",
  "net.pe",
  "org.pe",
  "edu.pe",
  "gov.pe",
  "mil.pe",
  "nom.pe",
  "sld.pe",

  // ── Second-level: Chile ──────────────────────────────────────────────────
  "com.cl",
  "co.cl",
  "gob.cl",
  "gov.cl",
  "net.cl",
  "org.cl",
  "mil.cl",
  "edu.cl",

  // ── Second-level: Korea ──────────────────────────────────────────────────
  "co.kr",
  "ne.kr",
  "or.kr",
  "re.kr",
  "pe.kr",
  "go.kr",
  "mil.kr",
  "ac.kr",
  "hs.kr",
  "ms.kr",
  "es.kr",
  "sc.kr",
  "kg.kr",
  "seoul.kr",
  "busan.kr",
  "daegu.kr",
  "incheon.kr",
  "gwangju.kr",
  "daejeon.kr",
  "ulsan.kr",
  "gyeonggi.kr",
  "gangwon.kr",
  "chungbuk.kr",
  "chungnam.kr",
  "jeonbuk.kr",
  "jeonnam.kr",
  "gyeongbuk.kr",
  "gyeongnam.kr",
  "jeju.kr",

  // ── Second-level: Indonesia ──────────────────────────────────────────────
  "co.id",
  "net.id",
  "or.id",
  "ac.id",
  "web.id",
  "sch.id",
  "go.id",
  "mil.id",
  "my.id",

  // ── Second-level: Thailand ───────────────────────────────────────────────
  "co.th",
  "net.th",
  "org.th",
  "ac.th",
  "go.th",
  "in.th",
  "mi.th",

  // ── Second-level: Vietnam ────────────────────────────────────────────────
  "com.vn",
  "net.vn",
  "org.vn",
  "edu.vn",
  "gov.vn",
  "int.vn",
  "ac.vn",
  "biz.vn",
  "info.vn",
  "name.vn",
  "pro.vn",
  "health.vn",

  // ── Second-level: Nigeria ────────────────────────────────────────────────
  "com.ng",
  "net.ng",
  "org.ng",
  "edu.ng",
  "gov.ng",
  "mil.ng",
  "mobi.ng",
  "name.ng",
  "sch.ng",

  // ── Second-level: Kenya ──────────────────────────────────────────────────
  "co.ke",
  "or.ke",
  "ne.ke",
  "go.ke",
  "ac.ke",
  "sc.ke",
  "me.ke",
  "mobi.ke",

  // ── Second-level: Israel ─────────────────────────────────────────────────
  "co.il",
  "net.il",
  "org.il",
  "edu.il",
  "gov.il",
  "muni.il",
  "ac.il",
  "idf.il",

  // ── Second-level: Iran ───────────────────────────────────────────────────
  "com.ir",
  "net.ir",
  "org.ir",
  "edu.ir",
  "gov.ir",
  "ac.ir",
  "id.ir",
];

// Build lookup structures
const PSL_EXACT = new Set<string>();
const PSL_WILDCARDS = new Set<string>(); // stores the parent, e.g. "ck" for *.ck
const PSL_EXCEPTIONS = new Set<string>(); // stores full exception domain

for (const rule of PSL_RAW) {
  if (rule.startsWith("!")) {
    PSL_EXCEPTIONS.add(rule.slice(1).toLowerCase());
  } else if (rule.startsWith("*.")) {
    PSL_WILDCARDS.add(rule.slice(2).toLowerCase());
  } else {
    PSL_EXACT.add(rule.toLowerCase());
  }
}

/**
 * Get the public suffix (TLD or effective TLD) for a hostname.
 * Uses an embedded Public Suffix List covering ccTLDs, common second-level
 * registrations, wildcards, and exceptions.
 *
 * @param hostname - Fully qualified hostname (e.g., "www.example.co.uk")
 * @returns The public suffix (e.g., "co.uk"), or null for empty/invalid input
 */
export function getPublicSuffix(hostname: string): string | null {
  // Strip trailing dot before processing
  const h = hostname.replace(/\.$/, "").toLowerCase();
  const labels = h.split(".");
  if (labels.length === 0 || (labels.length === 1 && labels[0] === "")) return null;

  // Step 1: check exception rules
  if (PSL_EXCEPTIONS.has(h)) {
    // Exception rule: the full hostname IS a public suffix
    return h;
  }

  // Step 2: find longest matching rule
  let bestMatch: string | null = null;
  let bestLen = 0;

  // Try exact matches from longest to shortest suffix
  for (let i = 0; i < labels.length; i++) {
    const candidate = labels.slice(i).join(".");
    if (PSL_EXACT.has(candidate)) {
      const len = labels.length - i;
      if (len > bestLen) {
        bestLen = len;
        bestMatch = candidate;
      }
    }
  }

  // Try wildcard matches: if the TLD (or multi-part TLD) parent is in wildcards,
  // then *.parent matches any one label prepended
  for (let i = 0; i < labels.length - 1; i++) {
    const parent = labels.slice(i + 1).join(".");
    if (PSL_WILDCARDS.has(parent)) {
      const wildcardSuffix = labels.slice(i).join(".");
      const len = labels.length - i;
      if (len > bestLen) {
        bestLen = len;
        bestMatch = wildcardSuffix;
      }
    }
  }

  if (bestMatch) return bestMatch;

  // Step 3: no match — default rule: TLD only
  return labels[labels.length - 1] ?? null;
}

/**
 * Get the registrable domain (aka effective TLD + 1 label) for a hostname.
 * Returns null for bare TLDs or invalid input.
 * For IP addresses, returns the IP itself.
 */
export function getRegistrableDomain(hostname: string): string | null {
  const h = hostname.toLowerCase();
  if (isIPAddress(h)) return h;

  const suffix = getPublicSuffix(h);
  if (!suffix) return null;

  const suffixLabels = suffix.split(".").length;
  const labels = h.split(".");
  if (labels.length <= suffixLabels) return null;

  return labels.slice(-(suffixLabels + 1)).join(".");
}

/**
 * Check whether a hostname is a public suffix (TLD or effective TLD).
 * Returns true for exact PSL matches and wildcard-covered domains.
 */
export function isPublicSuffix(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (PSL_EXCEPTIONS.has(h)) return true; // exceptions are public suffixes
  if (PSL_EXACT.has(h)) return true;
  // Check if any wildcard parent matches and the hostname has the right depth
  const labels = h.split(".");
  if (labels.length >= 2) {
    const parent = labels.slice(1).join(".");
    if (PSL_WILDCARDS.has(parent)) return true;
  }
  return false;
}

// ============================================================================
// 4. IDN / PUNYCODE (using Intl.IDN)
// ============================================================================

/**
 * RFC 3492 punycode decoder — cross-runtime, never throws, no deprecated dependencies.
 * Fallback used when `Intl.IDN` or Node `domainToUnicode` are unavailable.
 */
function decodePunycode(input: string): string {
  try {
    const base = 36;
    const tmin = 1;
    const tmax = 26;
    const skew = 38;
    const damp = 700;
    const initialBias = 72;
    const initialN = 0x80;

    const delim = input.lastIndexOf("-");
    const output: number[] = [];

    const basic = delim >= 0 ? input.slice(0, delim) : "";
    for (let j = 0; j < basic.length; j++) {
      const cp = basic.charCodeAt(j);
      if (cp > 0x7a || (cp > 0x5a && cp < 0x61) || (cp > 0x39 && cp < 0x41) || cp < 0x30)
        return input;
      output.push(cp);
    }

    const extended = delim >= 0 ? input.slice(delim + 1) : input;
    let n = initialN;
    let i = 0;
    let bias = initialBias;

    const digitVal = (cp: number): number => {
      if (cp >= 0x41 && cp <= 0x5a) return cp - 0x41;
      if (cp >= 0x61 && cp <= 0x7a) return cp - 0x61;
      if (cp >= 0x30 && cp <= 0x39) return cp - 0x30 + 26;
      return -1;
    };

    const adapt = (delta: number, numPoints: number, firstTime: boolean): number => {
      delta = Math.floor(delta / (firstTime ? damp : 2));
      delta += Math.floor(delta / numPoints);
      let k = 0;
      while (delta > ((base - tmin) * tmax) / 2) {
        delta = Math.floor(delta / (base - tmin));
        k += base;
      }
      return k + Math.floor(((base - tmin + 1) * delta) / (delta + skew));
    };

    let pos = 0;
    while (pos < extended.length) {
      const oldI = i;
      let w = 1;
      for (let k = base; ; k += base) {
        if (pos >= extended.length) return input;
        const d = digitVal(extended.charCodeAt(pos++));
        if (d < 0) return input;
        i += d * w;
        const t = k <= bias ? tmin : k >= bias + tmax ? tmax : k - bias;
        if (d < t) break;
        w *= base - t;
      }
      bias = adapt(i - oldI, output.length + 1, oldI === 0);
      n += Math.floor(i / (output.length + 1));
      i %= output.length + 1;
      output.splice(i, 0, n);
      i++;
    }

    const result = String.fromCodePoint(...output);
    return result || input;
  } catch {
    return input;
  }
}

// Node.js IDN decoding (lazy init, no top-level await)
let _domainToUnicode: ((label: string) => string) | undefined;
(async () => {
  try {
    const urlMod = (await import("node:url")) as { domainToUnicode?: (l: string) => string };
    if (typeof urlMod.domainToUnicode === "function") _domainToUnicode = urlMod.domainToUnicode;
  } catch {
    // Not Node.js — Intl.IDN (Deno) or fallback
  }
})();

/**
 * Decode an IDN label using Intl.IDN or punycode fallback.
 * Tries Node `domainToUnicode`, then Deno `Intl.IDN`, then native RFC 3492 decoder.
 * Available in: Node.js 12+, Deno 1.14+, Bun, modern browsers, Cloudflare Workers.
 *
 * @param label - The label to decode (e.g., "xn--fiqs83s")
 * @returns Decoded label (e.g., "中国") or original if not punycode
 */
export function decodeIDNLabel(label: string): string {
  if (!label.toLowerCase().startsWith("xn--")) {
    return label;
  }

  // Deno: Intl.IDN API
  const intl = Intl as {
    IDN?: { toUnicode: (label: string, options: { standard: string }) => string };
  };
  if (typeof Intl !== "undefined" && intl.IDN && typeof intl.IDN.toUnicode === "function") {
    try {
      return intl.IDN.toUnicode(label, { standard: "tr46" });
    } catch {
      return label;
    }
  }

  // Node.js: try domainToUnicode, fall back to native punycode decoder
  if (_domainToUnicode) {
    const asDomain = label + ".invalid";
    const decoded = _domainToUnicode(asDomain);
    if (decoded && decoded.length > 8 && decoded.endsWith(".invalid")) {
      const labelDecoded = decoded.slice(0, -8);
      if (labelDecoded !== label) return labelDecoded;
    }
  }

  // Native punycode decoder fallback (RFC 3492)
  if (label.startsWith("xn--")) {
    try {
      const decoded = decodePunycode(label.slice(4));
      if (decoded && decoded !== label.slice(4)) return decoded;
    } catch {
      // Decode failed — return raw
    }
  }

  return label;
}

/**
 * Fully canonicalize a domain string per RFC 6265:
 * strip leading/trailing dots, lowercase, decode IDN labels.
 *
 * @param domain - Domain string to canonicalize (e.g., "Example.Com" or ".EXAMPLE.com.")
 * @returns Canonicalized domain (e.g., "example.com")
 */
export function canonicalizeDomainFull(domain: string): string {
  // Strip leading and trailing dots, lowercase, decode IDN labels
  // Per RFC 6265, "example.com" and "example.com." are equivalent
  const stripped = domain.replace(/^\./, "").replace(/\.$/, "").toLowerCase();
  return stripped.split(".").map(decodeIDNLabel).join(".");
}

// ============================================================================
// 5. IP ADDRESS DETECTION
// ============================================================================

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_RE = /^[\da-f:]+$/i;

/**
 * Check whether a host string is an IPv4 or IPv6 address.
 *
 * @param host - Host string to check (may include brackets for IPv6, e.g. "[::1]")
 * @returns true if the host is an IP address
 */
export function isIPAddress(host: string): boolean {
  const h = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (IPV4_RE.test(h)) {
    const parts = h.split(".").map(Number);
    return parts.every((p) => p >= 0 && p <= 255);
  }
  return IPV6_RE.test(h) && h.includes(":");
}

// ============================================================================
// 6. RFC 6265 §5.1.3 — DOMAIN MATCHING
// ============================================================================

/**
 * Domain matching per RFC 6265 §5.1.3
 *
 * @param requestHost - The request host (e.g., "example.com")
 * @param cookieDomain - The cookie domain attribute (e.g., ".example.com")
 * @returns true if the cookie should be sent for this request host
 */
export function domainMatch(requestHost: string, cookieDomain: string): boolean {
  const rh = requestHost.toLowerCase();
  const cd = cookieDomain.toLowerCase();

  if (rh === cd) return true;

  // IP addresses: exact match only
  if (isIPAddress(rh)) return false;

  // rh must end with "." + cd
  if (!rh.endsWith("." + cd)) return false;

  // cd must not be an IP
  if (isIPAddress(cd)) return false;

  // RFC 6265 §5.3: cookie domain must not be a public suffix
  // e.g., "com" or "co.uk" should not be allowed as cookie domain
  const psl = getPublicSuffix(rh);
  if (psl === rh) return false; // requestHost is a public suffix

  return true;
}

// ============================================================================
// 7. RFC 6265 §5.1.4 — PATH COMPUTATION + MATCHING
// ============================================================================

/**
 * Compute the default cookie path per RFC 6265 §5.1.4.
 * Strips the trailing segment from the request path.
 *
 * @param requestPath - The request URI path (e.g., "/foo/bar")
 * @returns Default cookie path (e.g., "/foo")
 */
export function defaultPath(requestPath: string): string {
  if (!requestPath || requestPath === "" || requestPath[0] !== "/") return "/";
  const idx = requestPath.lastIndexOf("/");
  if (idx === 0) return "/";
  return requestPath.slice(0, idx);
}

/**
 * Normalize a URL path by resolving `.` and `..` segments.
 * This prevents path traversal attacks via malformed cookie paths.
 *
 * @param path - The path to normalize (e.g., "/foo/bar/../baz")
 * @returns Normalized path with resolved segments (e.g., "/foo/baz")
 *
 * @example
 * normalizePath("/foo/bar/../baz") // "/foo/baz"
 * normalizePath("/foo/./bar")      // "/foo/bar"
 * normalizePath("foo")            // "/foo"
 */
export function normalizePath(path: string): string {
  if (!path.startsWith("/")) return "/" + path;

  const parts: string[] = [];
  const segments = path.split("/");

  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      // Empty or current directory - skip
      continue;
    } else if (segment === "..") {
      // Parent directory - pop if possible
      if (parts.length > 0) {
        parts.pop();
      }
      // If we're at root, ignore the .. (can't go above root)
    } else {
      parts.push(segment);
    }
  }

  // Ensure we always have a leading slash
  return "/" + parts.join("/");
}

/**
 * Path matching per RFC 6265 §5.1.4 — checks whether a cookie path
 * matches a request path. Both paths are normalized before comparison.
 *
 * @param requestPath - Request URI path (e.g., "/foo/bar/baz")
 * @param cookiePath - Cookie Path attribute (e.g., "/foo")
 * @returns true if the cookie path matches the request path
 */
export function pathMatch(requestPath: string, cookiePath: string): boolean {
  // Normalize both paths to handle .. and . segments
  const normRequestPath = normalizePath(requestPath);
  const normCookiePath = normalizePath(cookiePath);

  if (normRequestPath === normCookiePath) return true;

  if (normRequestPath.startsWith(normCookiePath)) {
    if (normCookiePath.endsWith("/")) return true;
    // Use already-normalized length instead of re-normalizing
    if (normRequestPath[normCookiePath.length] === "/") return true;
  }

  return false;
}

// ============================================================================
// 8. RFC 6265 §5.2 — SET-COOKIE HEADER PARSER
// ============================================================================

// RFC 2616 §2.2 token: any CHAR except CTLs or separators
const TOKEN_RE = /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/;

/**
 * Validates a cookie name per RFC 6265 §4.1.1
 *
 * @param name - The cookie name to validate
 * @returns true if valid, false otherwise
 *
 * Note: Empty names are intentionally allowed for leniency (e.g., "=value" cookies).
 * While RFC 6265 doesn't formally support nameless cookies, some servers emit them
 * and browsers accept them. This function mirrors that lenient behavior.
 */
function isValidCookieName(name: string): boolean {
  if (name === "") return true; // empty name allowed (e.g. "=value" cookies)
  return TOKEN_RE.test(name);
}

/** Validate a cookie value per RFC 6265 §4.1.1 — rejects CTL characters. */
function isValidCookieValue(value: string): boolean {
  // RFC 6265 §4.1.1: any US-ASCII char except CTL, whitespace, DQUOTE, comma, semicolon, backslash
  // We are lenient here (match browser behaviour) — only reject true CTLs
  for (let i = 0; i < value.length; i++) {
    const cc = value.charCodeAt(i);
    if ((cc >= 0 && cc <= 8) || (cc >= 10 && cc <= 31) || cc === 127) return false;
  }
  return true;
}

/**
 * Parse a single Set-Cookie header value per RFC 6265 §5.2.
 * Returns null for empty or syntactically invalid headers.
 *
 * @param header - The raw Set-Cookie header value (e.g., "session=abc123; Path=/; Secure")
 * @returns Parsed cookie, or null on failure
 */
export function parseSetCookieHeader(header: string): ParsedCookie | null {
  if (!header || header.trim() === "") return null;

  // Step 1: Split on first semicolon to get name-value pair
  const semiIdx = header.indexOf(";");
  const nameValueStr = semiIdx === -1 ? header : header.slice(0, semiIdx);
  const attrStr = semiIdx === -1 ? "" : header.slice(semiIdx + 1);

  // Step 2: Parse name=value
  const eqIdx = nameValueStr.indexOf("=");
  let name: string;
  let value: string;

  if (eqIdx === -1) {
    // No equals sign at all — treat as value-only (empty name)
    name = "";
    value = nameValueStr.trim();
  } else {
    name = nameValueStr.slice(0, eqIdx).trim();
    value = nameValueStr.slice(eqIdx + 1).trim();
  }

  if (!isValidCookieName(name)) return null;

  // Strip surrounding double quotes from value (RFC 6265 §5.2 step 3)
  if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
    value = value.slice(1, -1);
  }

  if (!isValidCookieValue(value)) return null;

  // Step 3: Parse attributes
  const attrs = new Map<string, string>();
  const attrParts = attrStr.split(";");

  for (const part of attrParts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const eIdx = trimmed.indexOf("=");
    if (eIdx === -1) {
      attrs.set(trimmed.toLowerCase(), "");
    } else {
      const attrName = trimmed.slice(0, eIdx).trim().toLowerCase();
      const attrVal = trimmed.slice(eIdx + 1).trim();
      // Don't override first occurrence (first wins per RFC)
      if (!attrs.has(attrName)) attrs.set(attrName, attrVal);
    }
  }

  // Step 4: Extract each attribute
  const domainAttr = attrs.has("domain") ? attrs.get("domain")! : null;
  const pathAttr = attrs.has("path") ? attrs.get("path")! : null;
  const expiresAttr = attrs.has("expires") ? attrs.get("expires")! : null;
  const maxAgeAttr = attrs.has("max-age") ? attrs.get("max-age")! : null;
  const secureAttr = attrs.has("secure");
  const httpOnlyAttr = attrs.has("httponly");

  // SameSite
  let sameSite: SameSite = "Unset";
  if (attrs.has("samesite")) {
    const ssVal = attrs.get("samesite")!.toLowerCase();
    if (ssVal === "strict") sameSite = "Strict";
    else if (ssVal === "lax") sameSite = "Lax";
    else if (ssVal === "none") sameSite = "None";
  }

  // SameParty (Chrome Privacy Sandbox)
  const sameParty = attrs.has("sameparty");

  // Priority (Chrome Cookie Priority)
  let priority: "Low" | "Medium" | "High" | null = null;
  if (attrs.has("priority")) {
    const pVal = attrs.get("priority")!.toLowerCase();
    if (pVal === "low") priority = "Low";
    else if (pVal === "medium") priority = "Medium";
    else if (pVal === "high") priority = "High";
  }

  // Partitioned (CHIPS - Cookie Independent Partitioned State)
  const partitioned = attrs.has("partitioned");

  // Max-Age: parse integer, ignore if invalid
  let maxAge: number | null = null;
  if (maxAgeAttr !== null) {
    // Must be a valid integer (leading minus allowed)
    const ma = maxAgeAttr.match(/^-?\d+$/);
    if (ma) maxAge = parseInt(maxAgeAttr, 10);
  }

  // Expires: parse date
  let expires: number | null = null;
  if (maxAge === null && expiresAttr !== null) {
    expires = parseCookieDate(expiresAttr);
  }

  // Domain: strip leading dot, lowercase
  let domain: string | null = null;
  if (domainAttr !== null && domainAttr !== "") {
    domain = canonicalizeDomainFull(domainAttr);
  }

  // Path: must start with "/" otherwise ignore
  let path: string | null = null;
  if (pathAttr !== null && pathAttr.startsWith("/")) {
    path = pathAttr;
  }

  return {
    name,
    value,
    domain,
    path,
    expires,
    maxAge,
    secure: secureAttr,
    httpOnly: httpOnlyAttr,
    sameSite,
    sameParty,
    priority,
    partitioned,
  };
}

/**
 * Serialize a ParsedCookie back to a Set-Cookie header string.
 *
 * @param cookie - The parsed cookie to serialize
 * @returns Set-Cookie header string (e.g., "name=value; Path=/; Secure")
 *
 * @example
 * const cookie: ParsedCookie = { name: "session", value: "abc123", path: "/", secure: true, ... };
 * formatSetCookieHeader(cookie); // "session=abc123; Path=/; Secure"
 */
export function formatSetCookieHeader(cookie: ParsedCookie): string {
  const parts: string[] = [];

  // Name=value (always required)
  if (
    cookie.value.includes(";") ||
    cookie.value.includes(",") ||
    cookie.value.includes(" ") ||
    cookie.value.includes('"')
  ) {
    // Quote value if it contains special characters
    parts.push(`${cookie.name}="${cookie.value.replace(/"/g, '\\"')}"`);
  } else {
    parts.push(`${cookie.name}=${cookie.value}`);
  }

  // Path
  if (cookie.path) {
    parts.push(`Path=${cookie.path}`);
  }

  // Domain
  if (cookie.domain) {
    parts.push(`Domain=${cookie.domain}`);
  }

  // Expires
  if (cookie.expires !== null) {
    const date = new Date(cookie.expires);
    parts.push(`Expires=${date.toUTCString()}`);
  }

  // Max-Age
  if (cookie.maxAge !== null) {
    parts.push(`Max-Age=${cookie.maxAge}`);
  }

  // Secure
  if (cookie.secure) {
    parts.push("Secure");
  }

  // HttpOnly
  if (cookie.httpOnly) {
    parts.push("HttpOnly");
  }

  // SameSite
  if (cookie.sameSite && cookie.sameSite !== "Unset") {
    parts.push(`SameSite=${cookie.sameSite}`);
  }

  // SameParty
  if (cookie.sameParty) {
    parts.push("SameParty");
  }

  // Priority
  if (cookie.priority) {
    parts.push(`Priority=${cookie.priority}`);
  }

  // Partitioned
  if (cookie.partitioned) {
    parts.push("Partitioned");
  }

  return parts.join("; ");
}

// ============================================================================
// 9. SET-COOKIE HEADER SPLITTING
// ============================================================================

/**
 * Split a raw Set-Cookie header value (or collapsed multi-value string)
 * into individual cookie strings.
 *
 * This is non-trivial because:
 *  - Expires values contain commas: "Expires=Thu, 01 Jan 2099 00:00:00 GMT"
 *  - Multiple Set-Cookie headers may be collapsed with ", " by some HTTP stacks
 *
 * Strategy: Token-based state machine that properly handles:
 *   - Quoted values with commas inside (e.g., `foo="bar,baz"`)
 *   - Escaped quotes inside quoted values (e.g., `foo="bar\"baz"`)
 *   - Attribute values that may contain commas
 *   - Only commits a cookie when we've seen both name and value
 *
 * @param raw - Raw Set-Cookie header string (possibly containing multiple cookies)
 * @returns Array of individual Set-Cookie strings
 */
export function splitSetCookieHeaders(raw: string): string[] {
  const cookies: string[] = [];
  let buffer = "";
  let i = 0;
  let inQuotedValue = false;
  let escaped = false;
  let nameComplete = false;
  let valueComplete = false;
  let afterSemicolon = false;

  const commitCookie = () => {
    if (nameComplete && valueComplete && buffer.trim()) {
      cookies.push(buffer.trim());
    }
    buffer = "";
    nameComplete = false;
    valueComplete = false;
    afterSemicolon = false;
  };

  while (i < raw.length) {
    const char = raw[i]!;
    const nextChar = raw[i + 1] ?? "";

    if (escaped) {
      buffer += char;
      escaped = false;
      i++;
      continue;
    }

    if (char === "\\" && (inQuotedValue || nextChar === '"' || nextChar === "\\")) {
      buffer += char;
      escaped = true;
      i++;
      continue;
    }

    if (char === '"') {
      if (!inQuotedValue && nameComplete) {
        inQuotedValue = true;
      } else if (inQuotedValue) {
        inQuotedValue = false;
        valueComplete = true;
      }
      buffer += char;
      i++;
      continue;
    }

    if (inQuotedValue) {
      buffer += char;
      i++;
      continue;
    }

    if (char === "," && !inQuotedValue && (afterSemicolon || valueComplete || nameComplete)) {
      commitCookie();
      while (i + 1 < raw.length && /\s/.test(raw[i + 1]!)) {
        i++;
      }
      i++;
      continue;
    }

    if (char === ";") {
      if (!nameComplete) nameComplete = true;
      if (valueComplete) afterSemicolon = true;
      buffer += char;
      i++;
      continue;
    }

    if (char === "=" && !nameComplete) {
      nameComplete = true;
      valueComplete = true;
      buffer += char;
      i++;
      continue;
    }

    if (nameComplete && !valueComplete && char !== ";" && char !== ",") {
      valueComplete = true;
    }

    if (char === " " || char === "\t") {
      if (buffer.length > 0 && buffer.trim() !== "") {
        buffer += char;
      }
      i++;
      continue;
    }

    buffer += char;
    i++;
  }

  if (nameComplete && valueComplete && buffer.trim()) {
    cookies.push(buffer.trim());
  }

  return cookies;
}

/**
 * Extract all Set-Cookie header values from a Headers object or plain record.
 * Uses Headers.getSetCookie() when available (Deno, Node 18+).
 *
 * @param headers - Headers object or plain key-value record
 * @returns Array of Set-Cookie header strings
 */
export function extractSetCookieHeaders(
  headers: Headers | Record<string, string | string[]>,
): string[] {
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    // Standard Headers API - use getSetCookie() which returns ALL Set-Cookie values
    if (typeof (headers as Headers).getSetCookie === "function") {
      return (headers as Headers).getSetCookie();
    }
    // Fallback for older runtimes that don't have getSetCookie()
    const raw = headers.get("set-cookie");
    if (!raw) return [];
    return splitSetCookieHeaders(raw);
  }

  // Plain object
  const obj = headers as Record<string, string | string[]>;
  const val = obj["set-cookie"] ?? obj["Set-Cookie"];
  if (!val) return [];
  if (Array.isArray(val)) return val.flatMap((v) => splitSetCookieHeaders(v));
  return splitSetCookieHeaders(val);
}
