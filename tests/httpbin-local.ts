/**
 * A local, httpbin-compatible server for the test suite.
 *
 * The suite was built against live third-party services — httpbin.org above
 * all, with 608 references across 27 files. That makes a green run depend on
 * someone else's uptime, latency and DNS: a baseline run of this repository
 * failed five tests purely because the host's resolver answered differently
 * than expected, and `nghttp2.org` stopped resolving outright at one point,
 * which is not a statement about this library.
 *
 * This serves the subset the suite actually uses, on loopback, with no
 * dependencies and no network. Start it by calling `httpbinBaseUrl()`, which
 * brings the server up on first use and returns its origin:
 *
 * ```ts
 * const client = kinetex({ baseURL: await httpbinBaseUrl() });
 * ```
 *
 * The server is `unref`'d, so it never keeps the process alive on its own.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  createSecureServer,
  Http2ServerRequest,
  Http2ServerResponse,
  type Http2SecureServer,
} from "node:http2";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";

/** Endpoints and behaviours implemented, for the suite to check against. */
const DELAY_CAP_MS = 2_000;

/**
 * A fixed port, so repointing a suite is a literal substitution of
 * `https://httpbin.org` for `HTTPBIN_LOCAL_ORIGIN` rather than a change to
 * every construction site. A small range is tried so a stale listener from an
 * interrupted run does not block startup; exhausting it is a loud failure
 * rather than a silent fallback, because a fallback would mean the substituted
 * URLs pointed nowhere.
 */
export const HTTPBIN_LOCAL_PORT = 18080;
const GRAPHQL_COUNTRIES: Record<
  string,
  { name: string; capital: string; currency: string; native: string; phone: string }
> = {
  US: {
    name: "United States",
    capital: "Washington D.C.",
    currency: "USD",
    native: "United States",
    phone: "1",
  },
  DE: { name: "Germany", capital: "Berlin", currency: "EUR", native: "Deutschland", phone: "49" },
  JP: { name: "Japan", capital: "Tokyo", currency: "JPY", native: "日本", phone: "81" },
  MX: { name: "Mexico", capital: "Mexico City", currency: "MXN", native: "México", phone: "52" },
  FR: { name: "France", capital: "Paris", currency: "EUR", native: "France", phone: "33" },
};

export const HTTPBIN_LOCAL_ORIGIN = `http://127.0.0.1:${HTTPBIN_LOCAL_PORT}`;

// ── TLS / HTTP2 origin ────────────────────────────────────────────────────────
//
// HTTP/2 is negotiated over ALPN, so a plain-HTTP listener cannot exercise it
// at all. That is why every h2 test used to point at a public origin. This is
// the same request handler behind TLS, advertising both `http/1.1` and `h2`, so
// a client can be pointed at it with either `httpVersion` and get a real answer.
export const HTTPBIN_LOCAL_TLS_PORT = 18443;
export const HTTPBIN_LOCAL_TLS_ORIGIN = `https://localhost:${HTTPBIN_LOCAL_TLS_PORT}`;
export const HTTPBIN_LOCAL_TLS_ORIGIN_IP = `https://127.0.0.1:${HTTPBIN_LOCAL_TLS_PORT}`;

/** The fixture certificate, as a CA a test client can be given. */
export const LOCAL_TLS_CA = readFileSync(
  fileURLToPath(new URL("./fixtures/localhost-cert.pem", import.meta.url)),
  "utf8",
);
const LOCAL_TLS_KEY = readFileSync(
  fileURLToPath(new URL("./fixtures/localhost-key.pem", import.meta.url)),
  "utf8",
);

let server: Server | undefined;
let tlsServer: Http2SecureServer | undefined;
let origin = "";
let starting: Promise<string> | undefined;
let tlsStarting: Promise<string> | undefined;

/** Cookies the server remembers across `/cookies/set`. */
const jar = new Map<string, string>();

/**
 * Optional pretty-printing.
 *
 * Verified against jsonplaceholder, whose JSON endpoints answer with two-space
 * indentation: `/posts/1` is 292 bytes pretty-printed and 275 compact. A test
 * that asserts an exact body length is asserting that shape, so the server has
 * to be able to reproduce it. Everything else stays compact.
 */
function jsonPretty(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...extra,
  });
  res.end(payload);
}

/**
 * The RFC 2617 §3.2.2 response, computed from the formula directly.
 *
 * Deliberately a second implementation rather than a call into the library: a
 * fixture that used the code under test could only ever agree with it. This one
 * is pinned by the RFC's own published test vector, which
 * `tests/digest.test.mts` checks the library against.
 */
function rfc2617DigestResponse(
  challenge: { realm: string; nonce: string; qop: string; opaque: string },
  username: string,
  password: string,
  method: string,
  uri: string,
  cnonce: string | undefined,
  nc: string | undefined,
): string {
  const md5 = (input: string): string => createHash("md5").update(input).digest("hex");
  const qop = challenge.qop || "";
  const cnonceValue = cnonce || "0a4f113b";
  const ncValue = nc || "00000001";
  // HA1 = H(username:realm:password); HA2 = H(method:uri)
  const ha1 = md5(`${username}:${challenge.realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  return md5([ha1, challenge.nonce, ncValue, cnonceValue, qop, ha2].join(":"));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * Header name/value pairs in the casing the client sent them.
 *
 * `rawHeaders` is a flat [name, value, name, value, ...] list, and a repeated
 * header appears once per occurrence — which matches how httpbin reports them.
 */
/** The origin the client used, reconstructed from the Host header. */
function originOf(req: IncomingMessage): string {
  // The scheme is inferred from the socket, so the TLS origin echoes `https://`
  // rather than claiming plain http. httpbin reports the URL it was actually
  // reached on, and a test asserting on it would otherwise read the wrong one.
  const scheme = (req.socket as { encrypted?: boolean }).encrypted === true ? "https" : "http";
  // HTTP/2 carries the authority in `:authority`; reading only `host` produced
  // an origin with no port, so the echoed URL did not match what was requested.
  const authority =
    (req.headers[":authority"] as string | undefined) ?? req.headers.host ?? "127.0.0.1";
  return `${scheme}://${authority}`;
}

/**
 * The request URL as httpbin reports it: origin + path, decoded.
 *
 * Upstream echoes `/anything/special%2Fpath` as `/anything/special/path` — the
 * segments are decoded before the echo — so the same normalisation applies
 * here. `new URL(...)` already hands back the decoded pathname.
 */
function echoedUrl(req: IncomingMessage, origin: string): string {
  const raw = req.url ?? "/";
  const [pathPart, query = ""] = raw.split("?", 2);
  let decoded = pathPart;
  try {
    // `URL.pathname` preserves percent-encoding, so the segments are decoded
    // explicitly — upstream echoes `special%2Fpath` as `special/path`.
    decoded = decodeURIComponent(pathPart);
  } catch {
    // A malformed escape sequence is echoed as sent rather than throwing.
  }
  return query ? `${origin}${decoded}?${query}` : `${origin}${decoded}`;
}

function rawHeaderEntries(req: IncomingMessage): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const raw = req.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) out.push([raw[i], raw[i + 1]]);
  return out;
}

/** Query parameters, with repeats collapsed into an array as httpbin does. */
function queryArgs(req: IncomingMessage): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of new URL(req.url ?? "/", "http://x").searchParams) {
    const seen = out[k];
    if (seen === undefined) out[k] = v;
    else if (Array.isArray(seen)) seen.push(v);
    else out[k] = [seen, v];
  }
  return out;
}

const IMAGE_PNG_BASE64 = [
  "iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAIAAAD/gAIDAABONklEQVR4nAzQAUczAQCA4ZkzM+fMOefMnDNzZmZmZmbmzJlz",
  "ZmbOOTMzZ2ZmJkmSZF5JkiRJkiRJkiRJkiRJv+v7np/wRCIRohGECLEI8QiJCGIEKUIyghxBiaBG0CKkIqQj6BGMCJkI2Qhm",
  "hFyEfIRChGKEUoRyhEqEaoRahHqERgQrQjOCHaEVwYngRmhH6EToRuhF8CL4EYII/QiDCMMIowhhhHGESYRphFmEeYRFhJUI",
  "qxHWIqxH2IiwGWErwnaEZQQi7ETYjbAXYT/CQYTDCEcRjiOcRDiNcBbhPMJFhMsIVxGuI9xEuI1wF+E+wkOExwhPEZ4jvER4",
  "jfAW4T3CR4TPCF8RviP8RPiN8BchEokSjSJEiUWJR0lEEaNIUZJR5ChKFDWKFiUVJR1Fj2JEyUTJRjGj5KLkoxSiFKOUopSj",
  "VKJUo9Si1KM0olhRmlHsKK0oThQ3SjtKJ0o3Si+KF8WPEkTpRxlEGUYZRQmjjKNMokyjzKLMoyyirERZjbIWZT3KRpTNKFtR",
  "tqMsoxBlJ8pulL0o+1EOohxGOYpyHOUkymmUsyjnUS6iXEa5inId5SbKbZS7KPdRHqI8RnmK8hzlJcprlLco71E+onxG+Yry",
  "HeUnym+Uv+j/LIGogCAQE4gLJAREAUkgKSALKAKqgCaQEkgL6AKGQEYgK2AK5ATyAgWBokBJoCxQEagK1ATqAg0BS6ApYAu0",
  "BBwBV6At0BHoCvQEPAFfIBDoCwwEhgIjgVBgLDARmArMBOYCC4EVgVWBNYF1gQ2BTYEtgW2BpQACOwK7AnsC+wIHAocCRwLH",
  "AicCpwJnAucCFwKXAlcC1wI3ArcCdwL3Ag8CjwJPAs8CLwKvAm8C7wIfAp8CXwLfAj8CvwJ/wv+sGNEYQoxYjHiMRAwxhhQj",
  "GUOOocRQY2gxUjHSMfQYRoxMjGwMM0YuRj5GIUYxRilGOUYlRjVGLUY9RiOGFaMZw47RiuHEcGO0Y3RidGP0Yngx/BhBjH6M",
  "QYxhjFGMMMY4xiTGNMYsxjzGIsZKjNUYazHWY2zE2IyxFWM7xjIGMXZi7MbYi7Ef4yDGYYyjGMcxTmKcxjiLcR7jIsZljKsY",
  "1zFuYtzGuItxH+MhxmOMpxjPMV5ivMZ4i/Ee4yPGZ4yvGN8xfmL8xviL/c+KE40jxInFicdJxBHjSHGSceQ4Shw1jhYnFScd",
  "R49jxMnEycYx4+Ti5OMU4hTjlOKU41TiVOPU4tTjNOJYcZpx7DitOE4cN047TidON04vjhfHjxPE6ccZxBnGGcUJ44zjTOJM",
  "48zizOMs4qzEWY2zFmc9zkaczThbcbbjLOMQZyfObpy9OPtxDuIcxjmKcxznJM5pnLM453Eu4lzGuYpzHecmzm2cuzj3cR7i",
  "PMZ5ivMc5yXOa5y3OO9xPuJ8xvmK8x3nJ85vnL/4/6wE0QRCgliCeIJEAjGBlCCZQE6gJFATaAlSCdIJ9ARGgkyCbAIzQS5B",
  "PkEhQTFBKUE5QSVBNUEtQT1BI4GVoJnATtBK4CRwE7QTdBJ0E/QSeAn8BEGCfoJBgmGCUYIwwTjBJME0wSzBPMEiwUqC1QRr",
  "CdYTbCTYTLCVYDvBMgEJdhLsJthLsJ/gIMFhgqMExwlOEpwmOEtwnuAiwWWCqwTXCW4S3Ca4S3Cf4CHBY4KnBM8JXhK8JnhL",
  "8J7gI8Fngq8E3wl+Evwm+Ev8zxKJiggiMZG4SEJEFJFEkiKyiCKiimgiKZG0iC5iiGREsiKmSE4kL1IQKYqURMoiFZGqSE2k",
  "LtIQsUSaIrZIS8QRcUXaIh2RrkhPxBPxRQKRvshAZCgyEglFxiITkanITGQushBZEVkVWRNZF9kQ2RTZEtkWWYogsiOyK7In",
  "si9yIHIociRyLHIicipyJnIuciFyKXIlci1yI3IrcidyL/Ig8ijyJPIs8iLyKvIm8i7yIfIp8iXyLfIj8ivyJ/7PkohKCBIx",
  "ibhEQkKUkCSSErKEIqFKaBIpibSELmFIZCSyEqZETiIvUZAoSpQkyhIViapETaIu0ZCwJJoStkRLwpFwJdoSHYmuRE/Ck/Al",
  "Aom+xEBiKDGSCCXGEhOJqcRMYi6xkFiRWJVYk1iX2JDYlNiS2JZYSiCxI7ErsSexL3EgcShxJHEscSJxKnEmcS5xIXEpcSVx",
  "LXEjcStxJ3Ev8SDxKPEk8SzxIvEq8SbxLvEh8SnxJfEt8SPxK/En/c9KEk0iJIkliSdJJBGTSEmSSeQkShI1iZYklSSdRE9i",
  "JMkkySYxk+SS5JMUkhSTlJKUk1SSVJPUktSTNJJYSZpJ7CStJE4SN0k7SSdJN0kviZfETxIk6ScZJBkmGSUJk4yTTJJMk8yS",
  "zJMskqwkWU2ylmQ9yUaSzSRbSbaTLJOQZCfJbpK9JPtJDpIcJjlKcpzkJMlpkrMk50kuklwmuUpyneQmyW2SuyT3SR6SPCZ5",
  "SvKc5CXJa5K3JO9JPpJ8JvlK8p3kJ8lvkr/k/yyZqIwgE5OJyyRkRBlJJikjyygyqowmk5JJy+gyhkxGJitjyuRk8jIFmaJM",
  "SaYsU5GpytRk6jINGUumKWPLtGQcGVemLdOR6cr0ZDwZXyaQ6csMZIYyI5lQZiwzkZnKzGTmMguZFZlVmTWZdZkNmU2ZLZlt",
  "maUMMjsyuzJ7MvsyBzKHMkcyxzInMqcyZzLnMhcylzJXMtcyNzK3Mncy9zIPMo8yTzLPMi8yrzJvMu8yHzKfMl8y3zI/Mr8y",
  "f/L/LIWogqAQU4grJBREBUkhqSArKAqqgqaQUkgr6AqGQkYhq2Aq5BTyCgWFokJJoaxQUagq1BTqCg0FS6GpYCu0FBwFV6Gt",
  "0FHoKvQUPAVfIVDoKwwUhgojhVBhrDBRmCrMFOYKC4UVhVWFNYV1hQ2FTYUthW2FpQIKOwq7CnsK+woHCocKRwrHCicKpwpn",
  "CucKFwqXClcK1wo3CrcKdwr3Cg8KjwpPCs8KLwqvCm8K7wofCp8KXwrfCj8Kvwp/yv8slaiKoBJTiaskVEQVSSWpIqsoKqqK",
  "ppJSSavoKoZKRiWrYqrkVPIqBZWiSkmlrFJRqarUVOoqDRVLpaliq7RUHBVXpa3SUemq9FQ8FV8lUOmrDFSGKiOVUGWsMlGZ",
  "qsxU5ioLlRWVVZU1lXWVDZVNlS2VbZWlCio7Krsqeyr7KgcqhypHKscqJyqnKmcq5yoXKpcqVyrXKjcqtyp3KvcqDyqPKk8q",
  "zyovKq8qbyrvKh8qnypfKt8qPyq/Kn/q/yyNqIagEdOIayQ0RA1JI6khaygaqoamkdJIa+gahkZGI6thauQ08hoFjaJGSaOs",
  "UdGoatQ06hoNDUujqWFrtDQcDVejrdHR6Gr0NDwNXyPQ6GsMNIYaI41QY6wx0ZhqzDTmGguNFY1VjTWNdY0NjU2NLY1tjaUG",
  "Gjsauxp7GvsaBxqHGkcaxxonGqcaZxrnGhcalxpXGtcaNxq3Gnca9xoPGo8aTxrPGi8arxpvGu8aHxqfGl8a3xo/Gr8af9r/",
  "rBTRFEKKWIp4ikQKMYWUIplCTqGkUFNoKVIp0in0FEaKTIpsCjNFLkU+RSFFMUUpRTlFJUU1RS1FPUUjhZWimcJO0UrhpHBT",
  "tFN0UnRT9FJ4KfwUQYp+ikGKYYpRijDFOMUkxTTFLMU8xSLFSorVFGsp1lNspNhMsZViO8UyBSl2Uuym2Euxn+IgxWGKoxTH",
  "KU5SnKY4S3Ge4iLFZYqrFNcpblLcprhLcZ/iIcVjiqcUzyleUrymeEvxnuIjxWeKrxTfKX5S/Kb4S/3PShNNI6SJpYmnSaQR",
  "00hpkmnkNEoaNY2WJpUmnUZPY6TJpMmmMdPk0uTTFNIU05TSlNNU0lTT1NLU0zTSWGmaaew0rTROGjdNO00nTTdNL42Xxk8T",
  "pOmnGaQZphmlCdOM00zSTNPM0szTLNKspFlNs5ZmPc1Gms00W2m20yzTkGYnzW6avTT7aQ7SHKY5SnOc5iTNaZqzNOdpLtJc",
  "prlKc53mJs1tmrs092ke0jymeUrznOYlzWuatzTvaT7SfKb5SvOd5ifNb5q/9P8snaiOoBPTieskdEQdSSepI+soOqqOppPS",
  "SevoOoZORierY+rkdPI6BZ2iTkmnrFPRqerUdOo6DR1Lp6lj67R0HB1Xp63T0enq9HQ8HV8n0OnrDHSGOiOdUGesM9GZ6sx0",
  "5joLnRWdVZ01nXWdDZ1NnS2dbZ2lDjo7Ors6ezr7Ogc6hzpHOsc6JzqnOmc65zoXOpc6VzrXOjc6tzp3Ovc6DzqPOk86zzov",
  "Oq86bzrvOh86nzpfOt86Pzq/On/6/yyDqIFgEDOIGyQMRAPJIGkgGygGqoFmkDJIG+gGhkHGIGtgGuQM8gYFg6JByaBsUDGo",
  "GtQM6gYNA8ugaWAbtAwcA9egbdAx6Br0DDwD3yAw6BsMDIYGI4PQYGwwMZgazAzmBguDFYNVgzWDdYMNg02DLYNtg6UBBjsG",
  "uwZ7BvsGBwaHBkcGxwYnBqcGZwbnBhcGlwZXBtcGNwa3BncG9wYPBo8GTwbPBi8GrwZvBu8GHwafBl8G3wY/Br8Gf8b/rAzR",
  "DEKGWIZ4hkQGMYOUIZlBzqBkUDNoGVIZ0hn0DEaGTIZsBjNDLkM+QyFDMUMpQzlDJUM1Qy1DPUMjg5WhmcHO0MrgZHAztDN0",
  "MnQz9DJ4GfwMQYZ+hkGGYYZRhjDDOMMkwzTDLMM8wyLDSobVDGsZ1jNsZNjMsJVhO8MyAxl2Muxm2Muwn+Egw2GGowzHGU4y",
  "nGY4y3Ce4SLDZYarDNcZbjLcZrjLcJ/hIcNjhqcMzxleMrxmeMvwnuEjw2eGrwzfGX4y/Gb4y/zPyhLNImSJZYlnSWQRs0hZ",
  "klnkLEoWNYuWJZUlnUXPYmTJZMlmMbPksuSzFLIUs5SylLNUslSz1LLUszSyWFmaWewsrSxOFjdLO0snSzdLL4uXxc8SZOln",
  "GWQZZhllCbOMs0yyTLPMssyzLLKsZFnNspZlPctGls0sW1m2syyzkGUny26WvSz7WQ6yHGY5ynKc5STLaZazLOdZLrJcZrnK",
  "cp3lJsttlrss91kesjxmecrynOUly2uWtyzvWT6yfGb5yvKd5SfLb5a/7P8sk6iJYBIziZskTEQTySRpIpsoJqqJZpIySZvo",
  "JoZJxiRrYprkTPImBZOiScmkbFIxqZrUTOomDRPLpGlim7RMHBPXpG3SMema9Ew8E98kMOmbDEyGJiOT0GRsMjGZmsxM5iYL",
  "kxWTVZM1k3WTDZNNky2TbZOlCSY7Jrsmeyb7JgcmhyZHJscmJyanJmcm5yYXJpcmVybXJjcmtyZ3JvcmDyaPJk8mzyYvJq8m",
  "bybvJh8mnyZfJt8mPya/Jn/m/6wc0RxCjliOeI5EDjGHlCOZQ86h5FBzaDlSOdI59BxGjkyObA4zRy5HPkchRzFHKUc5RyVH",
  "NUctRz1HI4eVo5nDztHK4eRwc7RzdHJ0c/RyeDn8HEGOfo5BjmGOUY4wxzjHJMc0xyzHPMcix0qO1RxrOdZzbOTYzLGVYzvH",
  "Mgc5dnLs5tjLsZ/jIMdhjqMcxzlOcpzmOMtxnuMix2WOqxzXOW5y3Oa4y3Gf4yHHY46nHM85XnK85njL8Z7jI8dnjq8c3zl+",
  "cvzm+Mv9z8oTzSPkieWJ50nkEfNIeZJ55DxKHjWPlieVJ51Hz2PkyeTJ5jHz5PLk8xTyFPOU8pTzVPJU89Ty1PM08lh5mnns",
  "PK08Th43TztPJ083Ty+Pl8fPE+Tp5xnkGeYZ5QnzjPNM8kzzzPLM8yzyrORZzbOWZz3PRp7NPFt5tvMs85BnJ89unr08+3kO",
  "8hzmOcpznOckz2meszzneS7yXOa5ynOd5ybPbZ67PPd5HvI85nnK85znJc9rnrc873k+8nzm+crznecnz2+ev/z/rALRAkKB",
  "WIF4gUQBsYBUIFlALqAUUAtoBVIF0gX0AkaBTIFsAbNArkC+QKFAsUCpQLlApUC1QK1AvUCjgFWgWcAu0CrgFHALtAt0CnQL",
  "9Ap4BfwCQYF+gUGBYYFRgbDAuMCkwLTArMC8wKLASoHVAmsF1gtsFNgssFVgu8CyAAV2CuwW2CuwX+CgwGGBowLHBU4KnBY4",
  "K3Be4KLAZYGrAtcFbgrcFrgrcF/gocBjgacCzwVeCrwWeCvwXuCjwGeBrwLfBX4K/Bb4K/zPKhItIhSJFYkXSRQRi0hFkkXk",
  "IkoRtYhWJFUkXUQvYhTJFMkWMYvkiuSLFIoUi5SKlItUilSL1IrUizSKWEWaRewirSJOEbdIu0inSLdIr4hXxC8SFOkXGRQZ",
  "FhkVCYuMi0yKTIvMisyLLIqsFFktslZkvchGkc0iW0W2iyyLUGSnyG6RvSL7RQ6KHBY5KnJc5KTIaZGzIudFLopcFrkqcl3k",
  "pshtkbsi90UeijwWeSryXOSlyGuRtyLvRT6KfBb5KvJd5KfIb5G/4v+sEtESQolYiXiJRAmxhFQiWUIuoZRQS2glUiXSJfQS",
  "RolMiWwJs0SuRL5EoUSxRKlEuUSlRLVErUS9RKOEVaJZwi7RKuGUcEu0S3RKdEv0Sngl/BJBiX6JQYlhiVGJsMS4xKTEtMSs",
  "xLzEosRKidUSayXWS2yU2CyxVWK7xLIEJXZK7JbYK7Ff4qDEYYmjEsclTkqcljgrcV7iosRliasS1yVuStyWuCtxX+KhxGOJ",
  "pxLPJV5KvJZ4K/Fe4qPEZ4mvEt8lfkr8lvgr/c8qEy0jlImViZdJlBHLSGWSZeQyShm1jFYmVSZdRi9jlMmUyZYxy+TK5MsU",
  "yhTLlMqUy1TKVMvUytTLNMpYZZpl7DKtMk4Zt0y7TKdMt0yvjFfGLxOU6ZcZlBmWGZUJy4zLTMpMy8zKzMssyqyUWS2zVma9",
  "zEaZzTJbZbbLLMtQZqfMbpm9MvtlDsocljkqc1zmpMxpmbMy52UuylyWuSpzXeamzG2ZuzL3ZR7KPJZ5KvNc5qXMa5m3Mu9l",
  "Psp8lvkq813mp8xvmb/y/6wK0QpChViFeIVEBbGCVCFZQa6gVFAraBVSFdIV9ApGhUyFbAWzQq5CvkKhQrFCqUK5QqVCtUKt",
  "Qr1Co4JVoVnBrtCq4FRwK7QrdCp0K/QqeBX8CkGFfoVBhWGFUYWwwrjCpMK0wqzCvMKiwkqF1QprFdYrbFTYrLBVYbvCsgIV",
  "dirsVtirsF/hoMJhhaMKxxVOKpxWOKtwXuGiwmWFqwrXFW4q3Fa4q3Bf4aHCY4WnCs8VXiq8Vnir8F7ho8Jnha8K3xV+KvxW",
  "+Kv8z6oSrSJUiVWJV0lUEatIVZJV5CpKFbWKViVVJV1Fr2JUyVTJVjGr5KrkqxSqFKuUqpSrVKpUq9Sq1Ks0qlhVmlXsKq0q",
  "ThW3SrtKp0q3Sq+KV8WvElTpVxlUGVYZVQmrjKtMqkyrzKrMqyyqrFRZrbJWZb3KRpXNKltVtqssq1Blp8pulb0q+1UOqhxW",
  "OapyXOWkymmVsyrnVS6qXFa5qnJd5abKbZW7KvdVHqo8Vnmq8lzlpcprlbcq71U+qnxW+aryXeWnym+Vv+r/rBrRGkKNWI14",
  "jUQNsYZUI1lDrqHUUGtoNVI10jX0GkaNTI1sDbNGrka+RqFGsUapRrlGpUa1Rq1GvUajhlWjWcOu0arh1HBrtGt0anRr9Gp4",
  "NfwaQY1+jUGNYY1RjbDGuMakxrTGrMa8xqLGSo3VGms11mts1NissVVju8ayBjV2auzW2KuxX+OgxmGNoxrHNU5qnNY4q3Fe",
  "46LGZY2rGtc1bmrc1rircV/jocZjjacazzVearzWeKvxXuOjxmeNrxrfNX5q/Nb4q/3PqhOtI9SJ1YnXSdQR60h1knXkOkod",
  "tY5WJ1UnXUevY9TJ1MnWMevk6uTrFOoU65TqlOtU6lTr1OrU6zTqWHWadew6rTpOHbdOu06nTrdOr45Xx68T1OnXGdQZ1hnV",
  "CeuM60zqTOvM6szrLOqs1Fmts1Znvc5Gnc06W3W26yzrUGenzm6dvTr7dQ7qHNY5qnNc56TOaZ2zOud1Lupc1rmqc13nps5t",
  "nbs693Ue6jzWearzXOelzmudtzrvdT7qfNb5qvNd56fOb52/+v+sBtEGQoNYg3iDRAOxgdQg2UBuoDRQG2gNUg3SDfQGRoNM",
  "g2wDs0GuQb5BoUGxQalBuUGlQbVBrUG9QaOB1aDZwG7QauA0cBu0G3QadBv0GngN/AZBg36DQYNhg1GDsMG4waTBtMGswbzB",
  "osFKg9UGaw3WG2w02Gyw1WC7wbIBDXYa7DbYa7Df4KDBYYOjBscNThqcNjhrcN7gosFlg6sG1w1uGtw2uGtw3+ChwWODpwbP",
  "DV4avDZ4a/De4KPBZ4OvBt8Nfhr8Nvhr/M+yiFoIFjGLuEXCQrSQLJIWsoVioVpoFimLtIVuYVhkLLIWpkXOIm9RsChalCzK",
  "FhWLqkXNom7RsLAsmha2RcvCsXAt2hYdi65Fz8Kz8C0Ci77FwGJoMbIILcYWE4upxcxibrGwWLFYtVizWLfYsNi02LLYtlha",
  "YLFjsWuxZ7FvcWBxaHFkcWxxYnFqcWZxbnFhcWlxZXFtcWNxa3FncW/xYPFo8WTxbPFi8WrxZvFu8WHxafFl8W3xY/Fr8Wf9",
  "z2oSbSI0iTWJN0k0EZtITZJN5CZKE7WJ1iTVJN1Eb2I0yTTJNjGb5JrkmxSaFJuUmpSbVJpUm9Sa1Js0mlhNmk3sJq0mThO3",
  "SbtJp0m3Sa+J18RvEjTpNxk0GTYZNQmbjJtMmkybzJrMmyyarDRZbbLWZL3JRpPNJltNtpssm9Bkp8luk70m+00Omhw2OWpy",
  "3OSkyWmTsybnTS6aXDa5anLd5KbJbZO7JvdNHpo8Nnlq8tzkpclrk7cm700+mnw2+Wry3eSnyW+Tv+b/LJuojWATs4nbJGxE",
  "G8kmaSPbKDaqjWaTsknb6DaGTcYma2Pa5GzyNgWbok3JpmxTsana1GzqNg0by6ZpY9u0bBwb16Zt07Hp2vRsPBvfJrDp2wxs",
  "hjYjm9BmbDOxmdrMbOY2C5sVm1WbNZt1mw2bTZstm22bpQ02Oza7Nns2+zYHNoc2RzbHNic2pzZnNuc2FzaXNlc21zY3Nrc2",
  "dzb3Ng82jzZPNs82LzavNm827zYfNp82XzbfNj82vzZ/9v+sFtEWQotYi3iLRAuxhdQi2UJuobRQW2gtUi3SLfQWRotMi2wL",
  "s0WuRb5FoUWxRalFuUWlRbVFrUW9RaOF1aLZwm7RauG0cFu0W3RadFv0Wngt/BZBi36LQYthi1GLsMW4xaTFtMWsxbzFosVK",
  "i9UWay3WW2y02Gyx1WK7xbIFLXZa7LbYa7Hf4qDFYYujFsctTlqctjhrcd7iosVli6sW1y1uWty2uGtx3+KhxWOLpxbPLV5a",
  "vLZ4a/He4qPFZ4uvFt8tflr8tvhr/c9yiDoIDjGHuEPCQXSQHJIOsoPioDpoDimHtIPuYDhkHLIOpkPOIe9QcCg6lBzKDhWH",
  "qkPNoe7QcLAcmg62Q8vBcXAd2g4dh65Dz8Fz8B0Ch77DwGHoMHIIHcYOE4epw8xh7rBwWHFYdVhzWHfYcNh02HLYdlg64LDj",
  "sOuw57DvcOBw6HDkcOxw4nDqcOZw7nDhcOlw5XDtcONw63DncO/w4PDo8OTw7PDi8Orw5vDu8OHw6fDl8O3w4/Dr8Of8z3KJ",
  "ugguMZe4S8JFdJFcki6yi+KiumguKZe0i+5iuGRcsi6mS84l71JwKbqUXMouFZeqS82l7tJwsVyaLrZLy8VxcV3aLh2XrkvP",
  "xXPxXQKXvsvAZegycgldxi4Tl6nLzGXusnBZcVl1WXNZd9lw2XTZctl2WbrgsuOy67Lnsu9y4HLocuRy7HLicupy5nLucuFy",
  "6XLlcu1y43Lrcudy7/Lg8ujy5PLs8uLy6vLm8u7y4fLp8uXy7fLj8uvy5/7PahNtI7SJtYm3SbQR20htkm3kNkobtY3WJtUm",
  "3UZvY7TJtMm2Mdvk2uTbFNoU25TalNtU2lTb1NrU2zTaWG2abew2rTZOG7dNu02nTbdNr43Xxm8TtOm3GbQZthm1CduM20za",
  "TNvM2szbLNqstFlts9Zmvc1Gm802W2222yzb0GanzW6bvTb7bQ7aHLY5anPc5qTNaZuzNudtLtpctrlqc93mps1tm7s2920e",
  "2jy2eWrz3OalzWubtzbvbT7afLb5avPd5qfNb5u/9v+sDtEOQodYh3iHRAexg9Qh2UHuoHRQO2gdUh3SHfQORodMh2wHs0Ou",
  "Q75DoUOxQ6lDuUOlQ7VDrUO9Q6OD1aHZwe7Q6uB0cDu0O3Q6dDv0Ongd/A5Bh36HQYdhh1GHsMO4w6TDtMOsw7zDosNKh9UO",
  "ax3WO2x02Oyw1WG7w7IDHXY67HbY67Df4aDDYYejDscdTjqcdjjrcN7hosNlh6sO1x1uOtx2uOtw3+Ghw2OHpw7PHV46vHZ4",
  "6/De4aPDZ4evDt8dfjr8dvjr/M/qEu0idIl1iXdJdBG7SF2SXeQuShe1i9Yl1SXdRe9idMl0yXYxu+S65LsUuhS7lLqUu1S6",
  "VLvUutS7NLpYXZpd7C6tLk4Xt0u7S6dLt0uvi9fF7xJ06XcZdBl2GXUJu4y7TLpMu8y6zLssuqx0We2y1mW9y0aXzS5bXba7",
  "LLvQZafLbpe9LvtdDrocdjnqctzlpMtpl7Mu510uulx2uepy3eWmy22Xuy73XR66PHZ56vLc5aXLa5e3Lu9dPrp8dvnq8t3l",
  "p8tvl7/u/6we0R5Cj1iPeI9ED7GH1CPZQ+6h9FB7aD1SPdI99B5Gj0yPbA+zR65HvkehR7FHqUe5R6VHtUetR71Ho4fVo9nD",
  "7tHq4fRwe7R7dHp0e/R6eD38HkGPfo9Bj2GPUY+wx7jHpMe0x6zHvMeix0qP1R5rPdZ7bPTY7LHVY7vHsgc9dnrs9tjrsd/j",
  "oMdhj6Mexz1Oepz2OOtx3uOix2WPqx7XPW563Pa463Hf46HHY4+nHs89Xnq89njr8d7jo8dnj68e3z1+evz2+Ov9z/KIegge",
  "MY+4R8JD9JA8kh6yh+KhemgeKY+0h+5heGQ8sh6mR84j71HwKHqUPMoeFY+qR82j7tHwsDyaHrZHy8PxcD3aHh2PrkfPw/Pw",
  "PQKPvsfAY+gx8gg9xh4Tj6nHzGPusfBY8Vj1WPNY99jw2PTY8tj2WHrgseOx67Hnse9x4HHoceRx7HHicepx5nHuceFx6XHl",
  "ce1x43Hrcedx7/Hg8ejx5PHs8eLx6vHm8e7x4fHp8eXx7fHj8evx5/3P8on6CD4xn7hPwkf0kXySPrKP4qP6aD4pn7SP7mP4",
  "ZHyyPqZPzifvU/Ap+pR8yj4Vn6pPzafu0/CxfJo+tk/Lx/Fxfdo+HZ+uT8/H8/F9Ap++z8Bn6DPyCX3GPhOfqc/MZ+6z8Fnx",
  "WfVZ81n32fDZ9Nny2fZZ+uCz47Prs+ez73Pgc+hz5HPsc+Jz6nPmc+5z4XPpc+Vz7XPjc+tz53Pv8+Dz6PPk8+zz4vPq8+bz",
  "7vPh8+nz5fPt8+Pz6/Pn/88KiAYIAbGAeEAiQAyQApIBcoASoAZoAamAdIAeYARkArIBZkAuIB9QCCgGlALKAZWAakAtoB7Q",
  "CLACmgF2QCvACXAD2gGdgG5AL8AL8AOCgH7AIGAYMAoIA8YBk4BpwCxgHrAIWAlYDVgLWA/YCNgM2ArYDlgGELATsBuwF7Af",
  "cBBwGHAUcBxwEnAacBZwHnARcBlwFXAdcBNwG3AXcB/wEPAY8BTwHPAS8BrwFvAe8BHwGfAV8B3wE/Ab8Bf8z+oT7SP0ifWJ",
  "90n0EftIfZJ95D5KH7WP1ifVJ91H72P0yfTJ9jH75Prk+xT6FPuU+pT7VPpU+9T61Ps0+lh9mn3sPq0+Th+3T7tPp0+3T6+P",
  "18fvE/Tp9xn0GfYZ9Qn7jPtM+kz7zPrM+yz6rPRZ7bPWZ73PRp/NPlt9tvss+9Bnp89un70++30O+hz2Oepz3Oekz2mfsz7n",
  "fS76XPa56nPd56bPbZ+7Pvd9Hvo89nnq89znpc9rn7c+730++nz2+erz3eenz2+fv/7/rAHRAcKA2ID4gMQAcYA0IDlAHqAM",
  "UAdoA1ID0gP0AcaAzIDsAHNAbkB+QGFAcUBpQHlAZUB1QG1AfUBjgDWgOcAe0BrgDHAHtAd0BnQH9AZ4A/wBwYD+gMGA4YDR",
  "gHDAeMBkwHTAbMB8wGLAyoDVAWsD1gdsDNgcsDVge8ByAAN2BuwO2BuwP+BgwOGAowHHA04GnA44G3A+4GLA5YCrAdcDbgbc",
  "DrgbcD/gYcDjgKcBzwNeBrwOeBvwPuBjwOeArwHfA34G/A74G/zPGhIdIgyJDYkPSQwRh0hDkkPkIcoQdYg2JDUkPUQfYgzJ",
  "DMkOMYfkhuSHFIYUh5SGlIdUhlSH1IbUhzSGWEOaQ+whrSHOEHdIe0hnSHdIb4g3xB8SDOkPGQwZDhkNCYeMh0yGTIfMhsyH",
  "LIasDFkdsjZkfcjGkM0hW0O2hyyHMGRnyO6QvSH7Qw6GHA45GnI85GTI6ZCzIedDLoZcDrkacj3kZsjtkLsh90MehjwOeRry",
  "PORlyOuQtyHvQz6GfA75GvI95GfI75C/4f+sEdERwojYiPiIxAhxhDQiOUIeoYxQR2gjUiPSI/QRxojMiOwIc0RuRH5EYURx",
  "RGlEeURlRHVEbUR9RGOENaI5wh7RGuGMcEe0R3RGdEf0Rngj/BHBiP6IwYjhiNGIcMR4xGTEdMRsxHzEYsTKiNURayPWR2yM",
  "2ByxNWJ7xHIEI3ZG7I7YG7E/4mDE4YijEccjTkacjjgbcT7iYsTliKsR1yNuRtyOuBtxP+JhxOOIpxHPI15GvI54G/E+4mPE",
  "54ivEd8jfkb8jvgb/c8KiYYIIbGQeEgiRAyRQpIhcogSooZoIamQdIgeYoRkQrIhZkguJB9SCCmGlELKIZWQakgtpB7SCLFC",
  "miF2SCvECXFD2iGdkG5IL8QL8UOCkH7IIGQYMgoJQ8Yhk5BpyCxkHrIIWQlZDVkLWQ/ZCNkM2QrZDlmGELITshuyF7IfchBy",
  "GHIUchxyEnIachZyHnIRchlyFXIdchNyG3IXch/yEPIY8hTyHPIS8hryFvIe8hHyGfIV8h3yE/Ib8hf+zxoTHSOMiY2Jj0mM",
  "EcdIY5Jj5DHKGHWMNiY1Jj1GH2OMyYzJjjHH5MbkxxTGFMeUxpTHVMZUx9TG1Mc0xlhjmmPsMa0xzhh3THtMZ0x3TG+MN8Yf",
  "E4zpjxmMGY4ZjQnHjMdMxkzHzMbMxyzGrIxZHbM2Zn3MxpjNMVtjtscsxzBmZ8zumL0x+2MOxhyOORpzPOZkzOmYszHnYy7G",
  "XI65GnM95mbM7Zi7MfdjHsY8jnka8zzmZczrmLcx72M+xnyO+RrzPeZnzO+Yv/H/rAnRCcKE2IT4hMQEcYI0ITlBnqBMUCdo",
  "E1IT0hP0CcaEzITsBHNCbkJ+QmFCcUJpQnlCZUJ1Qm1CfUJjgjWhOcGe0JrgTHAntCd0JnQn9CZ4E/wJwYT+hMGE4YTRhHDC",
  "eMJkwnTCbMJ8wmLCyoTVCWsT1idsTNicsDVhe8JyAhN2JuxO2JuwP+FgwuGEownHE04mnE44m3A+4WLC5YSrCdcTbibcTrib",
  "cD/hYcLjhKcJzxNeJrxOeJvwPuFjwueErwnfE34m/E74m/zPmhKdIkyJTYlPSUwRp0hTklPkKcoUdYo2JTUlPUWfYkzJTMlO",
  "MafkpuSnFKYUp5SmlKdUplSn1KbUpzSmWFOaU+wprSnOFHdKe0pnSndKb4o3xZ8STOlPGUwZThlNCaeMp0ymTKfMpsynLKas",
  "TFmdsjZlfcrGlM0pW1O2pyynMGVnyu6UvSn7Uw6mHE45mnI85WTK6ZSzKedTLqZcTrmacj3lZsrtlLsp91MepjxOeZryPOVl",
  "yuuUtynvUz6mfE75mvI95WfK75S/6f+sGdEZwozYjPiMxAxxhjQjOUOeocxQZ2gzUjPSM/QZxozMjOwMc0ZuRn5GYUZxRmlG",
  "eUZlRnVGbUZ9RmOGNaM5w57RmuHMcGe0Z3RmdGf0Zngz/BnBjP6MwYzhjNGMcMZ4xmTGdMZsxnzGYsbKjNUZazPWZ2zM2Jyx",
  "NWN7xnIGM3Zm7M7Ym7E/42DG4YyjGcczTmaczjibcT7jYsbljKsZ1zNuZtzOuJtxP+NhxuOMpxnPM15mvM54m/E+42PG54yv",
  "Gd8zfmb8zvib/c+aE50jzInNic9JzBHnSHOSc+Q5yhx1jjYnNSc9R59jzMnMyc4x5+Tm5OcU5hTnlOaU51TmVOfU5tTnNOZY",
  "c5pz7DmtOc4cd057TmdOd05vjjfHnxPM6c8ZzBnOGc0J54znTOZM58zmzOcs5qzMWZ2zNmd9zsaczTlbc7bnLOcwZ2fO7py9",
  "OftzDuYczjmaczznZM7pnLM553Mu5lzOuZpzPedmzu2cuzn3cx7mPM55mvM852XO65y3Oe9zPuZ8zvma8z3nZ87vnL/5/6wF",
  "0QXCgtiC+ILEAnGBtCC5QF6gLFAXaAtSC9IL9AXGgsyC7AJzQW5BfkFhQXFBaUF5QWVBdUFtQX1BY4G1oLnAXtBa4CxwF7QX",
  "dBZ0F/QWeAv8BcGC/oLBguGC0YJwwXjBZMF0wWzBfMFiwcqC1QVrC9YXbCzYXLC1YHvBcgELdhbsLthbsL/gYMHhgqMFxwtO",
  "FpwuOFtwvuBiwb8K7sAjfjCO4zg/SZIkSZIkSZIkSZIkSZIkSZIkSZJzzjnnnPN2zjnnnDNnzpmZmZmZmZmZmZmZ/V2/2p/w",
  "sj37Pt/v53mkH+QflB/UH7Qf9B+MH8wfrB/sH5wf3B+8H/wfgh/CH6If4h+SH9Ifsh/yn1+sAv8KTBSYLDBVYLrATIHZAnMF",
  "5gssFFgssFRgucBKgdUCawXWC2wU2CywVWC7wE6B3QJ7BfYLHBQ4LHBU4LjASYHTAmcFzgtcFLgscFXgusBNgdsCdwXuCzwU",
  "eCzwVOC5wEuB1wJvBd4LfBT4LPBV4LvAT4FCgWKBUoFygUqBaoFagXqBRgEKNAu0CrQLdAp0C/QK9AsMCggFhgXEAqMC4wJS",
  "AbmAUkAtoBXQCxgFzAJWAbuAU8At4BXwCwQFwgJRgbhAUiAtkBXIC79YRf4VmSgyWWSqyHSRmSKzReaKzBdZKLJYZKnIcpGV",
  "IqtF1oqsF9kosllkq8h2kZ0iu0X2iuwXOShyWOSoyHGRkyKnRc6KnBe5KHJZ5KrIdZGbIrdF7orcF3ko8ljkqchzkZcir0Xe",
  "irwX+SjyWeSryHeRnyKFIsUipSLlIpUi1SK1IvUijSIUaRZpFWkX6RTpFukV6RcZFBGKDIuIRUZFxkWkInIRpYhaRCuiFzGK",
  "mEWsInYRp4hbxCviFwmKhEWiInGRpEhaJCuSF3+xSvwrMVFissRUiekSMyVmS8yVmC+xUGKxxFKJ5RIrJVZLrJVYL7FRYrPE",
  "VontEjsldkvsldgvcVDisMRRieMSJyVOS5yVOC9xUeKyxFWJ6xI3JW5L3JW4L/FQ4rHEU4nnEi8lXku8lXgv8VHis8RXie8S",
  "PyUKJYolSiXKJSolqiVqJeolGiUo0SzRKtEu0SnRLdEr0S8xKCGUGJYQS4xKjEtIJeQSSgm1hFZCL2GUMEtYJewSTgm3hFfC",
  "LxGUCEtEJeISSYm0RFYiL/1ilflXZqLMZJmpMtNlZsrMlpkrM19mocximaUyy2VWyqyWWSuzXmajzGaZrTLbZXbK7JbZK7Nf",
  "5qDMYZmjMsdlTsqcljkrc17mosxlmasy12VuytyWuStzX+ahzGOZpzLPZV7KvJZ5K/Ne5qPMZ5mvMt9lfsoUyhTLlMqUy1TK",
  "VMvUytTLNMpQplmmVaZdplOmW6ZXpl9mUEYoMywjlhmVGZeRyshllDJqGa2MXsYoY5axythlnDJuGa+MXyYoE5aJysRlkjJp",
  "maxMXv7FqvCvwkSFyQpTFaYrzFSYrTBXYb7CQoXFCksVliusVFitsFZhvcJGhc0KWxW2K+xU2K2wV2G/wkGFwwpHFY4rnFQ4",
  "rXBW4bzCRYXLClcVrivcVLitcFfhvsJDhccKTxWeK7xUeK3wVuG9wkeFzwpfFb4r/FQoVChWKFUoV6hUqFaoVahXaFSgQrNC",
  "q0K7QqdCt0KvQr/CoIJQYVhBrDCqMK4gVZArKBXUCloFvYJRwaxgVbArOBXcCl4Fv0JQIawQVYgrJBXSClmFvPKLVeVflYkq",
  "k1WmqkxXmakyW2WuynyVhSqLVZaqLFdZqbJaZa3KepWNKptVtqpsV9mpsltlr8p+lYMqh1WOqhxXOalyWuWsynmViyqXVa6q",
  "XFe5qXJb5a7KfZWHKo9Vnqo8V3mp8lrlrcp7lY8qn1W+qnxX+alSqFKsUqpSrlKpUq1Sq1Kv0qhClWaVVpV2lU6VbpVelX6V",
  "QRWhyrCKWGVUZVxFqiJXUaqoVbQqehWjilnFqmJXcaq4VbwqfpWgSlglqhJXSaqkVbIqefUXq8a/GhM1JmtM1ZiuMVNjtsZc",
  "jfkaCzUWayzVWK6xUmO1xlqN9RobNTZrbNXYrrFTY7fGXo39Ggc1Dmsc1TiucVLjtMZZjfMaFzUua1zVuK5xU+O2xl2N+xoP",
  "NR5rPNV4rvFS47XGW433Gh81Pmt81fiu8VOjUKNYo1SjXKNSo1qjVqNeo1GDGs0arRrtGp0a3Rq9Gv0agxpCjWENscaoxriG",
  "VEOuodRQa2g19BpGDbOGVcOu4dRwa3g1/BpBjbBGVCOukdRIa2Q18tovVp1/dSbqTNaZqjNdZ6bObJ25OvN1Fuos1lmqs1xn",
  "pc5qnbU663U26mzW2aqzXWenzm6dvTr7dQ7qHNY5qnNc56TOaZ2zOud1Lupc1rmqc13nps5tnbs693Ue6jzWearzXOelzmud",
  "tzrvdT7qfNb5qvNd56dOoU6xTqlOuU6lTrVOrU69TqMOdZp1WnXadTp1unV6dfp1BnWEOsM6Yp1RnXEdqY5cR6mj1tHq6HWM",
  "OmYdq45dx6nj1vHq+HWCOmGdqE5cJ6mT1snq5PVfrAb/Gkw0mGww1WC6wUyD2QZzDeYbLDRYbLDUYLnBSoPVBmsN1htsNNhs",
  "sNVgu8FOg90Gew32Gxw0OGxw1OC4wUmD0wZnDc4bXDS4bHDV4LrBTYPbBncN7hs8NHhs8NTgucFLg9cGbw3eG3w0+Gzw1eC7",
  "wU+DQoNig1KDcoNKg2qDWoN6g0YDGjQbtBq0G3QadBv0GvQbDBoIDYYNxAajBuMGUgO5gdJAbaA10BsYDcwGVgO7gdPAbeA1",
  "8BsEDcIGUYO4QdIgbZA1yBu/WH+XKjHxdwEOU3+XlTDzd7EEc3+XALDwd2Cbpb/Dtaz8HYRk7e/QGht/B4zY+jsMws5fcJ+9",
  "v5A1B3+BWI7+wouc/AXNOPsLBXHxF+Dg6m/Yzs3fYJS7vyEWD38DB57+msO8/DXyePtruvDxt0H+3fb9bmZ+S/TfwvO3nPot",
  "En5/fb8L+u8y9fvx/b5Sv1B/TxNa0IYOdKEHfRiAAEMQYQRjkEAGBVTQQAcDTLDABgdc8MCHAEKIIIYEUsgg5xeryb8mE00m",
  "m0w1mW4y02S2yVyT+SYLTRabLDVZbrLSZLXJWpP1JhtNNptsNdlustNkt8lek/0mB00Omxw1OW5y0uS0yVmT8yYXTS6bXDW5",
  "bnLT5LbJXZP7Jg9NHps8NXlu8tLktclbk/cmH00+m3w1+W7y06TQpNik1KTcpNKk2qTWpN6k0fyjajZpNWk36TTpNuk16TcZ",
  "NBGaDJuITUZNxk2kJnITpYnaRGuiNzGamE2sJnYTp4nbxGviNwmahE2iJnGTpEnaJGuSN3+xWvxrMdFissVUi+kWMy1mW8y1",
  "mG+x0GKxxVKL5RYrLVZbrLVYb7HRYrPFVovtFjstdlvstdhvcdDisMVRi+MWJy1OW5y1OG9x0eKyxVWL6xY3LW5b3LW4b/HQ",
  "4rHFU4vnFi8tXlu8tXhv8dHis8VXi+8WPy0KLYotSi3KLSotqi1qLeotGq2/l6rZotWi3aLTotui16LfYtBCaDFsIbYYtRi3",
  "kFrILZQWaguthd7CaGG2sFrYLZwWbguvhd8iaBG2iFrELZIWaYusRd76xWrzr81Em8k2U22m28y0mW0z12a+zUKbxTZLbZbb",
  "rLRZbbPWZr3NRpvNNlttttvstNlts9dmv81Bm8M2R22O25y0OW1z1ua8zUWbyzZXba7b3LS5bXPX5r7NQ5vHNk9tntu8tHlt",
  "89bmvc1Hm882X22+2/y0KbQptim1KbeptKm2qbWpt2m0/z6/ZptWm3abTptum16bfptBG6HNsI3YZtRm3EZqI7dR2qhttDZ6",
  "G6ON2cZqY7dx2rhtvDZ+m6BN2CZqE7dJ2qRtsjZ5+xerw78OEx0mO0x1mO4w02G2w1yH+Q4LHRY7LHVY7rDSYbXDWof1Dhsd",
  "NjtsddjusNNht8Neh/0OBx0OOxx1OO5w0uG0w1mH8w4XHS47XHW47nDT4bbDXYf7Dg8dHjs8dXju8NLhtcNbh/cOHx0+O3x1",
  "+O7w06HQodih1KHcodKh2qHWod6h0flbqJodWh3aHToduh16HfodBh2EDsMOYodRh3EHqYPcQemgdtA66B2MDmYHq4Pdweng",
  "dvA6+B2CDmGHqEPcIemQdsg65J1frC7/ukx0mewy1WW6y0yX2S5zXea7LHRZ7LLUZbnLSpfVLmtd1rtsdNnsstVlu8tOl90u",
  "e132uxx0Oexy1OW4y0mX0y5nXc67XHS57HLV5brLTZfbLndd7rs8dHns8tTluctLl9cub13eu3x0+ezy1eW7y0+XQpdil1KX",
  "cpdKl2qXWpd6l0b3b0lvdml1aXfpdOl26XXpdxl0EboMu4hdRl3GXaQucheli9pF66J3MbqYXawudheni9vF6+J3CbqEXaIu",
  "cZekS9ol65J3f7F6/Osx0WOyx1SP6R4zPWZ7zPWY77HQY7HHUo/lHis9Vnus9VjvsdFjs8dWj+0eOz12e+z12O9x0OOwx1GP",
  "4x4nPU57nPU473HR47LHVY/rHjc9bnvc9bjv8dDjscdTj+ceLz1ee7z1eO/x0eOzx1eP7x4/PQo9ij1KPco9Kj2qPWo96j0a",
  "vb+fX7NHq0e7R6dHt0evR7/HoIfQY9hD7DHqMe4h9ZB7KD3UHloPvYfRw+xh9bB7OD3cHl4Pv0fQI+wR9Yh7JD3SHlmPvPeL",
  "1edfn4k+k32m+kz3mekz22euz3yfhT6LfZb6LPdZ6bPaZ63Pep+NPpt9tvps99nps9tnr89+n4M+h32O+hz3Oelz2uesz3mf",
  "iz6Xfa76XPe56XPb567PfZ+HPo99nvo893np89rnrc97n48+n32++nz3+elT6FPsU+pT7lPpU+1T61Pv0+j/lQnNPq0+7T6d",
  "Pt0+vT79PoM+Qp9hH7HPqM+4j9RH7qP0UftoffQ+Rh+zj9XH7uP0cft4ffw+QZ+wT9Qn7pP0SftkffL+L9aAfwMmBkwOmBow",
  "PWBmwOyAuQHzAxYGLA5YGrA8YGXA6oC1AesDNgZsDtgasD1gZ8DugL0B+wMOBhwOOBpwPOBkwOmAswHnAy4GXA64GnA94GbA",
  "7YC7AfcDHgY8Dnga8DzgZcDrgLcB7wM+BnwO+BrwPeBnQGFAcUBpQHlAZUB1QG1AfUBj8FdQNQe0BrQHdAZ0B/QG9AcMBggD",
  "hgPEAaMB4wHSAHmAMkAdoA3QBxgDzAHWAHuAM8Ad4A3wBwQDwgHRgHhAMiAdkA3IB79YAv8EJgQmBaYEpgVmBGYF5gTmBRYE",
  "FgWWBJYFVgRWBdYE1gU2BDYFtgS2BXYEdgX2BPYFDgQOBY4EjgVOBE4FzgTOBS4ELgWuBK4FbgRuBe4E7gUeBB4FngSeBV4E",
  "XgXeBN4FPgQ+Bb4EvgV+BAoCRYGSQFmgIlAVqAnUBRrCX+nZFGgJtAU6Al2BnkBfYCAgCAwFRIGRwFhAEpAFFAFVQBPQBQwB",
  "U8ASsAUcAVfAE/AFAoFQIBKIBRKBVCATyIVfrCH/hkwMmRwyNWR6yMyQ2SFzQ+aHLAxZHLI0ZHnIypDVIWtD1odsDNkcsjVk",
  "e8jOkN0he0P2hxwMORxyNOR4yMmQ0yFnQ86HXAy5HHI15HrIzZDbIXdD7oc8DHkc8jTkecjLkNchb0Peh3wM+RzyNeR7yM+Q",
  "wpDikNKQ8pDKkOqQ2pD6kMbwr0hvDmkNaQ/pDOkO6Q3pDxkMEYYMh4hDRkPGQ6Qh8hBliDpEG6IPMYaYQ6wh9hBniDvEG+IP",
  "CYaEQ6Ih8ZBkSDokG5IPf7FE/olMiEyKTIlMi8yIzIrMicyLLIgsiiyJLIusiKyKrImsi2yIbIpsiWyL7IjsiuyJ7IsciByK",
  "HIkci5yInIqciZyLXIhcilyJXIvciNyK3IncizyIPIo8iTyLvIi8iryJvIt8iHyKfIl8i/yIFESKIiWRskhFpCpSE6mLNMS/",
  "7UxTpCXSFumIdEV6In2RgYggMhQRRUYiYxFJRBZRRFQRTUQXMURMEUvEFnFEXBFPxBcJREKRSCQWSURSkUwkF3+xRvwbMTFi",
  "csTUiOkRMyNmR8yNmB+xMGJxxNKI5RErI1ZHrI1YH7ExYnPE1ojtETsjdkfsjdgfcTDicMTRiOMRJyNOR5yNOB9xMeJyxNWI",
  "6xE3I25H3I24H/Ew4nHE04jnES8jXke8jXgf8THic8TXiO8RPyMKI4ojSiPKIyojqiNqI+ojGqO/jV9zRGtEe0RnRHdEb0R/",
  "xGCEMGI4QhwxGjEeIY2QRygj1BHaCH2EMcIcYY2wRzgj3BHeCH9EMCIcEY2IRyQj0hHZiHz0izXm35iJMZNjpsZMj5kZMztm",
  "bsz8mIUxi2OWxiyPWRmzOmZtzPqYjTGbY7bGbI/ZGbM7Zm/M/piDMYdjjsYcjzkZczrmbMz5mIsxl2OuxlyPuRlzO+ZuzP2Y",
  "hzGPY57GPI95GfM65m3M+5iPMZ9jvsZ8j/kZUxhTHFMaUx5TGVMdUxtTH9MY/22Rm2NaY9pjOmO6Y3pj+mMGY4QxwzHimNGY",
  "8RhpjDxGGaOO0cboY4wx5hhrjD3GGeOO8cb4Y4Ix4ZhoTDwmGZOOycbk418siX8SExKTElMS0xIzErMScxLzEgsSixJLEssS",
  "KxKrEmsS6xIbEpsSWxLbEjsSuxJ7EvsSBxKHEkcSxxInEqcSZxLnEhcSlxJXEtcSNxK3EncS9xIPEo8STxLPEi8SrxJvEu8S",
  "HxKfEl8S3xI/EgWJokRJoixRkahK1CTqEg3pr5nQlGhJtCU6El2JnkRfYiAhSAwlRImRxFhCkpAlFAlVQpPQJQwJU8KSsCUc",
  "CVfCk/AlAolQIpKIJRKJVCKTyKVfLJl/MhMykzJTMtMyMzKzMnMy8zILMosySzLLMisyqzJrMusyGzKbMlsy2zI7MrsyezL7",
  "MgcyhzJHMscyJzKnMmcy5zIXMpcyVzLXMjcytzJ3MvcyDzKPMk8yzzIvMq8ybzLvMh8ynzJfMt8yPzIFmaJMSaYsU5GpytRk",
  "6jIN+a/t0pRpybRlOjJdmZ5MX2YgI8gMZUSZkcxYRpKRZRQZVUaT0WUMGVPGkrFlHBlXxpPxZQKZUCaSiWUSmVQmk8nlXyyF",
  "fwoTCpMKUwrTCjMKswpzCvMKCwqLCksKyworCqsKawrrChsKmwpbCtsKOwq7CnsK+woHCocKRwrHCicKpwpnCucKFwqXClcK",
  "1wo3CrcKdwr3Cg8KjwpPCs8KLwqvCm8K7wofCp8KXwrfCj8KBYWiQkmhrFBRqCrUFOoKDeWvQdVUaCm0FToKXYWeQl9hoCAo",
  "DBVEhZHCWEFSkBUUBVVBU9AVDAVTwVKwFRwFV8FT8BUChVAhUogVEoVUIVPIlV8slX8qEyqTKlMq0yozKrMqcyrzKgsqiypL",
  "KssqKyqrKmsq6yobKpsqWyrbKjsquyp7KvsqByqHKkcqxyonKqcqZyrnKhcqlypXKtcqNyq3Kncq9yoPKo8qTyrPKi8qrypv",
  "Ku8qHyqfKl8q3yo/KgWVokpJpaxSUamq1FTqKg31r5XXVGmptFU6Kl2VnkpfZaAiqAxVRJWRylhFUpFVFBVVRVPRVQwVU8VS",
  "sVUcFVfFU/FVApVQJVKJVRKVVCVTydVfLI1/GhMakxpTGtMaMxqzGnMa8xoLGosaSxrLGisaqxprGusaGxqbGlsa2xo7Grsa",
  "exr7GgcahxpHGscaJxqnGmca5xoXGpcaVxrXGjcatxp3GvcaDxqPGk8azxovGq8abxrvGh8anxpfGt8aPxoFjaJGSaOsUdGo",
  "atQ06hoN7a/p2dRoabQ1OhpdjZ5GX2OgIWgMNUSNkcZYQ9KQNRQNVUPT0DUMDVPD0rA1HA1Xw9PwNQKNUCPSiDUSjVQj08i1",
  "XyydfzoTOpM6UzrTOjM6szpzOvM6CzqLOks6yzorOqs6azrrOhs6mzpbOts6Ozq7Ons6+zoHOoc6RzrHOic6pzpnOuc6FzqX",
  "Olc61zo3Orc6dzr3Og86jzpPOs86LzqvOm867zofOp86XzrfOj86BZ2iTkmnrFPRqerUdOo6Df2vPdzUaem0dTo6XZ2eTl9n",
  "oCPoDHVEnZHOWEfSkXUUHVVH09F1DB1Tx9KxdRwdV8fT8XUCnVAn0ol1Ep1UJ9PJ9V8sg38GEwaTBlMG0wYzBrMGcwbzBgsG",
  "iwZLBssGKwarBmsG6wYbBpsGWwbbBjsGuwZ7BvsGBwaHBkcGxwYnBqcGZwbnBhcGlwZXBtcGNwa3BncG9wYPBo8GTwbPBi8G",
  "rwZvBu8GHwafBl8G3wY/BgWDokHJoGxQMaga1AzqBg3jr5HeNGgZtA06Bl2DnkHfYGAgGAwNRIORwdhAMpANFAPVQDPQDQwD",
  "08AysA0cA9fAM/ANAoPQIDKIDRKD1CAzyI1fLJN/JhMmkyZTJtMmMyazJnMm8yYLJosmSybLJismqyZrJusmGyabJlsm2yY7",
  "Jrsmeyb7JgcmhyZHJscmJyanJmcm5yYXJpcmVybXJjcmtyZ3JvcmDyaPJk8mzyYvJq8mbybvJh8mnyZfJt8mPyYFk6JJyaRs",
  "UjGpmtRM6iYN82/k0DRpmbRNOiZdk55J32RgIpgMTUSTkcnYRDKRTRQT1UQz0U0ME9PEMrFNHBPXxDPxTQKT0CQyiU0Sk9Qk",
  "M8nNXyyLfxYTFpMWUxbTFjMWsxZzFvMWCxaLFksWyxYrFqsWaxbrFhsWmxZbFtsWOxa7FnsW+xYHFocWRxbHFicWpxZnFucW",
  "FxaXFlcW1xY3FrcWdxb3Fg8WjxZPFs8WLxavFm8W7xYfFp8WXxbfFj8WBYuiRcmibFGxqFrULOoWDetvONO0aFm0LToWXYue",
  "Rd9iYCFYDC1Ei5HF2EKykC0UC9VCs9AtDAvTwrKwLRwL18Kz8C0Ci9AisogtEovUIrPIrV8sm382EzaTNlM20zYzNrM2czbz",
  "Ngs2izZLNss2KzarNms26zYbNps2WzbbNjs2uzZ7Nvs2BzaHNkc2xzYnNqc2ZzbnNhc2lzZXNtc2Nza3Nnc29zYPNo82TzbP",
  "Ni82rzZvNu82HzafNl823zY/NgWbok3JpmxTsana1GzqNg37b4zVtGnZtG06Nl2bnk3fZmAj2AxtRJuRzdhGspFtFBvVRrPR",
  "bQwb08aysW0cG9fGs/FtApvQJrKJbRKb1Cazye1fLId/DhMOkw5TDtMOMw6zDnMO8w4LDosOSw7LDisOqw5rDusOGw6bDlsO",
  "2w47DrsOew77DgcOhw5HDscOJw6nDmcO5w4XDpcOVw7XDjcOtw53DvcODw6PDk8Ozw4vDq8Obw7vDh8Onw5fDt8OPw4Fh6JD",
  "yaHsUHGoOtQc6g4N52/g13RoObQdOg5dh55D32HgIDgMHUSHkcPYQXKQHRQH1UFz0B0MB9PBcrAdHAfXwXPwHQKH0CFyiB0S",
  "h9Qhc8idXyyXfy4TLpMuUy7TLjMusy5zLvMuCy6LLksuyy4rLqsuay7rLhsumy5bLtsuOy67Lnsu+y4HLocuRy7HLicupy5n",
  "LucuFy6XLlcu1y43Lrcudy73Lg8ujy5PLs8uLy6vLm8u7y4fLp8uXy7fLj8uBZeiS8ml7FJxqbrUXOouDfdvNNp0abm0XTou",
  "XZeeS99l4CK4DF1El5HL2EVykV0UF9VFc9FdDBfTxXKxXRwX18Vz8V0Cl9AlcoldEpfUJXPJ3V8sj38eEx6THlMe0x4zHrMe",
  "cx7zHgseix5LHsseKx6rHmse6x4bHpseWx7bHjseux57HvseBx6HHkcexx4nHqceZx7nHhcelx5XHtceNx63Hnce9x4PHo8e",
  "Tx7PHi8erx5vHu8eHx6fHl8e3x4/HgWPokfJo+xR8ah61DzqHg3vb4jc9Gh5tD06Hl2PnkffY+AheAw9RI+Rx9hD8pA9FA/V",
  "Q/PQPQwP08PysD0cD9fD8/A9Ao/QI/KIPRKP1CPzyL1fLJ9/PhM+kz5TPtM+Mz6zPnM+8z4LPos+Sz7LPis+qz5rPus+Gz6b",
  "Pls+2z47Prs+ez77Pgc+hz5HPsc+Jz6nPmc+5z4XPpc+Vz7XPjc+tz53Pvc+Dz6PPk8+zz4vPq8+bz7vPh8+nz5fPt8+Pz4F",
  "n6JPyafsU/Gp+tR86j4N/2/c3vRp+bR9Oj5dn55P32fgI/gMfUSfkc/YR/KRfRQf1Ufz0X0MH9PH8rF9HB/Xx/PxfQKf0Cfy",
  "iX0Sn9Qn88n9X6yAfwETAZMBUwHTATMBswFzAfMBCwGLAUsBywErAasBawHrARsBmwFbAdsBOwG7AXsB+wEHAYcBRwHHAScB",
  "pwFnAecBFwGXAVcB1wE3AbcBdwH3AQ8BjwFPAc8BLwGvAW8B7wEfAZ8BXwHfAT8BhYBiQCmgHFAJqAbUAuoBjeAvmNAMaAW0",
  "AzoB3YBeQD9gECAEDAPEgFHAOEAKkAOUADVAC9ADjAAzwAqwA5wAN8AL8AOCgDAgCogDkoA0IAvIg1+skH8hEyGTIVMh0yEz",
  "IbMhcyHzIQshiyFLIcshKyGrIWsh6yEbIZshWyHbITshuyF7IfshByGHIUchxyEnIachZyHnIRchlyFXIdchNyG3IXch9yEP",
  "IY8hTyHPIS8hryFvIe8hHyGfIV8h3yE/IYWQYkgppBxSCamG1ELqIY3wL8LRDGmFtEM6Id2QXkg/ZBAihAxDxJBRyDhECpFD",
  "lBA1RAvRQ4wQM8QKsUOcEDfEC/FDgpAwJAqJQ5KQNCQLycNfrIh/ERMRkxFTEdMRMxGzEXMR8xELEYsRSxHLESsRqxFrEesR",
  "GxGbEVsR2xE7EbsRexH7EQcRhxFHEccRJxGnEWcR5xEXEZcRVxHXETcRtxF3EfcRDxGPEU8RzxEvEa8RbxHvER8RnxFfEd8R",
  "PxGFiGJEKaIcUYmoRtQi6hGN6C/s0oxoRbQjOhHdiF5EP2IQIUQMI8SIUcQ4QoqQI5QINUKL0COMCDPCirAjnAg3wovwI4KI",
  "MCKKiCOSiDQii8ijX6yYfzETMZMxUzHTMTMxszFzMfMxCzGLMUsxyzErMasxazHrMRsxmzFbMdsxOzG7MXsx+zEHMYcxRzHH",
  "MScxpzFnMecxFzGXMVcx1zE3MbcxdzH3MQ8xjzFPMc8xLzGvMW8x7zEfMZ8xXzHfMT8xhZhiTCmmHFOJqcbUYuoxjfgvFtSM",
  "acW0Yzox3ZheTD9mECPEDGPEmFHMOEaKkWOUGDVGi9FjjBgzxoqxY5wYN8aL8WOCmDAmioljkpg0JovJ41+shH8JEwmTCVMJ",
  "0wkzCbMJcwnzCQsJiwlLCcsJKwmrCWsJ6wkbCZsJWwnbCTsJuwl7CfsJBwmHCUcJxwknCacJZwnnCRcJlwlXCdcJNwm3CXcJ",
  "9wkPCY8JTwnPCS8JrwlvCe8JHwmfCV8J3wk/CYWEYkIpoZxQSagm1BLqCY3kL0DVTGgltBM6Cd2EXkI/YZAgJAwTxIRRwjhB",
  "SpATlAQ1QUvQE4wEM8FKsBOcBDfBS/ATgoQwIUqIE5KENCFLyJNfrJR/KRMpkylTKdMpMymzKXMp8ykLKYspSynLKSspqylr",
  "KespGymbKVsp2yk7Kbspeyn7KQcphylHKccpJymnKWcp5ykXKZcpVynXKTcptyl3KfcpDymPKU8pzykvKa8pbynvKR8pnylf",
  "Kd8pPymFlGJKKaWcUkmpptRS6imN9C9q1kxppbRTOindlF5KP2WQIqQMU8SUUco4RUqRU5QUNUVL0VOMFDPFSrFTnBQ3xUvx",
  "U4KUMCVKiVOSlDQlS8nTX6yMfxkTGZMZUxnTGTMZsxlzGfMZCxmLGUsZyxkrGasZaxnrGRsZmxlbGdsZOxm7GXsZ+xkHGYcZ",
  "RxnHGScZpxlnGecZFxmXGVcZ1xk3GbcZdxn3GQ8ZjxlPGc8ZLxmvGW8Z7xkfGZ8ZXxnfGT8ZhYxiRimjnFHJqGbUMuoZjewv",
  "lNfMaGW0MzoZ3YxeRj9jkCFkDDPEjFHGOEPKkDOUDDVDy9AzjAwzw8qwM5wMN8PL8DOCjDAjyogzkow0I8vIs1+snH85EzmT",
  "OVM50zkzObM5cznzOQs5izlLOcs5KzmrOWs56zkbOZs5WznbOTs5uzl7Ofs5BzmHOUc5xzknOac5ZznnORc5lzlXOdc5Nzm3",
  "OXc59zkPOY85TznPOS85rzlvOe85HzmfOV853zk/OYWcYk4pp5xTyanm1HLqOY38L77YzGnltHM6Od2cXk4/Z5Aj5AxzxJxR",
  "zjhHypFzlBw1R8vRc4wcM8fKsXOcHDfHy/FzgpwwJ8qJc5KcNCfLyXP+AzoEwUAdAFWOAAAAAElFTkSuQmCC",
].join("");
("ZmbOOTMzZ2ZmJkmSZF5JkiRJkiRJkiRJkiRJv+v7np/wRCIRohGECLEI8QiJCGIEKUIyghxBiaBG0CKkIqQj6BGMCJkI2Qhm");
("hFyEfIRChGKEUoRyhEqEaoRahHqERgQrQjOCHaEVwYngRmhH6EToRuhF8CL4EYII/QiDCMMIowhhhHGESYRphFmEeYRFhJUI");
("qxHWIqxH2IiwGWErwnaEZQQi7ETYjbAXYT/CQYTDCEcRjiOcRDiNcBbhPMJFhMsIVxGuI9xEuI1wF+E+wkOExwhPEZ4jvER4");
("jfAW4T3CR4TPCF8RviP8RPiN8BchEokSjSJEiUWJR0lEEaNIUZJR5ChKFDWKFiUVJR1Fj2JEyUTJRjGj5KLkoxSiFKOUopSj");
("VKJUo9Si1KM0olhRmlHsKK0oThQ3SjtKJ0o3Si+KF8WPEkTpRxlEGUYZRQmjjKNMokyjzKLMoyyirERZjbIWZT3KRpTNKFtR");
("tqMsoxBlJ8pulL0o+1EOohxGOYpyHOUkymmUsyjnUS6iXEa5inId5SbKbZS7KPdRHqI8RnmK8hzlJcprlLco71E+onxG+Yry");
("HeUnym+Uv+j/LIGogCAQE4gLJAREAUkgKSALKAKqgCaQEkgL6AKGQEYgK2AK5ATyAgWBokBJoCxQEagK1ATqAg0BS6ApYAu0");
("BBwBV6At0BHoCvQEPAFfIBDoCwwEhgIjgVBgLDARmArMBOYCC4EVgVWBNYF1gQ2BTYEtgW2BpQACOwK7AnsC+wIHAocCRwLH");
("AicCpwJnAucCFwKXAlcC1wI3ArcCdwL3Ag8CjwJPAs8CLwKvAm8C7wIfAp8CXwLfAj8CvwJ/wv+sGNEYQoxYjHiMRAwxhhQj");
("GUOOocRQY2gxUjHSMfQYRoxMjGwMM0YuRj5GIUYxRilGOUYlRjVGLUY9RiOGFaMZw47RiuHEcGO0Y3RidGP0Yngx/BhBjH6M");
("QYxhjFGMMMY4xiTGNMYsxjzGIsZKjNUYazHWY2zE2IyxFWM7xjIGMXZi7MbYi7Ef4yDGYYyjGMcxTmKcxjiLcR7jIsZljKsY");
("1zFuYtzGuItxH+MhxmOMpxjPMV5ivMZ4i/Ee4yPGZ4yvGN8xfmL8xviL/c+KE40jxInFicdJxBHjSHGSceQ4Shw1jhYnFScd");
("R49jxMnEycYx4+Ti5OMU4hTjlOKU41TiVOPU4tTjNOJYcZpx7DitOE4cN047TidON04vjhfHjxPE6ccZxBnGGcUJ44zjTOJM");
("48zizOMs4qzEWY2zFmc9zkaczThbcbbjLOMQZyfObpy9OPtxDuIcxjmKcxznJM5pnLM453Eu4lzGuYpzHecmzm2cuzj3cR7i");
("PMZ5ivMc5yXOa5y3OO9xPuJ8xvmK8x3nJ85vnL/4/6wE0QRCgliCeIJEAjGBlCCZQE6gJFATaAlSCdIJ9ARGgkyCbAIzQS5B");
("PkEhQTFBKUE5QSVBNUEtQT1BI4GVoJnATtBK4CRwE7QTdBJ0E/QSeAn8BEGCfoJBgmGCUYIwwTjBJME0wSzBPMEiwUqC1QRr");
("CdYTbCTYTLCVYDvBMgEJdhLsJthLsJ/gIMFhgqMExwlOEpwmOEtwnuAiwWWCqwTXCW4S3Ca4S3Cf4CHBY4KnBM8JXhK8JnhL");
("8J7gI8Fngq8E3wl+Evwm+Ev8zxKJiggiMZG4SEJEFJFEkiKyiCKiimgiKZG0iC5iiGREsiKmSE4kL1IQKYqURMoiFZGqSE2k");
("LtIQsUSaIrZIS8QRcUXaIh2RrkhPxBPxRQKRvshAZCgyEglFxiITkanITGQushBZEVkVWRNZF9kQ2RTZEtkWWYogsiOyK7In");
("si9yIHIociRyLHIicipyJnIuciFyKXIlci1yI3IrcidyL/Ig8ijyJPIs8iLyKvIm8i7yIfIp8iXyLfIj8ivyJ/7PkohKCBIx");
("ibhEQkKUkCSSErKEIqFKaBIpibSELmFIZCSyEqZETiIvUZAoSpQkyhIViapETaIu0ZCwJJoStkRLwpFwJdoSHYmuRE/Ck/Al");
("Aom+xEBiKDGSCCXGEhOJqcRMYi6xkFiRWJVYk1iX2JDYlNiS2JZYSiCxI7ErsSexL3EgcShxJHEscSJxKnEmcS5xIXEpcSVx");
("LXEjcStxJ3Ev8SDxKPEk8SzxIvEq8SbxLvEh8SnxJfEt8SPxK/En/c9KEk0iJIkliSdJJBGTSEmSSeQkShI1iZYklSSdRE9i");
("JMkkySYxk+SS5JMUkhSTlJKUk1SSVJPUktSTNJJYSZpJ7CStJE4SN0k7SSdJN0kviZfETxIk6ScZJBkmGSUJk4yTTJJMk8yS");
("zJMskqwkWU2ylmQ9yUaSzSRbSbaTLJOQZCfJbpK9JPtJDpIcJjlKcpzkJMlpkrMk50kuklwmuUpyneQmyW2SuyT3SR6SPCZ5");
("SvKc5CXJa5K3JO9JPpJ8JvlK8p3kJ8lvkr/k/yyZqIwgE5OJyyRkRBlJJikjyygyqowmk5JJy+gyhkxGJitjyuRk8jIFmaJM");
("SaYsU5GpytRk6jINGUumKWPLtGQcGVemLdOR6cr0ZDwZXyaQ6csMZIYyI5lQZiwzkZnKzGTmMguZFZlVmTWZdZkNmU2ZLZlt");
("maUMMjsyuzJ7MvsyBzKHMkcyxzInMqcyZzLnMhcylzJXMtcyNzK3Mncy9zIPMo8yTzLPMi8yrzJvMu8yHzKfMl8y3zI/Mr8y");
("f/L/LIWogqAQU4grJBREBUkhqSArKAqqgqaQUkgr6AqGQkYhq2Aq5BTyCgWFokJJoaxQUagq1BTqCg0FS6GpYCu0FBwFV6Gt");
("0FHoKvQUPAVfIVDoKwwUhgojhVBhrDBRmCrMFOYKC4UVhVWFNYV1hQ2FTYUthW2FpQIKOwq7CnsK+woHCocKRwrHCicKpwpn");
("CucKFwqXClcK1wo3CrcKdwr3Cg8KjwpPCs8KLwqvCm8K7wofCp8KXwrfCj8Kvwp/yv8slaiKoBJTiaskVEQVSSWpIqsoKqqK");
("ppJSSavoKoZKRiWrYqrkVPIqBZWiSkmlrFJRqarUVOoqDRVLpaliq7RUHBVXpa3SUemq9FQ8FV8lUOmrDFSGKiOVUGWsMlGZ");
("qsxU5ioLlRWVVZU1lXWVDZVNlS2VbZWlCio7Krsqeyr7KgcqhypHKscqJyqnKmcq5yoXKpcqVyrXKjcqtyp3KvcqDyqPKk8q");
("zyovKq8qbyrvKh8qnypfKt8qPyq/Kn/q/yyNqIagEdOIayQ0RA1JI6khaygaqoamkdJIa+gahkZGI6thauQ08hoFjaJGSaOs");
("UdGoatQ06hoNDUujqWFrtDQcDVejrdHR6Gr0NDwNXyPQ6GsMNIYaI41QY6wx0ZhqzDTmGguNFY1VjTWNdY0NjU2NLY1tjaUG");
("Gjsauxp7GvsaBxqHGkcaxxonGqcaZxrnGhcalxpXGtcaNxq3Gnca9xoPGo8aTxrPGi8arxpvGu8aHxqfGl8a3xo/Gr8af9r/");
("rBTRFEKKWIp4ikQKMYWUIplCTqGkUFNoKVIp0in0FEaKTIpsCjNFLkU+RSFFMUUpRTlFJUU1RS1FPUUjhZWimcJO0UrhpHBT");
("tFN0UnRT9FJ4KfwUQYp+ikGKYYpRijDFOMUkxTTFLMU8xSLFSorVFGsp1lNspNhMsZViO8UyBSl2Uuym2Euxn+IgxWGKoxTH");
("KU5SnKY4S3Ge4iLFZYqrFNcpblLcprhLcZ/iIcVjiqcUzyleUrymeEvxnuIjxWeKrxTfKX5S/Kb4S/3PShNNI6SJpYmnSaQR");
("00hpkmnkNEoaNY2WJpUmnUZPY6TJpMmmMdPk0uTTFNIU05TSlNNU0lTT1NLU0zTSWGmaaew0rTROGjdNO00nTTdNL42Xxk8T");
("pOmnGaQZphmlCdOM00zSTNPM0szTLNKspFlNs5ZmPc1Gms00W2m20yzTkGYnzW6avTT7aQ7SHKY5SnOc5iTNaZqzNOdpLtJc");
("prlKc53mJs1tmrs092ke0jymeUrznOYlzWuatzTvaT7SfKb5SvOd5ifNb5q/9P8snaiOoBPTieskdEQdSSepI+soOqqOppPS");
("SevoOoZORierY+rkdPI6BZ2iTkmnrFPRqerUdOo6DR1Lp6lj67R0HB1Xp63T0enq9HQ8HV8n0OnrDHSGOiOdUGesM9GZ6sx0");
("5joLnRWdVZ01nXWdDZ1NnS2dbZ2lDjo7Ors6ezr7Ogc6hzpHOsc6JzqnOmc65zoXOpc6VzrXOjc6tzp3Ovc6DzqPOk86zzov");
("Oq86bzrvOh86nzpfOt86Pzq/On/6/yyDqIFgEDOIGyQMRAPJIGkgGygGqoFmkDJIG+gGhkHGIGtgGuQM8gYFg6JByaBsUDGo");
("GtQM6gYNA8ugaWAbtAwcA9egbdAx6Br0DDwD3yAw6BsMDIYGI4PQYGwwMZgazAzmBguDFYNVgzWDdYMNg02DLYNtg6UBBjsG");
("uwZ7BvsGBwaHBkcGxwYnBqcGZwbnBhcGlwZXBtcGNwa3BncG9wYPBo8GTwbPBi8GrwZvBu8GHwafBl8G3wY/Br8Gf8b/rAzR");
("DEKGWIZ4hkQGMYOUIZlBzqBkUDNoGVIZ0hn0DEaGTIZsBjNDLkM+QyFDMUMpQzlDJUM1Qy1DPUMjg5WhmcHO0MrgZHAztDN0");
("MnQz9DJ4GfwMQYZ+hkGGYYZRhjDDOMMkwzTDLMM8wyLDSobVDGsZ1jNsZNjMsJVhO8MyAxl2Muxm2Muwn+Egw2GGowzHGU4y");
("nGY4y3Ce4SLDZYarDNcZbjLcZrjLcJ/hIcNjhqcMzxleMrxmeMvwnuEjw2eGrwzfGX4y/Gb4y/zPyhLNImSJZYlnSWQRs0hZ");
("klnkLEoWNYuWJZUlnUXPYmTJZMlmMbPksuSzFLIUs5SylLNUslSz1LLUszSyWFmaWewsrSxOFjdLO0snSzdLL4uXxc8SZOln");
("GWQZZhllCbOMs0yyTLPMssyzLLKsZFnNspZlPctGls0sW1m2syyzkGUny26WvSz7WQ6yHGY5ynKc5STLaZazLOdZLrJcZrnK");
("cp3lJsttlrss91kesjxmecrynOUly2uWtyzvWT6yfGb5yvKd5SfLb5a/7P8sk6iJYBIziZskTEQTySRpIpsoJqqJZpIySZvo");
("JoZJxiRrYprkTPImBZOiScmkbFIxqZrUTOomDRPLpGlim7RMHBPXpG3SMema9Ew8E98kMOmbDEyGJiOT0GRsMjGZmsxM5iYL");
("kxWTVZM1k3WTDZNNky2TbZOlCSY7Jrsmeyb7JgcmhyZHJscmJyanJmcm5yYXJpcmVybXJjcmtyZ3JvcmDyaPJk8mzyYvJq8m");
("bybvJh8mnyZfJt8mPya/Jn/m/6wc0RxCjliOeI5EDjGHlCOZQ86h5FBzaDlSOdI59BxGjkyObA4zRy5HPkchRzFHKUc5RyVH");
("NUctRz1HI4eVo5nDztHK4eRwc7RzdHJ0c/RyeDn8HEGOfo5BjmGOUY4wxzjHJMc0xyzHPMcix0qO1RxrOdZzbOTYzLGVYzvH");
("Mgc5dnLs5tjLsZ/jIMdhjqMcxzlOcpzmOMtxnuMix2WOqxzXOW5y3Oa4y3Gf4yHHY46nHM85XnK85njL8Z7jI8dnjq8c3zl+");
("cvzm+Mv9z8oTzSPkieWJ50nkEfNIeZJ55DxKHjWPlieVJ51Hz2PkyeTJ5jHz5PLk8xTyFPOU8pTzVPJU89Ty1PM08lh5mnns");
("PK08Th43TztPJ083Ty+Pl8fPE+Tp5xnkGeYZ5QnzjPNM8kzzzPLM8yzyrORZzbOWZz3PRp7NPFt5tvMs85BnJ89unr08+3kO");
("8hzmOcpznOckz2meszzneS7yXOa5ynOd5ybPbZ67PPd5HvI85nnK85znJc9rnrc873k+8nzm+crznecnz2+ev/z/rALRAkKB");
("WIF4gUQBsYBUIFlALqAUUAtoBVIF0gX0AkaBTIFsAbNArkC+QKFAsUCpQLlApUC1QK1AvUCjgFWgWcAu0CrgFHALtAt0CnQL");
("9Ap4BfwCQYF+gUGBYYFRgbDAuMCkwLTArMC8wKLASoHVAmsF1gtsFNgssFVgu8CyAAV2CuwW2CuwX+CgwGGBowLHBU4KnBY4");
("K3Be4KLAZYGrAtcFbgrcFrgrcF/gocBjgacCzwVeCrwWeCvwXuCjwGeBrwLfBX4K/Bb4K/zPKhItIhSJFYkXSRQRi0hFkkXk");
("IkoRtYhWJFUkXUQvYhTJFMkWMYvkiuSLFIoUi5SKlItUilSL1IrUizSKWEWaRewirSJOEbdIu0inSLdIr4hXxC8SFOkXGRQZ");
("FhkVCYuMi0yKTIvMisyLLIqsFFktslZkvchGkc0iW0W2iyyLUGSnyG6RvSL7RQ6KHBY5KnJc5KTIaZGzIudFLopcFrkqcl3k");
("pshtkbsi90UeijwWeSryXOSlyGuRtyLvRT6KfBb5KvJd5KfIb5G/4v+sEtESQolYiXiJRAmxhFQiWUIuoZRQS2glUiXSJfQS");
("RolMiWwJs0SuRL5EoUSxRKlEuUSlRLVErUS9RKOEVaJZwi7RKuGUcEu0S3RKdEv0Sngl/BJBiX6JQYlhiVGJsMS4xKTEtMSs");
("xLzEosRKidUSayXWS2yU2CyxVWK7xLIEJXZK7JbYK7Ff4qDEYYmjEsclTkqcljgrcV7iosRliasS1yVuStyWuCtxX+KhxGOJ");
("pxLPJV5KvJZ4K/Fe4qPEZ4mvEt8lfkr8lvgr/c8qEy0jlImViZdJlBHLSGWSZeQyShm1jFYmVSZdRi9jlMmUyZYxy+TK5MsU");
("yhTLlMqUy1TKVMvUytTLNMpYZZpl7DKtMk4Zt0y7TKdMt0yvjFfGLxOU6ZcZlBmWGZUJy4zLTMpMy8zKzMssyqyUWS2zVma9");
("zEaZzTJbZbbLLMtQZqfMbpm9MvtlDsocljkqc1zmpMxpmbMy52UuylyWuSpzXeamzG2ZuzL3ZR7KPJZ5KvNc5qXMa5m3Mu9l");
("Psp8lvkq813mp8xvmb/y/6wK0QpChViFeIVEBbGCVCFZQa6gVFAraBVSFdIV9ApGhUyFbAWzQq5CvkKhQrFCqUK5QqVCtUKt");
("Qr1Co4JVoVnBrtCq4FRwK7QrdCp0K/QqeBX8CkGFfoVBhWGFUYWwwrjCpMK0wqzCvMKiwkqF1QprFdYrbFTYrLBVYbvCsgIV");
("dirsVtirsF/hoMJhhaMKxxVOKpxWOKtwXuGiwmWFqwrXFW4q3Fa4q3Bf4aHCY4WnCs8VXiq8Vnir8F7ho8Jnha8K3xV+KvxW");
("+Kv8z6oSrSJUiVWJV0lUEatIVZJV5CpKFbWKViVVJV1Fr2JUyVTJVjGr5KrkqxSqFKuUqpSrVKpUq9Sq1Ks0qlhVmlXsKq0q");
("ThW3SrtKp0q3Sq+KV8WvElTpVxlUGVYZVQmrjKtMqkyrzKrMqyyqrFRZrbJWZb3KRpXNKltVtqssq1Blp8pulb0q+1UOqhxW");
("OapyXOWkymmVsyrnVS6qXFa5qnJd5abKbZW7KvdVHqo8Vnmq8lzlpcprlbcq71U+qnxW+aryXeWnym+Vv+r/rBrRGkKNWI14");
("jUQNsYZUI1lDrqHUUGtoNVI10jX0GkaNTI1sDbNGrka+RqFGsUapRrlGpUa1Rq1GvUajhlWjWcOu0arh1HBrtGt0anRr9Gp4");
("NfwaQY1+jUGNYY1RjbDGuMakxrTGrMa8xqLGSo3VGms11mts1NissVVju8ayBjV2auzW2KuxX+OgxmGNoxrHNU5qnNY4q3Fe");
("46LGZY2rGtc1bmrc1rircV/jocZjjacazzVearzWeKvxXuOjxmeNrxrfNX5q/Nb4q/3PqhOtI9SJ1YnXSdQR60h1knXkOkod");
("tY5WJ1UnXUevY9TJ1MnWMevk6uTrFOoU65TqlOtU6lTr1OrU6zTqWHWadew6rTpOHbdOu06nTrdOr45Xx68T1OnXGdQZ1hnV");
("CeuM60zqTOvM6szrLOqs1Fmts1Znvc5Gnc06W3W26yzrUGenzm6dvTr7dQ7qHNY5qnNc56TOaZ2zOud1Lupc1rmqc13nps5t");
("nbs693Ue6jzWearzXOelzmudtzrvdT7qfNb5qvNd56fOb52/+v+sBtEGQoNYg3iDRAOxgdQg2UBuoDRQG2gNUg3SDfQGRoNM");
("g2wDs0GuQb5BoUGxQalBuUGlQbVBrUG9QaOB1aDZwG7QauA0cBu0G3QadBv0GngN/AZBg36DQYNhg1GDsMG4waTBtMGswbzB");
("osFKg9UGaw3WG2w02Gyw1WC7wbIBDXYa7DbYa7Df4KDBYYOjBscNThqcNjhrcN7gosFlg6sG1w1uGtw2uGtw3+ChwWODpwbP");
("DV4avDZ4a/De4KPBZ4OvBt8Nfhr8Nvhr/M+yiFoIFjGLuEXCQrSQLJIWsoVioVpoFimLtIVuYVhkLLIWpkXOIm9RsChalCzK");
("FhWLqkXNom7RsLAsmha2RcvCsXAt2hYdi65Fz8Kz8C0Ci77FwGJoMbIILcYWE4upxcxibrGwWLFYtVizWLfYsNi02LLYtlha");
("YLFjsWuxZ7FvcWBxaHFkcWxxYnFqcWZxbnFhcWlxZXFtcWNxa3FncW/xYPFo8WTxbPFi8WrxZvFu8WHxafFl8W3xY/Fr8Wf9");
("z2oSbSI0iTWJN0k0EZtITZJN5CZKE7WJ1iTVJN1Eb2I0yTTJNjGb5JrkmxSaFJuUmpSbVJpUm9Sa1Js0mlhNmk3sJq0mThO3");
("SbtJp0m3Sa+J18RvEjTpNxk0GTYZNQmbjJtMmkybzJrMmyyarDRZbbLWZL3JRpPNJltNtpssm9Bkp8luk70m+00Omhw2OWpy");
("3OSkyWmTsybnTS6aXDa5anLd5KbJbZO7JvdNHpo8Nnlq8tzkpclrk7cm700+mnw2+Wry3eSnyW+Tv+b/LJuojWATs4nbJGxE");
("G8kmaSPbKDaqjWaTsknb6DaGTcYma2Pa5GzyNgWbok3JpmxTsana1GzqNg0by6ZpY9u0bBwb16Zt07Hp2vRsPBvfJrDp2wxs");
("hjYjm9BmbDOxmdrMbOY2C5sVm1WbNZt1mw2bTZstm22bpQ02Oza7Nns2+zYHNoc2RzbHNic2pzZnNuc2FzaXNlc21zY3Nrc2");
("dzb3Ng82jzZPNs82LzavNm827zYfNp82XzbfNj82vzZ/9v+sFtEWQotYi3iLRAuxhdQi2UJuobRQW2gtUi3SLfQWRotMi2wL");
("s0WuRb5FoUWxRalFuUWlRbVFrUW9RaOF1aLZwm7RauG0cFu0W3RadFv0Wngt/BZBi36LQYthi1GLsMW4xaTFtMWsxbzFosVK");
("i9UWay3WW2y02Gyx1WK7xbIFLXZa7LbYa7Hf4qDFYYujFsctTlqctjhrcd7iosVli6sW1y1uWty2uGtx3+KhxWOLpxbPLV5a");
("vLZ4a/He4qPFZ4uvFt8tflr8tvhr/c9yiDoIDjGHuEPCQXSQHJIOsoPioDpoDimHtIPuYDhkHLIOpkPOIe9QcCg6lBzKDhWH");
("qkPNoe7QcLAcmg62Q8vBcXAd2g4dh65Dz8Fz8B0Ch77DwGHoMHIIHcYOE4epw8xh7rBwWHFYdVhzWHfYcNh02HLYdlg64LDj");
("sOuw57DvcOBw6HDkcOxw4nDqcOZw7nDhcOlw5XDtcONw63DncO/w4PDo8OTw7PDi8Orw5vDu8OHw6fDl8O3w4/Dr8Of8z3KJ");
("ugguMZe4S8JFdJFcki6yi+KiumguKZe0i+5iuGRcsi6mS84l71JwKbqUXMouFZeqS82l7tJwsVyaLrZLy8VxcV3aLh2XrkvP");
("xXPxXQKXvsvAZegycgldxi4Tl6nLzGXusnBZcVl1WXNZd9lw2XTZctl2WbrgsuOy67Lnsu9y4HLocuRy7HLicupy5nLucuFy");
("6XLlcu1y43Lrcudy7/Lg8ujy5PLs8uLy6vLm8u7y4fLp8uXy7fLj8uvy5/7PahNtI7SJtYm3SbQR20htkm3kNkobtY3WJtUm");
("3UZvY7TJtMm2Mdvk2uTbFNoU25TalNtU2lTb1NrU2zTaWG2abew2rTZOG7dNu02nTbdNr43Xxm8TtOm3GbQZthm1CduM20za");
("TNvM2szbLNqstFlts9Zmvc1Gm802W2222yzb0GanzW6bvTb7bQ7aHLY5anPc5qTNaZuzNudtLtpctrlqc93mps1tm7s2920e");
("2jy2eWrz3OalzWubtzbvbT7afLb5avPd5qfNb5u/9v+sDtEOQodYh3iHRAexg9Qh2UHuoHRQO2gdUh3SHfQORodMh2wHs0Ou");
("Q75DoUOxQ6lDuUOlQ7VDrUO9Q6OD1aHZwe7Q6uB0cDu0O3Q6dDv0Ongd/A5Bh36HQYdhh1GHsMO4w6TDtMOsw7zDosNKh9UO");
("ax3WO2x02Oyw1WG7w7IDHXY67HbY67Df4aDDYYejDscdTjqcdjjrcN7hosNlh6sO1x1uOtx2uOtw3+Ghw2OHpw7PHV46vHZ4");
("6/De4aPDZ4evDt8dfjr8dvjr/M/qEu0idIl1iXdJdBG7SF2SXeQuShe1i9Yl1SXdRe9idMl0yXYxu+S65LsUuhS7lLqUu1S6");
("VLvUutS7NLpYXZpd7C6tLk4Xt0u7S6dLt0uvi9fF7xJ06XcZdBl2GXUJu4y7TLpMu8y6zLssuqx0We2y1mW9y0aXzS5bXba7");
("LLvQZafLbpe9LvtdDrocdjnqctzlpMtpl7Mu510uulx2uepy3eWmy22Xuy73XR66PHZ56vLc5aXLa5e3Lu9dPrp8dvnq8t3l");
("p8tvl7/u/6we0R5Cj1iPeI9ED7GH1CPZQ+6h9FB7aD1SPdI99B5Gj0yPbA+zR65HvkehR7FHqUe5R6VHtUetR71Ho4fVo9nD");
("7tHq4fRwe7R7dHp0e/R6eD38HkGPfo9Bj2GPUY+wx7jHpMe0x6zHvMeix0qP1R5rPdZ7bPTY7LHVY7vHsgc9dnrs9tjrsd/j");
("oMdhj6Mexz1Oepz2OOtx3uOix2WPqx7XPW563Pa463Hf46HHY4+nHs89Xnq89njr8d7jo8dnj68e3z1+evz2+Ov9z/KIegge");
("MY+4R8JD9JA8kh6yh+KhemgeKY+0h+5heGQ8sh6mR84j71HwKHqUPMoeFY+qR82j7tHwsDyaHrZHy8PxcD3aHh2PrkfPw/Pw");
("PQKPvsfAY+gx8gg9xh4Tj6nHzGPusfBY8Vj1WPNY99jw2PTY8tj2WHrgseOx67Hnse9x4HHoceRx7HHicepx5nHuceFx6XHl");
("ce1x43Hrcedx7/Hg8ejx5PHs8eLx6vHm8e7x4fHp8eXx7fHj8evx5/3P8on6CD4xn7hPwkf0kXySPrKP4qP6aD4pn7SP7mP4");
("ZHyyPqZPzifvU/Ap+pR8yj4Vn6pPzafu0/CxfJo+tk/Lx/Fxfdo+HZ+uT8/H8/F9Ap++z8Bn6DPyCX3GPhOfqc/MZ+6z8Fnx");
("WfVZ81n32fDZ9Nny2fZZ+uCz47Prs+ez73Pgc+hz5HPsc+Jz6nPmc+5z4XPpc+Vz7XPjc+tz53Pv8+Dz6PPk8+zz4vPq8+bz");
("7vPh8+nz5fPt8+Pz6/Pn/88KiAYIAbGAeEAiQAyQApIBcoASoAZoAamAdIAeYARkArIBZkAuIB9QCCgGlALKAZWAakAtoB7Q");
("CLACmgF2QCvACXAD2gGdgG5AL8AL8AOCgH7AIGAYMAoIA8YBk4BpwCxgHrAIWAlYDVgLWA/YCNgM2ArYDlgGELATsBuwF7Af");
("cBBwGHAUcBxwEnAacBZwHnARcBlwFXAdcBNwG3AXcB/wEPAY8BTwHPAS8BrwFvAe8BHwGfAV8B3wE/Ab8Bf8z+oT7SP0ifWJ");
("90n0EftIfZJ95D5KH7WP1ifVJ91H72P0yfTJ9jH75Prk+xT6FPuU+pT7VPpU+9T61Ps0+lh9mn3sPq0+Th+3T7tPp0+3T6+P");
("18fvE/Tp9xn0GfYZ9Qn7jPtM+kz7zPrM+yz6rPRZ7bPWZ73PRp/NPlt9tvss+9Bnp89un70++30O+hz2Oepz3Oekz2mfsz7n");
("fS76XPa56nPd56bPbZ+7Pvd9Hvo89nnq89znpc9rn7c+730++nz2+erz3eenz2+fv/7/rAHRAcKA2ID4gMQAcYA0IDlAHqAM");
("UAdoA1ID0gP0AcaAzIDsAHNAbkB+QGFAcUBpQHlAZUB1QG1AfUBjgDWgOcAe0BrgDHAHtAd0BnQH9AZ4A/wBwYD+gMGA4YDR");
("gHDAeMBkwHTAbMB8wGLAyoDVAWsD1gdsDNgcsDVge8ByAAN2BuwO2BuwP+BgwOGAowHHA04GnA44G3A+4GLA5YCrAdcDbgbc");
("DrgbcD/gYcDjgKcBzwNeBrwOeBvwPuBjwOeArwHfA34G/A74G/zPGhIdIgyJDYkPSQwRh0hDkkPkIcoQdYg2JDUkPUQfYgzJ");
("DMkOMYfkhuSHFIYUh5SGlIdUhlSH1IbUhzSGWEOaQ+whrSHOEHdIe0hnSHdIb4g3xB8SDOkPGQwZDhkNCYeMh0yGTIfMhsyH");
("LIasDFkdsjZkfcjGkM0hW0O2hyyHMGRnyO6QvSH7Qw6GHA45GnI85GTI6ZCzIedDLoZcDrkacj3kZsjtkLsh90MehjwOeRry");
("PORlyOuQtyHvQz6GfA75GvI95GfI75C/4f+sEdERwojYiPiIxAhxhDQiOUIeoYxQR2gjUiPSI/QRxojMiOwIc0RuRH5EYURx");
("RGlEeURlRHVEbUR9RGOENaI5wh7RGuGMcEe0R3RGdEf0Rngj/BHBiP6IwYjhiNGIcMR4xGTEdMRsxHzEYsTKiNURayPWR2yM");
("2ByxNWJ7xHIEI3ZG7I7YG7E/4mDE4YijEccjTkacjjgbcT7iYsTliKsR1yNuRtyOuBtxP+JhxOOIpxHPI15GvI54G/E+4mPE");
("54ivEd8jfkb8jvgb/c8KiYYIIbGQeEgiRAyRQpIhcogSooZoIamQdIgeYoRkQrIhZkguJB9SCCmGlELKIZWQakgtpB7SCLFC");
("miF2SCvECXFD2iGdkG5IL8QL8UOCkH7IIGQYMgoJQ8Yhk5BpyCxkHrIIWQlZDVkLWQ/ZCNkM2QrZDlmGELITshuyF7IfchBy");
("GHIUchxyEnIachZyHnIRchlyFXIdchNyG3IXch/yEPIY8hTyHPIS8hryFvIe8hHyGfIV8h3yE/Ib8hf+zxoTHSOMiY2Jj0mM");
("EcdIY5Jj5DHKGHWMNiY1Jj1GH2OMyYzJjjHH5MbkxxTGFMeUxpTHVMZUx9TG1Mc0xlhjmmPsMa0xzhh3THtMZ0x3TG+MN8Yf");
("E4zpjxmMGY4ZjQnHjMdMxkzHzMbMxyzGrIxZHbM2Zn3MxpjNMVtjtscsxzBmZ8zumL0x+2MOxhyOORpzPOZkzOmYszHnYy7G");
("XI65GnM95mbM7Zi7MfdjHsY8jnka8zzmZczrmLcx72M+xnyO+RrzPeZnzO+Yv/H/rAnRCcKE2IT4hMQEcYI0ITlBnqBMUCdo");
("E1IT0hP0CcaEzITsBHNCbkJ+QmFCcUJpQnlCZUJ1Qm1CfUJjgjWhOcGe0JrgTHAntCd0JnQn9CZ4E/wJwYT+hMGE4YTRhHDC");
("eMJkwnTCbMJ8wmLCyoTVCWsT1idsTNicsDVhe8JyAhN2JuxO2JuwP+FgwuGEownHE04mnE44m3A+4WLC5YSrCdcTbibcTrib");
("cD/hYcLjhKcJzxNeJrxOeJvwPuFjwueErwnfE34m/E74m/zPmhKdIkyJTYlPSUwRp0hTklPkKcoUdYo2JTUlPUWfYkzJTMlO");
("MafkpuSnFKYUp5SmlKdUplSn1KbUpzSmWFOaU+wprSnOFHdKe0pnSndKb4o3xZ8STOlPGUwZThlNCaeMp0ymTKfMpsynLKas");
("TFmdsjZlfcrGlM0pW1O2pyynMGVnyu6UvSn7Uw6mHE45mnI85WTK6ZSzKedTLqZcTrmacj3lZsrtlLsp91MepjxOeZryPOVl");
("yuuUtynvUz6mfE75mvI95WfK75S/6f+sGdEZwozYjPiMxAxxhjQjOUOeocxQZ2gzUjPSM/QZxozMjOwMc0ZuRn5GYUZxRmlG");
("eUZlRnVGbUZ9RmOGNaM5w57RmuHMcGe0Z3RmdGf0Zngz/BnBjP6MwYzhjNGMcMZ4xmTGdMZsxnzGYsbKjNUZazPWZ2zM2Jyx");
("NWN7xnIGM3Zm7M7Ym7E/42DG4YyjGcczTmaczjibcT7jYsbljKsZ1zNuZtzOuJtxP+NhxuOMpxnPM15mvM54m/E+42PG54yv");
("Gd8zfmb8zvib/c+aE50jzInNic9JzBHnSHOSc+Q5yhx1jjYnNSc9R59jzMnMyc4x5+Tm5OcU5hTnlOaU51TmVOfU5tTnNOZY");
("c5pz7DmtOc4cd057TmdOd05vjjfHnxPM6c8ZzBnOGc0J54znTOZM58zmzOcs5qzMWZ2zNmd9zsaczTlbc7bnLOcwZ2fO7py9");
("OftzDuYczjmaczznZM7pnLM553Mu5lzOuZpzPedmzu2cuzn3cx7mPM55mvM852XO65y3Oe9zPuZ8zvma8z3nZ87vnL/5/6wF");
("0QXCgtiC+ILEAnGBtCC5QF6gLFAXaAtSC9IL9AXGgsyC7AJzQW5BfkFhQXFBaUF5QWVBdUFtQX1BY4G1oLnAXtBa4CxwF7QX");
("dBZ0F/QWeAv8BcGC/oLBguGC0YJwwXjBZMF0wWzBfMFiwcqC1QVrC9YXbCzYXLC1YHvBcgELdhbsLthbsL/gYMHhgqMFxwtO");
("FpwuOFtwvuBiwb8K7sAjfjCO4zg/SZIkSZIkSZIkSZIkSZIkSZIkSZJzzjnnnPN2zjnnnDNnzpmZmZmZmZmZmZmZ/V2/2p/w");
("sj37Pt/v53mkH+QflB/UH7Qf9B+MH8wfrB/sH5wf3B+8H/wfgh/CH6If4h+SH9Ifsh/yn1+sAv8KTBSYLDBVYLrATIHZAnMF");
("5gssFFgssFRgucBKgdUCawXWC2wU2CywVWC7wE6B3QJ7BfYLHBQ4LHBU4LjASYHTAmcFzgtcFLgscFXgusBNgdsCdwXuCzwU");
("eCzwVOC5wEuB1wJvBd4LfBT4LPBV4LvAT4FCgWKBUoFygUqBaoFagXqBRgEKNAu0CrQLdAp0C/QK9AsMCggFhgXEAqMC4wJS");
("AbmAUkAtoBXQCxgFzAJWAbuAU8At4BXwCwQFwgJRgbhAUiAtkBXIC79YRf4VmSgyWWSqyHSRmSKzReaKzBdZKLJYZKnIcpGV");
("IqtF1oqsF9kosllkq8h2kZ0iu0X2iuwXOShyWOSoyHGRkyKnRc6KnBe5KHJZ5KrIdZGbIrdF7orcF3ko8ljkqchzkZcir0Xe");
("irwX+SjyWeSryHeRnyKFIsUipSLlIpUi1SK1IvUijSIUaRZpFWkX6RTpFukV6RcZFBGKDIuIRUZFxkWkInIRpYhaRCuiFzGK");
("mEWsInYRp4hbxCviFwmKhEWiInGRpEhaJCuSF3+xSvwrMVFissRUiekSMyVmS8yVmC+xUGKxxFKJ5RIrJVZLrJVYL7FRYrPE");
("VontEjsldkvsldgvcVDisMRRieMSJyVOS5yVOC9xUeKyxFWJ6xI3JW5L3JW4L/FQ4rHEU4nnEi8lXku8lXgv8VHis8RXie8S");
("PyUKJYolSiXKJSolqiVqJeolGiUo0SzRKtEu0SnRLdEr0S8xKCGUGJYQS4xKjEtIJeQSSgm1hFZCL2GUMEtYJewSTgm3hFfC");
("LxGUCEtEJeISSYm0RFYiL/1ilflXZqLMZJmpMtNlZsrMlpkrM19mocximaUyy2VWyqyWWSuzXmajzGaZrTLbZXbK7JbZK7Nf");
("5qDMYZmjMsdlTsqcljkrc17mosxlmasy12VuytyWuStzX+ahzGOZpzLPZV7KvJZ5K/Ne5qPMZ5mvMt9lfsoUyhTLlMqUy1TK");
("VMvUytTLNMpQplmmVaZdplOmW6ZXpl9mUEYoMywjlhmVGZeRyshllDJqGa2MXsYoY5axythlnDJuGa+MXyYoE5aJysRlkjJp");
("maxMXv7FqvCvwkSFyQpTFaYrzFSYrTBXYb7CQoXFCksVliusVFitsFZhvcJGhc0KWxW2K+xU2K2wV2G/wkGFwwpHFY4rnFQ4");
("rXBW4bzCRYXLClcVrivcVLitcFfhvsJDhccKTxWeK7xUeK3wVuG9wkeFzwpfFb4r/FQoVChWKFUoV6hUqFaoVahXaFSgQrNC");
("q0K7QqdCt0KvQr/CoIJQYVhBrDCqMK4gVZArKBXUCloFvYJRwaxgVbArOBXcCl4Fv0JQIawQVYgrJBXSClmFvPKLVeVflYkq");
("k1WmqkxXmakyW2WuynyVhSqLVZaqLFdZqbJaZa3KepWNKptVtqpsV9mpsltlr8p+lYMqh1WOqhxXOalyWuWsynmViyqXVa6q");
("XFe5qXJb5a7KfZWHKo9Vnqo8V3mp8lrlrcp7lY8qn1W+qnxX+alSqFKsUqpSrlKpUq1Sq1Kv0qhClWaVVpV2lU6VbpVelX6V");
("QRWhyrCKWGVUZVxFqiJXUaqoVbQqehWjilnFqmJXcaq4VbwqfpWgSlglqhJXSaqkVbIqefUXq8a/GhM1JmtM1ZiuMVNjtsZc");
("jfkaCzUWayzVWK6xUmO1xlqN9RobNTZrbNXYrrFTY7fGXo39Ggc1Dmsc1TiucVLjtMZZjfMaFzUua1zVuK5xU+O2xl2N+xoP");
("NR5rPNV4rvFS47XGW433Gh81Pmt81fiu8VOjUKNYo1SjXKNSo1qjVqNeo1GDGs0arRrtGp0a3Rq9Gv0agxpCjWENscaoxriG");
("VEOuodRQa2g19BpGDbOGVcOu4dRwa3g1/BpBjbBGVCOukdRIa2Q18tovVp1/dSbqTNaZqjNdZ6bObJ25OvN1Fuos1lmqs1xn");
("pc5qnbU663U26mzW2aqzXWenzm6dvTr7dQ7qHNY5qnNc56TOaZ2zOud1Lupc1rmqc13nps5tnbs693Ue6jzWearzXOelzmud");
("tzrvdT7qfNb5qvNd56dOoU6xTqlOuU6lTrVOrU69TqMOdZp1WnXadTp1unV6dfp1BnWEOsM6Yp1RnXEdqY5cR6mj1tHq6HWM");
("OmYdq45dx6nj1vHq+HWCOmGdqE5cJ6mT1snq5PVfrAb/Gkw0mGww1WC6wUyD2QZzDeYbLDRYbLDUYLnBSoPVBmsN1htsNNhs");
("sNVgu8FOg90Gew32Gxw0OGxw1OC4wUmD0wZnDc4bXDS4bHDV4LrBTYPbBncN7hs8NHhs8NTgucFLg9cGbw3eG3w0+Gzw1eC7");
("wU+DQoNig1KDcoNKg2qDWoN6g0YDGjQbtBq0G3QadBv0GvQbDBoIDYYNxAajBuMGUgO5gdJAbaA10BsYDcwGVgO7gdPAbeA1");
("8BsEDcIGUYO4QdIgbZA1yBu/WH+XKjHxdwEOU3+XlTDzd7EEc3+XALDwd2Cbpb/Dtaz8HYRk7e/QGht/B4zY+jsMws5fcJ+9");
("v5A1B3+BWI7+wouc/AXNOPsLBXHxF+Dg6m/Yzs3fYJS7vyEWD38DB57+msO8/DXyePtruvDxt0H+3fb9bmZ+S/TfwvO3nPot");
("En5/fb8L+u8y9fvx/b5Sv1B/TxNa0IYOdKEHfRiAAEMQYQRjkEAGBVTQQAcDTLDABgdc8MCHAEKIIIYEUsgg5xeryb8mE00m");
("m0w1mW4y02S2yVyT+SYLTRabLDVZbrLSZLXJWpP1JhtNNptsNdlustNkt8lek/0mB00Omxw1OW5y0uS0yVmT8yYXTS6bXDW5");
("bnLT5LbJXZP7Jg9NHps8NXlu8tLktclbk/cmH00+m3w1+W7y06TQpNik1KTcpNKk2qTWpN6k0fyjajZpNWk36TTpNuk16TcZ");
("NBGaDJuITUZNxk2kJnITpYnaRGuiNzGamE2sJnYTp4nbxGviNwmahE2iJnGTpEnaJGuSN3+xWvxrMdFissVUi+kWMy1mW8y1");
("mG+x0GKxxVKL5RYrLVZbrLVYb7HRYrPFVovtFjstdlvstdhvcdDisMVRi+MWJy1OW5y1OG9x0eKyxVWL6xY3LW5b3LW4b/HQ");
("4rHFU4vnFi8tXlu8tXhv8dHis8VXi+8WPy0KLYotSi3KLSotqi1qLeotGq2/l6rZotWi3aLTotui16LfYtBCaDFsIbYYtRi3");
("kFrILZQWaguthd7CaGG2sFrYLZwWbguvhd8iaBG2iFrELZIWaYusRd76xWrzr81Em8k2U22m28y0mW0z12a+zUKbxTZLbZbb");
("rLRZbbPWZr3NRpvNNlttttvstNlts9dmv81Bm8M2R22O25y0OW1z1ua8zUWbyzZXba7b3LS5bXPX5r7NQ5vHNk9tntu8tHlt");
("89bmvc1Hm882X22+2/y0KbQptim1KbeptKm2qbWpt2m0/z6/ZptWm3abTptum16bfptBG6HNsI3YZtRm3EZqI7dR2qhttDZ6");
("G6ON2cZqY7dx2rhtvDZ+m6BN2CZqE7dJ2qRtsjZ5+xerw78OEx0mO0x1mO4w02G2w1yH+Q4LHRY7LHVY7rDSYbXDWof1Dhsd");
("NjtsddjusNNht8Neh/0OBx0OOxx1OO5w0uG0w1mH8w4XHS47XHW47nDT4bbDXYf7Dg8dHjs8dXju8NLhtcNbh/cOHx0+O3x1");
("+O7w06HQodih1KHcodKh2qHWod6h0flbqJodWh3aHToduh16HfodBh2EDsMOYodRh3EHqYPcQemgdtA66B2MDmYHq4Pdweng");
("dvA6+B2CDmGHqEPcIemQdsg65J1frC7/ukx0mewy1WW6y0yX2S5zXea7LHRZ7LLUZbnLSpfVLmtd1rtsdNnsstVlu8tOl90u");
("e132uxx0Oexy1OW4y0mX0y5nXc67XHS57HLV5brLTZfbLndd7rs8dHns8tTluctLl9cub13eu3x0+ezy1eW7y0+XQpdil1KX");
("cpdKl2qXWpd6l0b3b0lvdml1aXfpdOl26XXpdxl0EboMu4hdRl3GXaQucheli9pF66J3MbqYXawudheni9vF6+J3CbqEXaIu");
("cZekS9ol65J3f7F6/Osx0WOyx1SP6R4zPWZ7zPWY77HQY7HHUo/lHis9Vnus9VjvsdFjs8dWj+0eOz12e+z12O9x0OOwx1GP");
("4x4nPU57nPU473HR47LHVY/rHjc9bnvc9bjv8dDjscdTj+ceLz1ee7z1eO/x0eOzx1eP7x4/PQo9ij1KPco9Kj2qPWo96j0a");
("vb+fX7NHq0e7R6dHt0evR7/HoIfQY9hD7DHqMe4h9ZB7KD3UHloPvYfRw+xh9bB7OD3cHl4Pv0fQI+wR9Yh7JD3SHlmPvPeL");
("1edfn4k+k32m+kz3mekz22euz3yfhT6LfZb6LPdZ6bPaZ63Pep+NPpt9tvps99nps9tnr89+n4M+h32O+hz3Oelz2uesz3mf");
("iz6Xfa76XPe56XPb567PfZ+HPo99nvo893np89rnrc97n48+n32++nz3+elT6FPsU+pT7lPpU+1T61Pv0+j/lQnNPq0+7T6d");
("Pt0+vT79PoM+Qp9hH7HPqM+4j9RH7qP0UftoffQ+Rh+zj9XH7uP0cft4ffw+QZ+wT9Qn7pP0SftkffL+L9aAfwMmBkwOmBow");
("PWBmwOyAuQHzAxYGLA5YGrA8YGXA6oC1AesDNgZsDtgasD1gZ8DugL0B+wMOBhwOOBpwPOBkwOmAswHnAy4GXA64GnA94GbA");
("7YC7AfcDHgY8Dnga8DzgZcDrgLcB7wM+BnwO+BrwPeBnQGFAcUBpQHlAZUB1QG1AfUBj8FdQNQe0BrQHdAZ0B/QG9AcMBggD");
("hgPEAaMB4wHSAHmAMkAdoA3QBxgDzAHWAHuAM8Ad4A3wBwQDwgHRgHhAMiAdkA3IB79YAv8EJgQmBaYEpgVmBGYF5gTmBRYE");
("FgWWBJYFVgRWBdYE1gU2BDYFtgS2BXYEdgX2BPYFDgQOBY4EjgVOBE4FzgTOBS4ELgWuBK4FbgRuBe4E7gUeBB4FngSeBV4E");
("XgXeBN4FPgQ+Bb4EvgV+BAoCRYGSQFmgIlAVqAnUBRrCX+nZFGgJtAU6Al2BnkBfYCAgCAwFRIGRwFhAEpAFFAFVQBPQBQwB");
("U8ASsAUcAVfAE/AFAoFQIBKIBRKBVCATyIVfrCH/hkwMmRwyNWR6yMyQ2SFzQ+aHLAxZHLI0ZHnIypDVIWtD1odsDNkcsjVk");
("e8jOkN0he0P2hxwMORxyNOR4yMmQ0yFnQ86HXAy5HHI15HrIzZDbIXdD7oc8DHkc8jTkecjLkNchb0Peh3wM+RzyNeR7yM+Q");
("wpDikNKQ8pDKkOqQ2pD6kMbwr0hvDmkNaQ/pDOkO6Q3pDxkMEYYMh4hDRkPGQ6Qh8hBliDpEG6IPMYaYQ6wh9hBniDvEG+IP");
("CYaEQ6Ih8ZBkSDokG5IPf7FE/olMiEyKTIlMi8yIzIrMicyLLIgsiiyJLIusiKyKrImsi2yIbIpsiWyL7IjsiuyJ7IsciByK");
("HIkci5yInIqciZyLXIhcilyJXIvciNyK3IncizyIPIo8iTyLvIi8iryJvIt8iHyKfIl8i/yIFESKIiWRskhFpCpSE6mLNMS/");
("7UxTpCXSFumIdEV6In2RgYggMhQRRUYiYxFJRBZRRFQRTUQXMURMEUvEFnFEXBFPxBcJREKRSCQWSURSkUwkF3+xRvwbMTFi");
("csTUiOkRMyNmR8yNmB+xMGJxxNKI5RErI1ZHrI1YH7ExYnPE1ojtETsjdkfsjdgfcTDicMTRiOMRJyNOR5yNOB9xMeJyxNWI");
("6xE3I25H3I24H/Ew4nHE04jnES8jXke8jXgf8THic8TXiO8RPyMKI4ojSiPKIyojqiNqI+ojGqO/jV9zRGtEe0RnRHdEb0R/");
("xGCEMGI4QhwxGjEeIY2QRygj1BHaCH2EMcIcYY2wRzgj3BHeCH9EMCIcEY2IRyQj0hHZiHz0izXm35iJMZNjpsZMj5kZMztm");
("bsz8mIUxi2OWxiyPWRmzOmZtzPqYjTGbY7bGbI/ZGbM7Zm/M/piDMYdjjsYcjzkZczrmbMz5mIsxl2OuxlyPuRlzO+ZuzP2Y");
("hzGPY57GPI95GfM65m3M+5iPMZ9jvsZ8j/kZUxhTHFMaUx5TGVMdUxtTH9MY/22Rm2NaY9pjOmO6Y3pj+mMGY4QxwzHimNGY");
("8RhpjDxGGaOO0cboY4wx5hhrjD3GGeOO8cb4Y4Ix4ZhoTDwmGZOOycbk418siX8SExKTElMS0xIzErMScxLzEgsSixJLEssS");
("KxKrEmsS6xIbEpsSWxLbEjsSuxJ7EvsSBxKHEkcSxxInEqcSZxLnEhcSlxJXEtcSNxK3EncS9xIPEo8STxLPEi8SrxJvEu8S");
("HxKfEl8S3xI/EgWJokRJoixRkahK1CTqEg3pr5nQlGhJtCU6El2JnkRfYiAhSAwlRImRxFhCkpAlFAlVQpPQJQwJU8KSsCUc");
("CVfCk/AlAolQIpKIJRKJVCKTyKVfLJl/MhMykzJTMtMyMzKzMnMy8zILMosySzLLMisyqzJrMusyGzKbMlsy2zI7MrsyezL7");
("MgcyhzJHMscyJzKnMmcy5zIXMpcyVzLXMjcytzJ3MvcyDzKPMk8yzzIvMq8ybzLvMh8ynzJfMt8yPzIFmaJMSaYsU5GpytRk");
("6jIN+a/t0pRpybRlOjJdmZ5MX2YgI8gMZUSZkcxYRpKRZRQZVUaT0WUMGVPGkrFlHBlXxpPxZQKZUCaSiWUSmVQmk8nlXyyF");
("fwoTCpMKUwrTCjMKswpzCvMKCwqLCksKyworCqsKawrrChsKmwpbCtsKOwq7CnsK+woHCocKRwrHCicKpwpnCucKFwqXClcK");
("1wo3CrcKdwr3Cg8KjwpPCs8KLwqvCm8K7wofCp8KXwrfCj8KBYWiQkmhrFBRqCrUFOoKDeWvQdVUaCm0FToKXYWeQl9hoCAo");
("DBVEhZHCWEFSkBUUBVVBU9AVDAVTwVKwFRwFV8FT8BUChVAhUogVEoVUIVPIlV8slX8qEyqTKlMq0yozKrMqcyrzKgsqiypL");
("KssqKyqrKmsq6yobKpsqWyrbKjsquyp7KvsqByqHKkcqxyonKqcqZyrnKhcqlypXKtcqNyq3Kncq9yoPKo8qTyrPKi8qrypv");
("Ku8qHyqfKl8q3yo/KgWVokpJpaxSUamq1FTqKg31r5XXVGmptFU6Kl2VnkpfZaAiqAxVRJWRylhFUpFVFBVVRVPRVQwVU8VS");
("sVUcFVfFU/FVApVQJVKJVRKVVCVTydVfLI1/GhMakxpTGtMaMxqzGnMa8xoLGosaSxrLGisaqxprGusaGxqbGlsa2xo7Grsa");
("exr7GgcahxpHGscaJxqnGmca5xoXGpcaVxrXGjcatxp3GvcaDxqPGk8azxovGq8abxrvGh8anxpfGt8aPxoFjaJGSaOsUdGo");
("atQ06hoN7a/p2dRoabQ1OhpdjZ5GX2OgIWgMNUSNkcZYQ9KQNRQNVUPT0DUMDVPD0rA1HA1Xw9PwNQKNUCPSiDUSjVQj08i1");
("XyydfzoTOpM6UzrTOjM6szpzOvM6CzqLOks6yzorOqs6azrrOhs6mzpbOts6Ozq7Ons6+zoHOoc6RzrHOic6pzpnOuc6FzqX");
("Olc61zo3Orc6dzr3Og86jzpPOs86LzqvOm867zofOp86XzrfOj86BZ2iTkmnrFPRqerUdOo6Df2vPdzUaem0dTo6XZ2eTl9n");
("oCPoDHVEnZHOWEfSkXUUHVVH09F1DB1Tx9KxdRwdV8fT8XUCnVAn0ol1Ep1UJ9PJ9V8sg38GEwaTBlMG0wYzBrMGcwbzBgsG");
("iwZLBssGKwarBmsG6wYbBpsGWwbbBjsGuwZ7BvsGBwaHBkcGxwYnBqcGZwbnBhcGlwZXBtcGNwa3BncG9wYPBo8GTwbPBi8G");
("rwZvBu8GHwafBl8G3wY/BgWDokHJoGxQMaga1AzqBg3jr5HeNGgZtA06Bl2DnkHfYGAgGAwNRIORwdhAMpANFAPVQDPQDQwD");
("08AysA0cA9fAM/ANAoPQIDKIDRKD1CAzyI1fLJN/JhMmkyZTJtMmMyazJnMm8yYLJosmSybLJismqyZrJusmGyabJlsm2yY7");
("Jrsmeyb7JgcmhyZHJscmJyanJmcm5yYXJpcmVybXJjcmtyZ3JvcmDyaPJk8mzyYvJq8mbybvJh8mnyZfJt8mPyYFk6JJyaRs");
("UjGpmtRM6iYN82/k0DRpmbRNOiZdk55J32RgIpgMTUSTkcnYRDKRTRQT1UQz0U0ME9PEMrFNHBPXxDPxTQKT0CQyiU0Sk9Qk");
("M8nNXyyLfxYTFpMWUxbTFjMWsxZzFvMWCxaLFksWyxYrFqsWaxbrFhsWmxZbFtsWOxa7FnsW+xYHFocWRxbHFicWpxZnFucW");
("FxaXFlcW1xY3FrcWdxb3Fg8WjxZPFs8WLxavFm8W7xYfFp8WXxbfFj8WBYuiRcmibFGxqFrULOoWDetvONO0aFm0LToWXYue");
("Rd9iYCFYDC1Ei5HF2EKykC0UC9VCs9AtDAvTwrKwLRwL18Kz8C0Ci9AisogtEovUIrPIrV8sm382EzaTNlM20zYzNrM2czbz");
("Ngs2izZLNss2KzarNms26zYbNps2WzbbNjs2uzZ7Nvs2BzaHNkc2xzYnNqc2ZzbnNhc2lzZXNtc2Nza3Nnc29zYPNo82TzbP");
("Ni82rzZvNu82HzafNl823zY/NgWbok3JpmxTsana1GzqNg37b4zVtGnZtG06Nl2bnk3fZmAj2AxtRJuRzdhGspFtFBvVRrPR");
("bQwb08aysW0cG9fGs/FtApvQJrKJbRKb1Cazye1fLId/DhMOkw5TDtMOMw6zDnMO8w4LDosOSw7LDisOqw5rDusOGw6bDlsO");
("2w47DrsOew77DgcOhw5HDscOJw6nDmcO5w4XDpcOVw7XDjcOtw53DvcODw6PDk8Ozw4vDq8Obw7vDh8Onw5fDt8OPw4Fh6JD");
("yaHsUHGoOtQc6g4N52/g13RoObQdOg5dh55D32HgIDgMHUSHkcPYQXKQHRQH1UFz0B0MB9PBcrAdHAfXwXPwHQKH0CFyiB0S");
("h9Qhc8idXyyXfy4TLpMuUy7TLjMusy5zLvMuCy6LLksuyy4rLqsuay7rLhsumy5bLtsuOy67Lnsu+y4HLocuRy7HLicupy5n");
("LucuFy6XLlcu1y43Lrcudy73Lg8ujy5PLs8uLy6vLm8u7y4fLp8uXy7fLj8uBZeiS8ml7FJxqbrUXOouDfdvNNp0abm0XTou");
("XZeeS99l4CK4DF1El5HL2EVykV0UF9VFc9FdDBfTxXKxXRwX18Vz8V0Cl9AlcoldEpfUJXPJ3V8sj38eEx6THlMe0x4zHrMe");
("cx7zHgseix5LHsseKx6rHmse6x4bHpseWx7bHjseux57HvseBx6HHkcexx4nHqceZx7nHhcelx5XHtceNx63Hnce9x4PHo8e");
("Tx7PHi8erx5vHu8eHx6fHl8e3x4/HgWPokfJo+xR8ah61DzqHg3vb4jc9Gh5tD06Hl2PnkffY+AheAw9RI+Rx9hD8pA9FA/V");
("Q/PQPQwP08PysD0cD9fD8/A9Ao/QI/KIPRKP1CPzyL1fLJ9/PhM+kz5TPtM+Mz6zPnM+8z4LPos+Sz7LPis+qz5rPus+Gz6b");
("Pls+2z47Prs+ez77Pgc+hz5HPsc+Jz6nPmc+5z4XPpc+Vz7XPjc+tz53Pvc+Dz6PPk8+zz4vPq8+bz7vPh8+nz5fPt8+Pz4F");
("n6JPyafsU/Gp+tR86j4N/2/c3vRp+bR9Oj5dn55P32fgI/gMfUSfkc/YR/KRfRQf1Ufz0X0MH9PH8rF9HB/Xx/PxfQKf0Cfy");
("iX0Sn9Qn88n9X6yAfwETAZMBUwHTATMBswFzAfMBCwGLAUsBywErAasBawHrARsBmwFbAdsBOwG7AXsB+wEHAYcBRwHHAScB");
("pwFnAecBFwGXAVcB1wE3AbcBdwH3AQ8BjwFPAc8BLwGvAW8B7wEfAZ8BXwHfAT8BhYBiQCmgHFAJqAbUAuoBjeAvmNAMaAW0");
("AzoB3YBeQD9gECAEDAPEgFHAOEAKkAOUADVAC9ADjAAzwAqwA5wAN8AL8AOCgDAgCogDkoA0IAvIg1+skH8hEyGTIVMh0yEz");
("IbMhcyHzIQshiyFLIcshKyGrIWsh6yEbIZshWyHbITshuyF7IfshByGHIUchxyEnIachZyHnIRchlyFXIdchNyG3IXch9yEP");
("IY8hTyHPIS8hryFvIe8hHyGfIV8h3yE/IYWQYkgppBxSCamG1ELqIY3wL8LRDGmFtEM6Id2QXkg/ZBAihAxDxJBRyDhECpFD");
("lBA1RAvRQ4wQM8QKsUOcEDfEC/FDgpAwJAqJQ5KQNCQLycNfrIh/ERMRkxFTEdMRMxGzEXMR8xELEYsRSxHLESsRqxFrEesR");
("GxGbEVsR2xE7EbsRexH7EQcRhxFHEccRJxGnEWcR5xEXEZcRVxHXETcRtxF3EfcRDxGPEU8RzxEvEa8RbxHvER8RnxFfEd8R");
("PxGFiGJEKaIcUYmoRtQi6hGN6C/s0oxoRbQjOhHdiF5EP2IQIUQMI8SIUcQ4QoqQI5QINUKL0COMCDPCirAjnAg3wovwI4KI");
("MCKKiCOSiDQii8ijX6yYfzETMZMxUzHTMTMxszFzMfMxCzGLMUsxyzErMasxazHrMRsxmzFbMdsxOzG7MXsx+zEHMYcxRzHH");
("MScxpzFnMecxFzGXMVcx1zE3MbcxdzH3MQ8xjzFPMc8xLzGvMW8x7zEfMZ8xXzHfMT8xhZhiTCmmHFOJqcbUYuoxjfgvFtSM");
("acW0Yzox3ZheTD9mECPEDGPEmFHMOEaKkWOUGDVGi9FjjBgzxoqxY5wYN8aL8WOCmDAmioljkpg0JovJ41+shH8JEwmTCVMJ");
("0wkzCbMJcwnzCQsJiwlLCcsJKwmrCWsJ6wkbCZsJWwnbCTsJuwl7CfsJBwmHCUcJxwknCacJZwnnCRcJlwlXCdcJNwm3CXcJ");
("9wkPCY8JTwnPCS8JrwlvCe8JHwmfCV8J3wk/CYWEYkIpoZxQSagm1BLqCY3kL0DVTGgltBM6Cd2EXkI/YZAgJAwTxIRRwjhB");
("SpATlAQ1QUvQE4wEM8FKsBOcBDfBS/ATgoQwIUqIE5KENCFLyJNfrJR/KRMpkylTKdMpMymzKXMp8ykLKYspSynLKSspqylr");
("KespGymbKVsp2yk7Kbspeyn7KQcphylHKccpJymnKWcp5ykXKZcpVynXKTcptyl3KfcpDymPKU8pzykvKa8pbynvKR8pnylf");
("Kd8pPymFlGJKKaWcUkmpptRS6imN9C9q1kxppbRTOindlF5KP2WQIqQMU8SUUco4RUqRU5QUNUVL0VOMFDPFSrFTnBQ3xUvx");
("U4KUMCVKiVOSlDQlS8nTX6yMfxkTGZMZUxnTGTMZsxlzGfMZCxmLGUsZyxkrGasZaxnrGRsZmxlbGdsZOxm7GXsZ+xkHGYcZ");
("RxnHGScZpxlnGecZFxmXGVcZ1xk3GbcZdxn3GQ8ZjxlPGc8ZLxmvGW8Z7xkfGZ8ZXxnfGT8ZhYxiRimjnFHJqGbUMuoZjewv");
("lNfMaGW0MzoZ3YxeRj9jkCFkDDPEjFHGOEPKkDOUDDVDy9AzjAwzw8qwM5wMN8PL8DOCjDAjyogzkow0I8vIs1+snH85EzmT");
("OVM50zkzObM5cznzOQs5izlLOcs5KzmrOWs56zkbOZs5WznbOTs5uzl7Ofs5BzmHOUc5xzknOac5ZznnORc5lzlXOdc5Nzm3");
("OXc59zkPOY85TznPOS85rzlvOe85HzmfOV853zk/OYWcYk4pp5xTyanm1HLqOY38L77YzGnltHM6Od2cXk4/Z5Aj5AxzxJxR");
("zjhHypFzlBw1R8vRc4wcM8fKsXOcHDfHy/FzgpwwJ8qJc5KcNCfLyXP+AzoEwUAdAFWOAAAAAElFTkSuQmCC");

const POST_COUNT = 100;

/** Enough of the pokedex name list for the migrated suites. */
const POKE_NAMES = [
  "bulbasaur",
  "ivysaur",
  "vulpix",
  "venusaur",
  "charmander",
  "squirtle",
  "pikachu",
];
const POKE_TYPE_IDS: Record<string, number> = { normal: 1, fire: 2, water: 3, electric: 13 };

function pokeName(id: number): string {
  return POKE_NAMES[id - 1] ?? `pokemon-${id}`;
}
const DIGEST_NONCE = "7b1f3c9d0e5a4b2c8d6e1f0a3b5c7d9e";
const DIGEST_OPAQUE = "4a1c9e7b3d5f2a8c";

function user(id: number): Record<string, unknown> {
  return { id, name: `user ${id}`, username: `user${id}`, email: `u${id}@example.test` };
}

/**
 * Verbatim text from jsonplaceholder's first post.
 *
 * The body length is asserted exactly by the migrated response suite, so the
 * text has to be the real thing rather than a plausible placeholder. Verified
 * against upstream: `/posts/1` is 292 bytes of JSON with this title and body.
 */
const POST_1_TITLE = "sunt aut facere repellat provident occaecati excepturi optio reprehenderit";
const POST_1_BODY =
  "quia et suscipit\nsuscipit recusandae consequuntur expedita et cum\nreprehenderit molestiae ut ut quas totam\nnostrum rerum est autem sunt rem eveniet architecto";

function post(id: number): Record<string, unknown> {
  if (id === 1) {
    return { userId: 1, id: 1, title: POST_1_TITLE, body: POST_1_BODY };
  }
  return {
    // The first ten posts all belong to user 1; ids past that cycle. Verified
    // against jsonplaceholder: /posts/1 is `{ id: 1, userId: 1 }`.
    userId: id <= 10 ? 1 : ((id - 1) % 10) + 1,
    id,
    title: `post number ${id}`,
    body: `Body of post ${id}.`,
  };
}

function contentTypeOf(req: IncomingMessage): string {
  const raw = req.headers["content-type"] ?? "";
  return Array.isArray(raw) ? (raw[0] ?? "") : String(raw);
}

function isFormBody(req: IncomingMessage): boolean {
  const ct = contentTypeOf(req).toLowerCase();
  return ct.startsWith("application/x-www-form-urlencoded") || ct.startsWith("multipart/form-data");
}

/**
 * Field names and values from a urlencoded or multipart body.
 *
 * Verified against upstream: httpbin puts both into `form`, and leaves `data`
 * empty. Only the leading part before the boundary matters here — the suites
 * that use this assert on plain text fields, never on uploaded files.
 */
function formFields(body: Buffer, contentType = ""): Record<string, string> {
  const out: Record<string, string> = {};
  if (contentType.toLowerCase().startsWith("multipart/form-data")) {
    const boundary = /boundary=("?)([^";]+)\1/.exec(contentType)?.[2];
    if (!boundary) return out;
    for (const part of body.toString("binary").split(`--${boundary}`)) {
      const m = /name="([^"]*)"[\s\S]*?\r\n\r\n([\s\S]*?)\r\n$/.exec(part);
      if (m) out[m[1] ?? ""] = (m[2] ?? "").replace(/\r\n$/, "");
    }
    return out;
  }
  for (const [k, v] of new URLSearchParams(body.toString("utf8"))) out[k] = v;
  return out;
}

function requestSummary(
  req: IncomingMessage,
  body: Buffer,
  origin: string,
): Record<string, unknown> {
  return {
    // httpbin collapses a repeated query parameter into an array. Verified
    // against upstream: `?ids=1&ids=2&ids=3` echoes `{"ids": ["1","2","3"]}`.
    // `Object.fromEntries` on searchParams keeps only the last occurrence, so
    // anything asserting that every value survived the round trip read a
    // truncated array.
    args: queryArgs(req),
    // httpbin echoes header names with the casing the client sent. Node
    // lower-cases everything in `req.headers`, so the original casing has to
    // come from `req.rawHeaders` — otherwise `X-Test` comes back as `x-test`
    // and a test that looks the header up by its sent name finds nothing.
    headers: Object.fromEntries(rawHeaderEntries(req)),
    origin: req.socket.remoteAddress ?? "127.0.0.1",
    url: echoedUrl(req, origin),
    method: req.method ?? "GET",
    data: body.length === 0 || isFormBody(req) ? "" : body.toString("utf8"),
    files: {},
    // httpbin parses an `application/x-www-form-urlencoded` body into `form`
    // and leaves `data` empty; a JSON body goes to `json` and `data`. Verified
    // against upstream, which returns `{"form": {"a": "1"}, "data": ""}` for
    // `a=1`. Returning an empty object made every form-body assertion read `{}`.
    // Upstream leaves `data` empty for a form body; the fields are in `form`.
    form: isFormBody(req) ? formFields(body, contentTypeOf(req)) : {},
    json: isFormBody(req) ? null : safeJson(body),
  };
}

function safeJson(body: Buffer): unknown {
  if (body.length === 0) return null;
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function handle(req: IncomingMessage, res: ServerResponse): void {
  void route(req, res).catch((err: unknown) => {
    if (!res.headersSent) json(res, 500, { error: String(err) });
    else res.end();
  });
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = (req.method ?? "GET").toUpperCase();
  const body = await readBody(req);

  // Echo: /get, /post, /put, /patch, /delete, /anything, /anything/*
  if (
    path === "/get" ||
    path === "/post" ||
    path === "/put" ||
    path === "/patch" ||
    path === "/delete" ||
    path.startsWith("/anything")
  ) {
    json(res, 200, requestSummary(req, body, originOf(req)));
    return;
  }

  if (path === "/headers") {
    json(res, 200, { headers: requestSummary(req, body, originOf(req)).headers });
    return;
  }

  if (path === "/uuid") {
    // httpbin returns `{"uuid": "..."}` — an object, not a bare string.
    json(res, 200, { uuid: randomUUID() });
    return;
  }

  if (path === "/ip") {
    json(res, 200, { origin: req.socket.remoteAddress ?? "127.0.0.1" });
    return;
  }

  if (path === "/json") {
    json(res, 200, {
      slideshow: {
        title: "Sample Slide Show",
        author: "Yours Truly",
        date: "date of publication",
        slides: [
          { title: "Wake up to WonderWidgets!", type: "all" },
          {
            title: "Overview",
            type: "all",
            items: ["Why <em>WonderWidgets</em> are great", "Who <em>buys</em> WonderWidgets"],
          },
        ],
      },
    });
    return;
  }

  if (path === "/user-agent") {
    // Upstream answers JSON with a `user-agent` key that is `null` when the
    // request carries none; it does not echo the raw string as `text/html`.
    json(res, 200, { "user-agent": req.headers["user-agent"] ?? null });
    return;
  }

  let m: RegExpMatchArray | null;

  if ((m = path.match(/^\/status\/(\d{3})$/))) {
    const code = Number(m[1]);
    res.writeHead(code, { "content-type": "text/html" });
    res.end(code >= 400 ? `<html><body><h1>${code}</h1></body></html>` : "");
    return;
  }

  if ((m = path.match(/^\/delay\/([\d.]+)$/))) {
    // Seconds, as httpbin defines it — /delay/1 waits one second, not one
    // millisecond. Capped at 2 s so the suite's /delay/10 proves concurrency
    // rather than spending ten seconds doing it.
    await delay(Math.min(Number.parseFloat(m[1] ?? "0") * 1000, DELAY_CAP_MS));
    json(res, 200, requestSummary(req, body, originOf(req)));
    return;
  }

  if ((m = path.match(/^\/bytes\/(\d+)$/))) {
    const n = Math.min(Number(m[1]), 1024 * 1024);
    const buf = Buffer.alloc(n, "a");
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": n });
    res.end(buf);
    return;
  }

  if ((m = path.match(/^\/stream\/(\d+)$/))) {
    // NDJSON: one object per line, `id` counting from 0, newline-terminated.
    // Verified against upstream, which streams `n` lines rather than returning a
    // single body — so a test that walks the stream needs all n objects.
    const n = Number(m[1]);
    const lines: string[] = [];
    for (let i = 0; i < n; i++) {
      lines.push(JSON.stringify({ ...requestSummary(req, body, originOf(req)), id: i }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(lines.join("\n") + "\n");
    return;
  }

  if ((m = path.match(/^\/base64\/([^/]+)$/))) {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(Buffer.from(m[1] ?? "", "base64").toString("utf8"));
    return;
  }

  if ((m = path.match(/^\/redirect\/(\d+)$/))) {
    const count = Number(m[1]);
    const to = count > 1 ? `/redirect/${count - 1}` : "/get";
    res.writeHead(302, { location: to });
    res.end();
    return;
  }

  if ((m = path.match(/^\/redirect-to\?url=(.+)$/))) {
    res.writeHead(302, { location: decodeURIComponent(m[1] ?? "/get") });
    res.end();
    return;
  }

  if (path === "/redirect-to" && url.searchParams.get("url")) {
    res.writeHead(302, { location: url.searchParams.get("url") as string });
    res.end();
    return;
  }

  if (path === "/response-headers") {
    // Verified against upstream: the query parameters become the JSON body *and*
    // a response header of the same name. (An earlier version of this comment
    // claimed the headers came from the request instead — they do not. The
    // cookie suite depends on `?Set-Cookie=...` coming back as a response
    // header, which is the whole point of the endpoint.)
    const body: Record<string, string | string[]> = {};
    for (const [k, v] of url.searchParams) {
      const seen = body[k];
      if (seen === undefined) body[k] = v;
      else if (Array.isArray(seen)) seen.push(v);
      else body[k] = [seen, v];
    }
    res.writeHead(200, { "content-type": "application/json", ...(body as Record<string, string>) });
    res.end(JSON.stringify(body));
    return;
  }

  if (path === "/cookies") {
    json(res, 200, {
      cookies: { ...parseCookies(req.headers.cookie), ...Object.fromEntries(jar) },
    });
    return;
  }

  if ((m = path.match(/^\/cookies\/set\/([^/]+)\/([^/]+)$/))) {
    jar.set(decodeURIComponent(m[1] ?? ""), decodeURIComponent(m[2] ?? ""));
    res.writeHead(302, {
      location: "/cookies",
      "set-cookie": `${decodeURIComponent(m[1] ?? "")}=${decodeURIComponent(m[2] ?? "")}; Path=/`,
    });
    res.end();
    return;
  }

  if (path === "/cookies/set") {
    // Verified against upstream: this answers 302 with one `Set-Cookie` per
    // query parameter (and redirects to /cookies). Serving 200 with a JSON body
    // gave the client nothing to store, so every "the jar round-trips a cookie"
    // assertion saw an absent Cookie header rather than a failure it could read.
    const setCookies: string[] = [];
    for (const [k, v] of url.searchParams) {
      jar.set(k, v);
      setCookies.push(`${k}=${encodeURIComponent(v)}; Path=/`);
    }
    res.writeHead(302, { location: "/cookies", "set-cookie": setCookies });
    res.end();
    return;
  }

  // The final path segment is the password, verified against upstream:
  // /basic-auth/user/pass accepts "user:pass" and /basic-auth/user/passwd
  // accepts "user:passwd". Checking both against "passwd" meant the former
  // always answered 401 and the body was empty.
  if (path === "/basic-auth/user/passwd" || path === "/basic-auth/user/pass") {
    const header = req.headers.authorization ?? "";
    const password = path.endsWith("/passwd") ? "passwd" : "pass";
    const expected = `Basic ${Buffer.from(`user:${password}`).toString("base64")}`;
    if (header !== expected) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="Fake Realm"' });
      res.end();
      return;
    }
    json(res, 200, { authenticated: true, user: "user" });
    return;
  }

  if (path === "/links") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body><a href='1'>1</a><a href='2'>2</a><a href='3'>3</a></body></html>");
    return;
  }

  // Two pages, joined by a Link header with `rel="next"`, so a Link-header
  // paginator has something real to follow. Verified shape: RFC 5988, angle
  // brackets around the target and a quoted rel.
  // A minimal GraphQL endpoint: enough to answer the queries the migrated
  // suites send. Verified against countries.trevorblades.com, whose `/graphql`
  // answers `{ "data": { ... } }` with no top-level `errors` key.
  // `/digest-auth/auth/:user/:passwd`. Verified against httpbin: an
  // unauthenticated request gets 401 and a `WWW-Authenticate: Digest` challenge
  // carrying realm, nonce, qop and opaque; only a correct response gets 200.
  //
  // The expected response is computed here, from the formula in RFC 2617 §3.2.2,
  // with `node:crypto` directly. It previously called the library's own
  // `computeDigestResponse`, which meant server and client moved together: a
  // changed digest formula passed the test precisely because both sides had
  // changed. A second implementation cannot drift in lockstep, and the library
  // is separately pinned to the RFC's published test vector in
  // `tests/digest.test.mts`.
  if ((m = path.match(/^\/digest-auth\/auth\/([^/]+)\/([^/]+)$/))) {
    const challenge = `Digest realm="me@kennethreitz.com", nonce="${DIGEST_NONCE}", qop="auth", opaque="${DIGEST_OPAQUE}"`;
    const auth = req.headers.authorization ?? "";
    if (!/^Digest /.test(auth)) {
      res.writeHead(401, { "www-authenticate": challenge });
      res.end();
      return;
    }
    const fields = Object.fromEntries(
      [...auth.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,]*))/g)].map((mm) => [
        mm[1] ?? "",
        mm[2] ?? mm[3] ?? "",
      ]),
    );
    if (fields["username"] !== m[1] || fields["nonce"] !== DIGEST_NONCE) {
      res.writeHead(401, { "www-authenticate": challenge });
      res.end();
      return;
    }
    const expected = rfc2617DigestResponse(
      {
        realm: "me@kennethreitz.com",
        nonce: DIGEST_NONCE,
        qop: "auth",
        opaque: DIGEST_OPAQUE,
      },
      m[1] ?? "",
      m[2] ?? "",
      method,
      fields["uri"] ?? "",
      fields["cnonce"],
      fields["nc"],
    );
    if (fields["response"] !== expected) {
      res.writeHead(401, { "www-authenticate": challenge });
      res.end();
      return;
    }
    json(res, 200, { authenticated: true, user: m[1] });
    return;
  }

  // An Alt-Svc advertisement, so the client's HTTP-version inference can be
  // exercised without a real HTTP/2 origin. The default paths deliberately send
  // no Alt-Svc, which is the other half of the same test.
  if (path === "/alt-svc-h2") {
    json(res, 200, { name: "bulbasaur", id: 1 }, { "alt-svc": 'h2=":443"; ma=2592000' });
    return;
  }

  if (path === "/graphql") {
    // Enough of the countries schema for `client.graphql()` to be exercised for
    // real: the stub returned `{query: "ok"}` for anything but a literal
    // `countries` field, so every `country(code:)` query came back with no data.
    const query = String((safeJson(body) as Record<string, unknown> | undefined)?.["query"] ?? "");
    let data: Record<string, unknown> = {};
    if (/\bcountry\s*\(/.test(query)) {
      const code = query.match(/code\s*:\s*"([A-Z]+)"/)?.[1] ?? "US";
      data = {
        country: {
          code,
          name: GRAPHQL_COUNTRIES[code]?.name ?? GRAPHQL_COUNTRIES["US"]!.name,
          capital: GRAPHQL_COUNTRIES[code]?.capital ?? GRAPHQL_COUNTRIES["US"]!.capital,
          currency: GRAPHQL_COUNTRIES[code]?.currency ?? GRAPHQL_COUNTRIES["US"]!.currency,
          native: GRAPHQL_COUNTRIES[code]?.native ?? GRAPHQL_COUNTRIES["US"]!.native,
          phone: GRAPHQL_COUNTRIES[code]?.phone ?? GRAPHQL_COUNTRIES["US"]!.phone,
        },
      };
    } else if (/\bcountries\b/.test(query)) {
      data = { countries: Object.values(GRAPHQL_COUNTRIES) };
    } else if (/\bquery\s*\{/.test(query)) data = { query: "ok" };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data }));
    return;
  }

  if (path === "/paged") {
    const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
    const items = Array.from({ length: 2 }, (_, i) => ({
      id: (page - 1) * 2 + i + 1,
      title: `issue ${(page - 1) * 2 + i + 1}`,
    }));
    if (page < 2) {
      const next = `${HTTPBIN_LOCAL_ORIGIN}/paged?page=2`;
      res.writeHead(200, {
        "content-type": "application/json",
        link: `<${next}>; rel="next"`,
      });
    } else {
      res.writeHead(200, { "content-type": "application/json" });
    }
    res.end(JSON.stringify(items));
    return;
  }

  // Raw bytes of a given length, for download-progress assertions. Verified
  // against httpbin: `application/octet-stream` with exactly N bytes.
  if ((m = path.match(/^\/stream-bytes\/(\d+)$/))) {
    const n = Number(m[1]);
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(n),
    });
    res.end(Buffer.alloc(n, 0x61));
    return;
  }

  // A minimal pokeapi stand-in. Verified against upstream: `/pokemon/1` is
  // bulbasaur (id 1), `/pokemon/pikachu` is id 25, and `/type/fire` is a type
  // object with an id and a name.
  if ((m = path.match(/^\/pokemon\/([^/]+)$/))) {
    const key = m[1] ?? "";
    const byName: Record<string, { id: number; name: string }> = {
      pikachu: { id: 25, name: "pikachu" },
      bulbasaur: { id: 1, name: "bulbasaur" },
      ivysaur: { id: 2, name: "ivysaur" },
    };
    const hit = /^\d+$/.test(key)
      ? { id: Number(key), name: pokeName(Number(key)) }
      : byName[key.toLowerCase()];
    if (!hit) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "Not found." }));
      return;
    }
    json(res, 200, { ...hit, base_experience: 64, height: 7, weight: 69 });
    return;
  }

  if ((m = path.match(/^\/type\/([^/]+)$/))) {
    const key = (m[1] ?? "").toLowerCase();
    if (!key) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ detail: "Not found." }));
      return;
    }
    json(res, 200, { id: POKE_TYPE_IDS[key] ?? 1, name: key });
    return;
  }

  // `/todos/:id` — jsonplaceholder's second collection, used by a per-origin
  // circuit-breaker isolation test that needs a second origin answering 200.
  if ((m = path.match(/^\/todos\/(\d+)$/))) {
    json(res, 200, { userId: 1, id: Number(m[1]), title: `todo ${m[1]}`, completed: false });
    return;
  }

  if (path === "/cache") {
    json(res, 200, { origin: req.socket.remoteAddress ?? "127.0.0.1" });
    return;
  }

  if ((m = path.match(/^\/cache\/(\d+)$/))) {
    res.writeHead(Number(m[1]), { "content-type": "application/json" });
    res.end("{}");
    return;
  }

  if (path === "/gzip" || path === "/deflate" || path === "/brotli") {
    // The compressed endpoints answer with a *different* shape from /get:
    // verified against upstream, `/gzip` returns keys `gzipped`, `headers`,
    // `method`, `origin`. Echoing the full request summary instead made every
    // `r.data.gzipped === true` assertion read `undefined`.
    const summary = requestSummary(req, body, originOf(req));
    const encoding = path.slice(1);
    const FLAG: Record<string, string> = { gzip: "gzipped", deflate: "deflated", brotli: "brotli" };
    const payload = JSON.stringify({
      [FLAG[encoding] ?? encoding]: true,
      headers: summary.headers,
      method: summary.method,
      origin: summary.origin,
    });
    const buf =
      encoding === "gzip"
        ? gzipSync(payload)
        : encoding === "deflate"
          ? deflateSync(payload)
          : brotliCompressSync(payload);
    // The registered content-coding token, verified against upstream: brotli is
    // announced as `br`, which is why only that endpoint failed to decompress —
    // `gzip` and `deflate` coincidentally match their path names.
    const TOKEN: Record<string, string> = { gzip: "gzip", deflate: "deflate", brotli: "br" };
    res.writeHead(200, {
      "content-type": "application/json",
      "content-encoding": TOKEN[encoding] ?? encoding,
    });
    res.end(buf);
    return;
  }

  // A tiny jsonplaceholder stand-in. Its shape is pinned by what the migrated
  // suites assert: a list of 100 posts with `userId`, `id`, `title`, `body`,
  // and `/posts/:id` returning one of them. Verified against upstream for the
  // field names and the count; the text itself is synthetic.
  if (path.match(/^\/users\/\d+\/posts$/)) {
    const uid = Number(/^\/users\/(\d+)\/posts$/.exec(path)?.[1]);
    json(
      res,
      200,
      Array.from({ length: 10 }, (_, i) => post(uid * 10 + i)).map((p) => ({ ...p, userId: uid })),
    );
    return;
  }

  if (path === "/users" || path.match(/^\/users\/\d+$/)) {
    const one = path.match(/^\/users\/(\d+)$/);
    json(res, 200, one ? user(Number(one[1])) : Array.from({ length: 10 }, (_, i) => user(i + 1)));
    return;
  }

  if (path === "/comments" || path.match(/^\/posts\/\d+\/comments$/)) {
    json(
      res,
      200,
      Array.from({ length: 5 }, (_, i) => ({ id: i + 1, postId: 1, body: `comment ${i + 1}` })),
    );
    return;
  }

  if (path === "/posts" || path.match(/^\/posts\/\d+$/)) {
    const one = path.match(/^\/posts\/(\d+)$/);
    // jsonplaceholder's REST semantics, verified against upstream: POST
    // /posts answers 201 with the submitted body echoed and a fresh id; PUT and
    // PATCH answer 200 with the replacement merged over the existing post.
    if (method === "POST" && path === "/posts") {
      json(res, 201, { ...(safeJson(body) as Record<string, unknown>), id: POST_COUNT + 1 });
      return;
    }
    if (method === "PUT" || method === "PATCH") {
      json(res, 200, {
        ...post(Number(one?.[1] ?? 1)),
        ...(safeJson(body) as Record<string, unknown>),
      });
      return;
    }
    // jsonplaceholder honours `_page` / `_limit` for its non-default
    // pagination parameter names. Without this a paginate() walk that names them
    // receives all 100 posts on the first page and stops after one.
    if (!one) {
      const q = new URL(req.url ?? "/", "http://x").searchParams;
      // Both paginator conventions: `_page`/`_limit` for Link-header paging,
      // `_start`/`_limit` for jsonplaceholder's offset paging.
      const limit = Math.max(1, Number(q.get("_limit") ?? String(POST_COUNT)));
      const page = Math.max(1, Number(q.get("_page") ?? q.get("page") ?? "1"));
      const start = q.has("_start") ? Number(q.get("_start")) : (page - 1) * limit;
      const all = Array.from({ length: POST_COUNT }, (_, i) => post(i + 1));
      json(res, 200, all.slice(start, start + limit));
      return;
    }
    // Pretty-printed to match jsonplaceholder, whose body a length assertion pins.
    jsonPretty(res, 200, post(Number(one[1])));
    return;
  }

  // `/status/:code` answers with that status and an empty HTML body. Verified
  // against upstream: 503 comes back as `text/html` with no JSON, which matters
  // because callers branch on whether the error body parses.
  if ((m = path.match(/^\/status\/(\d+)$/))) {
    const code = Number(m[1]);
    res.writeHead(code >= 100 && code < 600 ? code : 400, {
      "content-type": "text/html; charset=utf-8",
    });
    res.end();
    return;
  }

  if (path === "/encoding/utf8") {
    // A UTF-8 text payload. Verified against upstream, which answers
    // `text/html; charset=utf-8` with a body of several thousand bytes.
    // The two strings the migrated suites assert on are reproduced verbatim,
    // verified against upstream: the "UTF-8 encoded sample plain-text file"
    // banner, and the Markus Kuhn attribution line with its multi-byte chars.
    const demo =
      "<h1>Unicode Demo</h1>\n\n" +
      "<p>UTF-8 encoded sample plain-text file</p>\n" +
      "<p>Markus Kuhn [ˈmaʳkʊs kuːn]</p>\n" +
      "<p>keinerverse \u00e9\u00e8\u00ea \u4f60\u597d \u{1f680}</p>\n";
    const text = demo.repeat(100);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(text);
    return;
  }

  if (path === "/image") {
    // A real PNG. Verified against upstream: `/image` answers `image/png`, not
    // `application/json` as an unauthenticated error page would, and the body is
    // over a kilobyte. Serving anything else made the content-type and body-size
    // assertions fail for a reason that had nothing to do with the client.
    const png = Buffer.from(IMAGE_PNG_BASE64, "base64");
    res.writeHead(200, { "content-type": "image/png" });
    res.end(png);
    return;
  }

  if (path === "/xml") {
    res.writeHead(200, { "content-type": "application/xml" });
    res.end('<?xml version="1.0" encoding="UTF-8"?><slideshow><title>Sample</title></slideshow>');
    return;
  }

  if (path === "/html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!DOCTYPE html><html><body><h1>Herman Melville - Moby-Dick</h1></body></html>");
    return;
  }

  if (path === "/robots.txt") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("User-agent: *\nDisallow: /deny\n");
    return;
  }

  // ETag-ish determinism helper used by cache tests.
  if (path === "/etag") {
    const etag = `"${createHash("md5")
      .update(req.url ?? "/")
      .digest("hex")}"`;
    res.writeHead(200, { etag, "content-type": "application/json" });
    res.end("{}");
    return;
  }

  json(res, 404, { error: "not found", path });
}

/** True when the local server can answer, without starting one. */
export function isLocalHttpbinRunning(): boolean {
  return server !== undefined;
}

/**
 * Start the server if it is not already up and return its origin.
 *
 * Idempotent and concurrent-safe: the promise is cached, so every suite can
 * `await` it without coordinating or racing to bind twice.
 */
export function httpbinBaseUrl(): Promise<string> {
  if (starting !== undefined) return starting;
  starting = new Promise<string>((resolve, reject) => {
    server = createServer(handle);
    // Never hold the process open on the server's account.
    server.unref();
    server.once("error", reject);
    server.listen(HTTPBIN_LOCAL_PORT, "127.0.0.1", () => {
      origin = HTTPBIN_LOCAL_ORIGIN;
      resolve(origin);
    });
  });
  return starting;
}

// Started on import so a suite only has to `import "./httpbin-local.ts"` and
// then refer to `HTTPBIN_LOCAL_ORIGIN`.
void httpbinBaseUrl();
void httpbinTlsBaseUrl();

/**
 * Start the TLS/HTTP2 origin. Idempotent, like {@link httpbinBaseUrl}.
 *
 * `allowHTTP1` makes Node bridge HTTP/2 streams onto the same `request` event,
 * so one `route` handler serves both protocols rather than a second, quietly
 * diverging h2-only fixture.
 */
export function httpbinTlsBaseUrl(): Promise<string> {
  if (tlsStarting !== undefined) return tlsStarting;
  tlsStarting = new Promise<string>((resolve, reject) => {
    tlsServer = createSecureServer({
      key: LOCAL_TLS_KEY,
      cert: LOCAL_TLS_CA,
      allowHTTP1: true,
      // Advertise h2 first, then http/1.1, so a client asking for either gets
      // what it asked for and a client asking for nothing still works.
      ALPNProtocols: ["h2", "http/1.1"],
    });
    // HTTP/1.1 over TLS arrives through Node's compat layer, whose request and
    // response objects are the http2 variants rather than IncomingMessage /
    // ServerResponse; they implement the same surface `route` uses.
    // `allowHTTP1` makes Node bridge HTTP/2 streams to the same `request`
    // event, so one handler serves both protocols. Adding a `stream` handler as
    // well made every response send its trailers twice and the server threw
    // ERR_HTTP2_TRAILERS_ALREADY_SENT.
    tlsServer.on(
      "request",
      (req: Http2ServerRequest, res: Http2ServerResponse) =>
        void route(req as unknown as IncomingMessage, res as unknown as ServerResponse).catch(
          () => {
            if (!res.headersSent) res.writeHead(500);
            res.end();
          },
        ),
    );
    tlsServer.unref();
    tlsServer.once("error", reject);
    tlsServer.listen(HTTPBIN_LOCAL_TLS_PORT, "127.0.0.1", () => {
      resolve(HTTPBIN_LOCAL_TLS_ORIGIN);
    });
  });
  return tlsStarting;
}

/** Stop the server. Only useful in a test that asserts on shutdown. */
export function stopLocalHttpbin(): void {
  tlsServer?.close();
  tlsServer = undefined;
  tlsStarting = undefined;
  server?.close();
  server = undefined;
  origin = "";
  starting = undefined;
}
