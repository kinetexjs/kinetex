import process from "node:process";
import assert from "node:assert/strict";
import { isUpstreamFlake } from "./upstream.ts";
import type { ResponseParseOptions, SizeLimitConfig } from "../src/response.ts";
import {
  normalizeHeaders,
  normalizeResponse,
  parseContentType,
  isJSON,
  isText,
  isBinary,
  decodeBody,
  readJSON,
  readText,
  readBytes,
  readBlob,
  readStream,
  readNDJSON,
  readJSONStream,
  assertOk as responseAssertOk,
  assertOkJSON,
  diffResponses,
  HTTPResponseError,
  ResponseSizeLimitError,
  ContentTypeError,
  ResponseDecodeError,
  extractServerTiming,
  parseMultipartResponse,
  readFormData,
  createLimitedReader,
  readBodyWithLimit,
  ResponseCache,
} from "../src/response.ts";

let passed = 0,
  failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  \u2705  ${name}`);
    passed++;
  } catch (err) {
    // An outage at httpbin arrives as a failure that says nothing about the
    // client. The discrimination is narrow and never excuses an
    // AssertionError, so it cannot mask a real defect; see
    // tests/upstream-drift.test.mts, which also enforces that this suite has
    // the guard in the first place.
    if (isUpstreamFlake(err)) {
      const why = err instanceof Error ? err.message : String(err);
      console.log(`  ⚠️  ${name} — inconclusive (third party misbehaved): ${why}`);
      return;
    }
    const m = err instanceof Error ? err.message : String(err);
    console.log(`  \u274c  ${name}: ${m}`);
    failures.push({ name, err });
    failed++;
  }
}
function testSync(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  \u2705  ${name}`);
    passed++;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.log(`  \u274c  ${name}: ${m}`);
    failures.push({ name, err });
    failed++;
  }
}
function suite(name: string): void {
  console.log(`\n-- ${name}`);
}
function eq<T>(a: T, b: T, note?: string) {
  const suffix = note ? ` (${note})` : "";
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    // Structural, not textual. `JSON.stringify` compared key ORDER, so the
    // same content inserted in a different order failed; it could not tell an
    // absent key from one holding `undefined` (both write as `null`/nothing);
    // and it folded `NaN`, `Infinity` and `-0` into `null`/`0`, so a NaN rate
    // or an eta of -0 would have compared equal to anything.
    const oa = a as Record<string, unknown>;
    const ob = b as Record<string, unknown>;
    const keysA = Object.keys(oa).sort();
    const keysB = Object.keys(ob).sort();
    if (keysA.length !== keysB.length || keysA.some((k, i) => k !== keysB[i])) {
      throw new Error(
        `Expected keys ${JSON.stringify(keysB)} got ${JSON.stringify(keysA)}${suffix}`,
      );
    }
    for (const k of keysB) {
      const av = oa[k];
      const bv = ob[k];
      if (!Object.is(av, bv) && JSON.stringify(av) !== JSON.stringify(bv)) {
        throw new Error(
          `Expected ${JSON.stringify(bv)} got ${JSON.stringify(av)} for key "${k}"${suffix}`,
        );
      }
    }
    return;
  }
  // `Object.is` at the leaves, so NaN, -0 and +0 are told apart where it
  // matters — a `percent` of `-0` and one of `0` both print as "0" but are
  // not the same value, and a `duration` of NaN must not equal a number.
  if (!Object.is(a, b)) {
    throw new Error(`Expected ${String(b)} got ${String(a)}${suffix}`);
  }
}
function ok(v: unknown) {
  if (!v) throw new Error(`Expected truthy`);
}
function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const { kinetex } = await import("../src/mod.ts");
  const ktx = kinetex({});

  suite("parseContentType");
  testSync("basic", () => {
    const r = parseContentType("application/json");
    eq(r?.mediaType, "application/json", "the full media type");
    eq(r?.type, "application", "the top-level type");
  });
  testSync("charset+boundary", () => {
    const r = parseContentType("multipart/form-data; boundary=abc; charset=utf-8");
    eq(r?.boundary, "abc", "the boundary parameter");
    eq(r?.charset, "utf-8", "the charset parameter");
  });
  testSync("null for empty", () => eq(parseContentType(""), null));
  testSync("null for no slash", () => eq(parseContentType("justtext"), null));
  testSync("null for empty type", () => eq(parseContentType("/json"), null));
  testSync("null for empty subtype", () => eq(parseContentType("text/"), null));
  testSync("null for DoS long header", () => eq(parseContentType("a".repeat(9000)), null));
  testSync("null invalid type chars", () => eq(parseContentType("text<plain/foo"), null));
  testSync("null invalid subtype chars", () => eq(parseContentType("text/plain<xml"), null));
  testSync("trailing semicolon", () => {
    const r = parseContentType("text/html;");
    eq(r?.mediaType, "text/html");
  });

  suite("isJSON / isText / isBinary");
  testSync("isJSON true", () => {
    assert.equal(isJSON("application/json"), true);
    assert.equal(isJSON("application/vnd.api+json"), true);
  });
  testSync("isJSON false", () => {
    eq(isJSON("text/plain"), false);
    eq(isJSON(null), false);
  });
  testSync("isText true", () => {
    assert.equal(isText("text/plain"), true);
    assert.equal(isText("text/html"), true);
  });
  testSync("isText false", () => {
    eq(isText("application/json"), false);
    eq(isText("image/png"), false);
  });
  testSync("isBinary true", () => {
    assert.equal(isBinary("application/octet-stream"), true);
    assert.equal(isBinary("image/png"), true);
  });
  testSync("isBinary false", () => eq(isBinary("text/plain"), false));

  suite("decodeBody");
  testSync("UTF-8", () => eq(decodeBody(new TextEncoder().encode("hi"), null, ""), "hi"));
  testSync("empty", () => eq(decodeBody(new Uint8Array(0), null, ""), ""));
  testSync("UTF-8 BOM stripped", () =>
    eq(decodeBody(new Uint8Array([0xef, 0xbb, 0xbf, 104, 105]), null, ""), "hi"),
  );
  testSync("UTF-16LE BOM", () =>
    eq(decodeBody(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]), null, ""), "hi"),
  );
  testSync("UTF-16BE BOM", () =>
    eq(decodeBody(new Uint8Array([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]), null, ""), "hi"),
  );

  suite("HTTPResponseError");
  testSync("404", () => {
    const e = new HTTPResponseError(404, "", "", {}, null);
    assert.equal(e.isNotFound, true);
    assert.equal(e.isClientError, true);
    // Every sibling must be false. A getter that returned `true`
    // unconditionally would satisfy each of the one-line tests below, which
    // each asserted a single status and a single flag.
    assert.equal(e.isServerError, false, "404 is not a server error");
    assert.equal(e.isUnauthorized, false);
    assert.equal(e.isForbidden, false);
    assert.equal(e.isTooManyRequests, false);
    assert.equal(e.isGone, false);
    assert.equal(e.isConflict, false);
  });
  testSync("the error carries its context", () => {
    const e = new HTTPResponseError(
      503,
      "Service Unavailable",
      "https://x.test/a",
      { "content-type": "text/html" },
      "down",
    );
    eq(e.status, 503, "status");
    eq(e.statusText, "Service Unavailable", "statusText");
    eq(e.url, "https://x.test/a", "url");
    eq(e.headers, { "content-type": "text/html" }, "headers");
    eq(e.body, "down", "body");
    eq(e.code, "EHTTPRESPONSE", "code");
    eq(e.name, "HTTPResponseError", "name");
    assert.ok(e instanceof Error, "and it is a real Error");
  });
  testSync("server errors are bounded above", () => {
    // `isClientError` bounds itself at both ends; `isServerError` had no upper
    // bound, so any status at or past 600 reported itself as a server error.
    assert.equal(new HTTPResponseError(500, "", "", {}, null).isServerError, true, "500 is");
    assert.equal(new HTTPResponseError(599, "", "", {}, null).isServerError, true, "599 is");
    for (const s of [600, 700, 999]) {
      assert.equal(
        new HTTPResponseError(s, "", "", {}, null).isServerError,
        false,
        `${s} is not a 5xx`,
      );
      assert.equal(
        new HTTPResponseError(s, "", "", {}, null).isClientError,
        false,
        `${s} is not a 4xx either`,
      );
    }
    // The 4xx/5xx boundary itself, in both directions.
    assert.equal(new HTTPResponseError(499, "", "", {}, null).isClientError, true, "499 is a 4xx");
    assert.equal(
      new HTTPResponseError(400, "", "", {}, null).isServerError,
      false,
      "400 is not a 5xx",
    );
  });
  testSync("401", () =>
    assert.equal(new HTTPResponseError(401, "", "", {}, null).isUnauthorized, true),
  );
  testSync("403", () =>
    assert.equal(new HTTPResponseError(403, "", "", {}, null).isForbidden, true),
  );
  testSync("500", () =>
    assert.equal(new HTTPResponseError(500, "", "", {}, null).isServerError, true),
  );
  testSync("429", () =>
    assert.equal(new HTTPResponseError(429, "", "", {}, null).isTooManyRequests, true),
  );
  testSync("409", () =>
    assert.equal(new HTTPResponseError(409, "", "", {}, null).isConflict, true),
  );
  testSync("410", () => assert.equal(new HTTPResponseError(410, "", "", {}, null).isGone, true));
  testSync("properties", () => {
    const e = new ResponseSizeLimitError(1000, 500, "");
    eq(e.bytesRead, 1000, "bytes read before the limit");
    eq(e.code, "ESIZELIMIT", "the error code");
    eq(e.name, "ResponseSizeLimitError", "the error name");
    eq(e.limit, 500, "the configured limit");
  });
  testSync("ContentTypeError", () => {
    const e = new ContentTypeError("json", "text", "");
    eq(e.expected, "json", "the expected type");
    eq(e.code, "ECONTENTTYPE", "the error code");
    eq(e.received, "text", "the received type");
  });
  testSync("ResponseDecodeError", () => {
    const e = new ResponseDecodeError("bad", "utf-8", "");
    eq(e.charset, "utf-8", "the attempted charset");
    eq(e.code, "EDECODE", "the error code");
  });

  suite("extractServerTiming");
  testSync("single", () => {
    const t = extractServerTiming({ "server-timing": "cache;desc=Hit" });
    eq(t.length, 1, "one metric parsed");
    eq(t[0]!.name, "cache", "the metric name");
    // desc and dur were never asserted in this file: a parser returning the
    // name and nothing else satisfied every test here.
    eq(t[0]!.description, "Hit", "the desc parameter");
    eq(t[0]!.duration, null, "absent dur is null, not undefined and not NaN");
  });
  testSync("multiple", () => {
    const t = extractServerTiming({ "server-timing": "cache;desc=Hit, db;dur=5" });
    eq(t.length, 2, "two metrics parsed");
    eq(
      t.map((m) => m.name),
      ["cache", "db"],
      "in header order",
    );
    eq(t[1]!.duration, 5, "dur is parsed as a number");
    eq(t[1]!.description, null, "and a metric without desc reports null");
  });
  testSync("dur and desc together, and a non-numeric dur", () => {
    const t = extractServerTiming({
      "server-timing": 'edge;dur=12.5;desc="a hit", broken;dur=abc, bare',
    });
    eq(t.length, 3, "three metrics parsed");
    eq(t[0]!.duration, 12.5, "a fractional dur");
    eq(t[0]!.description, "a hit", "a quoted desc keeps its spaces");
    // parseFloat("abc") is NaN. A NaN duration in a metrics array is a
    // dashboard that silently drops the point, so it is named as null.
    eq(t[1]!.duration, null, "a non-numeric dur is reported as absent");
    eq(t[2]!.duration, null, "a bare metric has no dur");
    eq(t[2]!.name, "bare", "but keeps its name");
  });
  testSync("empty header", () => eq(extractServerTiming({}).length, 0));
  testSync("empty names filtered", () =>
    eq(extractServerTiming({ "server-timing": ";;;" }).length, 0),
  );

  suite("readBodyWithLimit");
  await test("signal abort during limited read", async () => {
    // The source here stalls after its first chunk and never produces another.
    //
    // The previous version of this test enqueued a SECOND chunk 500ms after
    // the first, and that is the only reason it ever passed: `readBodyWithLimit`
    // checks `signal.aborted` at the top of its loop, and the loop only gets
    // another turn when a chunk arrives. The second chunk gave it that turn,
    // so the abort was observed — one tick too late, and only because the
    // test itself arranged for the data to keep coming. Against a connection
    // that stalls after its last byte there is no second turn, and the read
    // stayed pending forever: the promise never settled at all. Verified
    // before the fix — 200ms after the abort the state was still PENDING.
    //
    // The abort must settle the read on its own, and it must not return the
    // one byte it did receive.
    const ac = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1]));
        // Never closed, never enqueued again: a stalled connection.
      },
    });
    let settled = "PENDING";
    const p = readBodyWithLimit(stream, "", { maxBytes: 100 }, ac.signal).then(
      (v) => `RESOLVED ${v.byteLength}`,
      (e) => `REJECTED ${(e as Error).name}`,
    );
    void p.then((r) => (settled = r));
    await delay(50);
    ac.abort();
    await delay(200);
    eq(settled, "REJECTED AbortError", "an abort settles the read even on a stalled source");
  });
  await test("signal abort during limited read, source still producing", async () => {
    // The case the old test actually covered, kept: a source that keeps
    // sending must also abort, and must not swallow the abort by returning
    // the bytes it had.
    const ac = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(new Uint8Array([1]));
        await delay(500);
        c.enqueue(new Uint8Array([2]));
        c.close();
      },
    });
    const p = readBodyWithLimit(stream, "", { maxBytes: 100 }, ac.signal);
    await delay(50);
    ac.abort();
    await assert.rejects(p, (e: unknown) => {
      assert.ok(e instanceof DOMException, "expected a DOMException, got " + String(e));
      assert.equal((e as DOMException).name, "AbortError");
      return true;
    });
  });
  await test("an abort mid-stream ends a stalled NDJSON iteration", async () => {
    // The streaming parsers share the same read loop, and a stalled response
    // left `for await` waiting forever rather than ending at the signal.
    const ac = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"a":1}\n'));
        // never closes
      },
    });
    const got: unknown[] = [];
    const run = (async () => {
      for await (const l of readNDJSON(new Response(stream), { signal: ac.signal })) {
        got.push(l);
      }
      return "ENDED";
    })();
    await delay(30);
    ac.abort();
    const outcome = await Promise.race([run, delay(300).then(() => "STILL PENDING")]);
    eq(outcome, "ENDED", "the generator ends on abort instead of hanging");
    eq(got, [{ a: 1 }], "having yielded what had already arrived");
  });

  suite("readJSONStream");
  await test("concatenated JSON objects", async () => {
    const res = new Response(new TextEncoder().encode('{"a":1}{"a":2}'), {
      headers: { "content-type": "application/json" },
    });
    const objs: any[] = [];
    for await (const obj of readJSONStream(res)) objs.push(obj);
    eq(objs.length, 2, "both objects parsed");
  });
  await test("chunks split across boundaries", async () => {
    const s = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"a":'));
        c.enqueue(new TextEncoder().encode("1}"));
        c.close();
      },
    });
    const objs: any[] = [];
    for await (const o of readJSONStream(new Response(s))) objs.push(o);
    eq(objs.length, 1, "one object across the chunk split");
    eq(objs[0], { a: 1 }, "and it parsed");
  });
  await test("onObject callback", async () => {
    const res = new Response(new TextEncoder().encode('{"x":1}'));
    const called: any[] = [];
    for await (const _o of readJSONStream(res, { onObject: (o) => called.push(o) })) {
    }
    eq(called.length, 1, "onObject fired once");
  });
  await test("onParseError skips bad JSON", async () => {
    const res = new Response(new TextEncoder().encode('{"a":1}{bad}{"a":2}'));
    const errors: any[] = [];
    const objs: any[] = [];
    for await (const o of readJSONStream(res, { onParseError: (e, s) => errors.push(s) }))
      objs.push(o);
    eq(objs.length, 2, "the two good objects still parsed");
    eq(errors.length, 1, "and the bad one was reported");
  });

  suite("readNDJSON");
  await test("parses NDJSON", async () => {
    const res = new Response(new TextEncoder().encode('{"a":1}\n{"a":2}\n'));
    const lines: any[] = [];
    for await (const l of readNDJSON(res)) lines.push(l);
    eq(lines.length, 2, "both lines parsed");
  });
  await test("skips comments and empty lines", async () => {
    const res = new Response(new TextEncoder().encode('#c\n{"a":1}\n\n{"a":2}'));
    const lines: any[] = [];
    for await (const l of readNDJSON(res)) lines.push(l);
    eq(lines.length, 2, "the comment and blank line were skipped");
  });
  await test("onParseError for bad lines", async () => {
    const res = new Response(new TextEncoder().encode('{"a":1}\nbad\n{"a":2}'));
    const errors: any[] = [];
    const lines: any[] = [];
    for await (const l of readNDJSON(res, { onParseError: (e, s) => errors.push(s) }))
      lines.push(l);
    eq(lines.length, 2, "the two good lines still parsed");
    eq(errors.length, 1, "and the bad one was reported");
  });
  await test("final buffer without newline", async () => {
    const res = new Response(new TextEncoder().encode('{"a":1}'));
    const lines: any[] = [];
    for await (const l of readNDJSON(res)) lines.push(l);
    eq(lines.length, 1, "the unterminated final line still parsed");
  });

  suite("parseMultipartResponse");
  await test("two parts", async () => {
    // The `.replace(/\r\n/g, "\r\n")` this used to carry replaced CRLF with
    // CRLF — it asserted nothing and read as though the framing were under
    // test. The bodies and headers are now compared directly, so a parser that
    // returned the right NUMBER of empty parts fails.
    const body =
      "--B\r\nContent-Type: text/plain\r\n\r\np1\r\n--B\r\nContent-Type: text/plain\r\n\r\np2\r\n--B--";
    const res = new Response(body, { headers: { "content-type": "multipart/mixed; boundary=B" } });
    const parts = await parseMultipartResponse(res);
    eq(parts.length, 2, "both parts found");
    eq(
      parts.map((p) => new TextDecoder().decode(p.body)),
      ["p1", "p2"],
      "in order, with every content byte",
    );
    eq(parts[0]!.headers["content-type"], "text/plain", "part headers are parsed");
  });
  await test("bare-LF framing", async () => {
    // Same body, LF-only. RFC 2046 requires CRLF, but LF-only multipart is
    // produced in practice, and this parser returned ZERO parts for it: the
    // header/body split matched `\r\n\r\n` and nothing else, so every part
    // failed it, every part was skipped, and the caller got an empty array
    // with no error to explain it.
    const crlf =
      "--B\r\nContent-Type: text/plain\r\n\r\nhello\r\n--B\r\nContent-Type: text/plain\r\n\r\nworld\r\n--B--";
    const lf = crlf.replace(/\r\n/g, "\n");
    const crlfParts = await parseMultipartResponse(
      new Response(crlf, { headers: { "content-type": "multipart/mixed; boundary=B" } }),
    );
    const lfParts = await parseMultipartResponse(
      new Response(lf, { headers: { "content-type": "multipart/mixed; boundary=B" } }),
    );
    eq(
      lfParts.map((p) => new TextDecoder().decode(p.body)),
      ["hello", "world"],
      "an LF-framed body parses identically to the CRLF one",
    );
    eq(
      lfParts.map((p) => new TextDecoder().decode(p.body)),
      crlfParts.map((p) => new TextDecoder().decode(p.body)),
      "and agrees with it part for part",
    );
  });
  await test("part bodies are not truncated", async () => {
    // The bytes before a boundary were cut with a blind `end - 2`, on the
    // assumption that a CRLF always precedes one. Against an LF-framed body
    // that ate the last two bytes of every part: "hello" -> "hel".
    const lf = "--B\nContent-Type: text/plain\n\nabcde\n--B--";
    const parts = await parseMultipartResponse(
      new Response(lf, { headers: { "content-type": "multipart/mixed; boundary=B" } }),
    );
    eq(parts.length, 1, "the single part is found");
    eq(new TextDecoder().decode(parts[0]!.body), "abcde", "with all five content bytes, not three");
  });
  await test("no boundary throws", async () => {
    const res = new Response("", { headers: { "content-type": "text/plain" } });
    // The specific error, not merely "it rejected".
    await assert.rejects(parseMultipartResponse(res), ContentTypeError);
  });
  await test("no boundary found returns empty", async () => {
    const res = new Response("no boundary", {
      headers: { "content-type": "multipart/mixed; boundary=abc" },
    });
    eq((await parseMultipartResponse(res)).length, 0, "no boundary in the body, so no parts");
  });

  suite("readFormData");
  await test("parses form fields", async () => {
    const body =
      '--F\r\nContent-Disposition: form-data; name="f1"\r\n\r\nv1\r\n--F\r\nContent-Disposition: form-data; name="f2"; filename="t.txt"\r\nContent-Type: text/plain\r\n\r\ncontent\r\n--F--';
    const res = new Response(body, {
      headers: { "content-type": "multipart/form-data; boundary=F" },
    });
    const form = await readFormData(res);
    eq(form.get("f1"), "v1", "the plain field");

    // The second part is a FILE part and was never looked at. The whole
    // `filename` branch — a different FormData value type, a content type
    // read off the part, and a real `File` rather than a string — had no
    // coverage in the suite at all, so a readFormData that dropped every
    // upload passed this test unchanged.
    const file = form.get("f2");
    ok(file instanceof File, "a part with a filename becomes a File");
    const f = file as File;
    eq(f.name, "t.txt", "carrying the filename from content-disposition");
    eq(f.type, "text/plain", "and the part's own content type");
    eq(await f.text(), "content", "and the file content");
    eq(form.getAll("f1").length, 1, "the plain field appears exactly once");
    eq(form.get("nope"), null, "an absent field is null, not undefined");
  });
  await test("a part with no name is skipped", async () => {
    const body =
      '--F\r\nContent-Type: text/plain\r\n\r\norphan\r\n--F\r\nContent-Disposition: form-data; name="kept"\r\n\r\nv\r\n--F--';
    const res = new Response(body, {
      headers: { "content-type": "multipart/form-data; boundary=F" },
    });
    const form = await readFormData(res);
    eq(form.get("kept"), "v", "the named field survives");
    eq([...form.keys()], ["kept"], "and the nameless part contributed nothing");
  });

  suite("readJSON expectedContentType");
  await test("passes on match", async () => {
    const data = await readJSON(
      new Response('{"ok":true}', { headers: { "content-type": "application/json" } }),
      { expectedContentType: "application/json" },
    );
    eq(data, { ok: true }, "the parsed body");
  });
  await test("throws on mismatch", async () => {
    const res = new Response('{"ok":true}', { headers: { "content-type": "text/plain" } });
    await assert.rejects(
      readJSON(res, { expectedContentType: "application/json" }),
      ContentTypeError,
    );
  });

  suite("assertOk / assertOkJSON");
  await test("responseAssertOk returns on 2xx", async () => {
    const r = await responseAssertOk(new Response("ok", { status: 200 }));
    assert.notEqual(r, null);
    assert.equal(r.status, 200);
  });
  await test("responseAssertOk throws on 4xx", async () => {
    // Pinned to HTTPResponseError and to the status it carried: a rejection
    // with the wrong error class, or one that lost the 400, passed before.
    await assert.rejects(
      responseAssertOk(new Response("error", { status: 400 })),
      (e: unknown) => e instanceof HTTPResponseError && e.status === 400,
    );
  });
  await test("responseAssertOk custom isError", async () => {
    // The custom predicate exempts 404, so the call must resolve. Stated
    // explicitly: the old body proved only that the promise settled, not how.
    await assert.doesNotReject(() =>
      responseAssertOk(new Response("", { status: 404 }), { isError: (s: number) => s >= 500 }),
    );
    // And the predicate must still reject what it does classify as an error —
    // otherwise a predicate that always returned false would also pass.
    await assert.rejects(() =>
      responseAssertOk(new Response("", { status: 500 }), { isError: (s: number) => s >= 500 }),
    );
  });
  await test("assertOkJSON returns on success", async () => {
    const res = new Response('{"id":1}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const result = await assertOkJSON(res);
    eq(result.response.status, 200);
  });

  suite("diffResponses");
  await test("detects body change", async () => {
    const d = await diffResponses(new Response("a"), new Response("b"));
    assert.equal(d.bodyChanged, true);
    eq(d.statusChanged, false);
  });
  await test("detects status change", async () => {
    const d = await diffResponses(
      new Response("", { status: 200 }),
      new Response("", { status: 404 }),
    );
    assert.equal(d.statusChanged, true);
  });

  suite("createLimitedReader");
  await test("json", async () => {
    const r = createLimitedReader(1000);
    eq(
      await r.json(new Response('{"x":1}', { headers: { "content-type": "application/json" } })),
      { x: 1 },
      "the parsed JSON",
    );
  });
  await test("text", async () => {
    eq(await createLimitedReader(1000).text(new Response("hi")), "hi");
  });
  await test("bytes", async () => {
    const b = await createLimitedReader(1000).bytes(new Response(new Uint8Array([1, 2, 3])));
    eq(Array.from(b), [1, 2, 3], "the exact bytes");
  });
  await test("blob", async () => {
    const b = await createLimitedReader(1000).blob(new Response("test"));
    // Assert the real type and size, not just that it is a Blob.
    ok(b instanceof Blob);
    // new Response("test") carries an implicit text/plain;charset=utf-8.
    eq(b.type, "text/plain;charset=utf-8", "the content type carried onto the Blob");
    eq(b.size, 4, "the byte length");
    eq(await b.text(), "test", "the decoded content");
  });
  await test("stream", async () => {
    const s = createLimitedReader(1000).stream(new Response("d"));
    ok(s instanceof ReadableStream);
    // The stream must actually yield the body, not just exist.
    const reader = s.getReader();
    const first = await reader.read();
    ok(first.done === false, "expected a chunk");
    eq(new TextDecoder().decode(first.value as Uint8Array), "d", "the chunk carries the body");
    eq((await reader.read()).done, true, "and then the stream ends");
  });
  await test("throws when exceeded", async () => {
    const r = createLimitedReader(5, "throw");
    await assert.rejects(r.text(new Response("hello world")), ResponseSizeLimitError);
  });

  suite("regression: charset, framing, limits, and status bounds");
  await test("regression: an inherited property name is not a charset", async () => {
    // The charset alias table is a plain object literal, so the lookup was a
    // bare index and any name on `Object.prototype` resolved to that member
    // instead of falling back to utf-8. The charset comes off a response
    // header, so a server — or anything that can set one — chose it.
    // `charset=constructor` reached TextDecoder as
    // `function Object() { [native code] }` and `charset=__proto__` as
    // `[object Object]`: both threw ERR_ENCODING_NOT_SUPPORTED, which the
    // fatal-then-lenient fallback could not rescue, so the whole body failed
    // to decode with an error naming a charset nobody sent.
    for (const cs of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"]) {
      const out = decodeBody(new TextEncoder().encode("hi"), cs, "u");
      eq(out, "hi", `charset=${cs} decodes as utf-8 rather than failing`);
    }
    // A genuine unknown label still falls back, and a real alias still applies.
    eq(decodeBody(new TextEncoder().encode("hi"), "klingon", "u"), "hi", "an unknown label");
    eq(decodeBody(new Uint8Array([0x68, 0x00, 0x69, 0x00]), "utf-16le", "u"), "hi", "a real alias");
  });
  await test("regression: braces inside JSON strings are data", async () => {
    // The streaming parser counted every `{`, `[`, `}` and `]` it saw,
    // including the ones inside string values. A lone `}` in a value closed
    // the object early: the text before it was cut off, the remainder was
    // re-scanned as though it were a new object, and BOTH halves were
    // reported as parse errors. The object was silently dropped.
    const cases = [
      '{"note":"use } to close"}',
      '{"q":"a]b"}',
      '{"t":"${x}"}',
      '{"esc":"a\\"}b"}',
      '{"open":"{"}',
    ];
    for (const body of cases) {
      const objs: unknown[] = [];
      const errs: string[] = [];
      for await (const o of readJSONStream(new Response(body), {
        onParseError: (_e, partial) => errs.push(partial),
      })) {
        objs.push(o);
      }
      eq(objs.length, 1, `one object survives ${body}`);
      eq(errs.length, 0, `with no parse error for ${body}`);
      eq(objs[0], JSON.parse(body), `and it equals the real parse of ${body}`);
    }
  });
  await test("regression: expectedContentType is a media type, not a prefix", async () => {
    // The check was `startsWith`, so `expectedContentType: "text/plain"`
    // accepted `text/plaintext` and `"application/json"` accepted
    // `application/json-seq`. The option exists to narrow a parse to one
    // format, and it accepted every format whose name began with it.
    const rejected: [string, string][] = [
      ["text/plain", "text/plaintext"],
      ["application/json", "application/json-seq"],
      ["application/json", "application/jsonish"],
    ];
    for (const [expected, actual] of rejected) {
      let verdict = "ACCEPTED";
      try {
        await readText(new Response("hi", { headers: { "content-type": actual } }), {
          expectedContentType: expected,
        });
      } catch (e) {
        assert.ok(
          e instanceof ContentTypeError,
          `expected a ContentTypeError for ${actual}, got ${String(e)}`,
        );
        verdict = "REJECTED";
      }
      eq(verdict, "REJECTED", `${actual} is not ${expected}`);
    }
    // The one prefix that means something still works, and a parameter on the
    // expected side is still ignored.
    await readText(new Response("hi", { headers: { "content-type": "image/png" } }), {
      expectedContentType: "image",
    });
    await readText(new Response("hi", { headers: { "content-type": "application/json" } }), {
      expectedContentType: "application/json; charset=utf-8",
    });
    // Parameters are stripped on BOTH sides before comparing, so a charset on
    // either the response or the expectation is not part of the media type.
    await readText(
      new Response("hi", { headers: { "content-type": "text/html; charset=utf-8" } }),
      {
        expectedContentType: "text/html",
      },
    );
    await readText(new Response("hi", { headers: { "content-type": "TEXT/HTML" } }), {
      expectedContentType: "text/html",
    });
  });
  await test("regression: an unknown onExceed fails closed", async () => {
    // Both limit readers tested the three modes as a chain of `if`s that each
    // ended in a `break`/`return`, so a value matching NONE of them fell
    // straight through to the line that stores the chunk. The size limit did
    // nothing at all and returned the entire body — a fail-open on the guard
    // the option exists to provide. Measured before the fix: 1000 bytes
    // against a 10-byte cap, through both `readBodyWithLimit` and `readText`.
    const body = new Uint8Array(1000).fill(65);
    for (const mode of ["ignore", "nonsense", "", null, undefined] as const) {
      await assert.rejects(
        readText(new Response(body), {
          sizeLimit: { maxBytes: 10, onExceed: mode as never },
        }),
        ResponseSizeLimitError,
        `onExceed=${String(mode)} is not a licence to ignore the limit`,
      );
    }
    // The three real modes are unchanged.
    eq(
      await readText(new Response(body), { sizeLimit: { maxBytes: 10, onExceed: "truncate" } }),
      "A".repeat(10),
      "truncate still returns exactly the cap",
    );
    eq(
      await readText(new Response(body), { sizeLimit: { maxBytes: 10, onExceed: "abort" } }),
      "",
      "abort still returns nothing",
    );
    // And the same for the streaming path, which had the identical shape.
    const s = createLimitedReader(10, "nonsense" as never).stream(new Response(body));
    await assert.rejects(
      (async () => {
        const rd = s.getReader();
        while (true) {
          const { done } = await rd.read();
          if (done) break;
        }
      })(),
      ResponseSizeLimitError,
      "and the streaming limit fails closed too",
    );
  });
  await test("regression: header membership is an own-property test", async () => {
    // `diffResponses` tested membership with `in`, which walks the prototype
    // chain, over plain object literals. A header whose lowercased name is an
    // `Object.prototype` member therefore read as PRESENT in the other
    // response when it was absent, and a removed header came back as
    // `headersChanged: { constructor: ["yes", null] }` — a null in a field
    // typed `[string, string]`.
    const only = new Response("x", { headers: { constructor: "yes" } });
    const other = new Response("x");
    const d = await diffResponses(only, other);
    eq(d.headersRemoved, { constructor: "yes" }, "reported as removed, not changed");
    eq(d.headersChanged, {}, "and not as changed-to-null");
    // The other direction, and a genuine value change, both still work.
    eq(
      (await diffResponses(other, only)).headersAdded,
      { constructor: "yes" },
      "added, in the reverse direction",
    );
    const changed = await diffResponses(
      new Response("x", { headers: { constructor: "one" } }),
      new Response("x", { headers: { constructor: "two" } }),
    );
    eq(
      changed.headersChanged,
      { constructor: ["one", "two"] },
      "a real change is still a two-string tuple",
    );
  });
  await test("regression: a bare-LF multipart body is not silently empty", async () => {
    // Covered structurally above; this pins the failure mode, because the
    // symptom it produced was an empty array rather than a wrong one — a
    // caller had no error to explain a zero-part result.
    const lf = "--B\nContent-Type: text/plain\n\nx\n--B\nContent-Type: text/plain\n\ny\n--B--";
    const parts = await parseMultipartResponse(
      new Response(lf, { headers: { "content-type": "multipart/mixed; boundary=B" } }),
    );
    ok(parts.length > 0, "an LF-framed body yields parts rather than an empty array");
    eq(
      parts.map((p) => new TextDecoder().decode(p.body)),
      ["x", "y"],
      "with their content, byte for byte",
    );
  });
  await test("regression: a non-numeric Server-Timing dur is not NaN", async () => {
    // `dur !== undefined ? parseFloat(dur) : null` let `parseFloat("abc")`
    // through, so a malformed header put a NaN into the metrics array, where
    // it fails every comparison and disappears from a chart with nothing to
    // say why.
    const t = extractServerTiming({ "server-timing": "edge;dur=abc" });
    eq(t[0]!.duration, null, "reported as absent rather than NaN");
    for (const m of t) {
      assert.ok(!Number.isNaN(m.duration ?? 0), "no metric carries a NaN duration");
    }
    // A real duration is still parsed, including a fractional one.
    eq(extractServerTiming({ "server-timing": "edge;dur=12.5" })[0]!.duration, 12.5, "a real dur");
  });

  // `normalizeHeaders`, `normalizeResponse` and `readBlob` were all IMPORTED
  // by this file and never called: each appeared exactly once, on its own
  // import line. All three are exported from the public `kinetex/response`
  // entry point, so the suite exercised none of them.
  suite("normalizeHeaders / normalizeResponse");
  testSync("normalizeHeaders lower-cases and joins", () => {
    const h = normalizeHeaders(
      new Headers([
        ["Content-Type", "application/json"],
        ["X-Custom", "a"],
        ["X-Custom", "b"],
      ]),
    );
    eq(h["content-type"], "application/json", "the name is lower-cased");
    eq(h["x-custom"], "a, b", "a repeated header is joined, not overwritten");
    eq(Object.keys(h).length, 2, "and yields one entry per distinct name");
  });
  testSync("normalizeResponse copies every documented field", () => {
    const res = new Response("body", {
      status: 201,
      statusText: "Created",
      headers: { "Content-Type": "text/plain", "X-Trace": "t1" },
    });
    const n = normalizeResponse(res);
    eq(
      n,
      {
        status: 201,
        statusText: "Created",
        headers: { "content-type": "text/plain", "x-trace": "t1" },
        url: "",
        redirected: false,
        ok: true,
        bodyUsed: false,
      },
      "the whole normalized shape, so a dropped or renamed field fails",
    );
  });
  await test("normalizeResponse reflects a consumed body", async () => {
    // `bodyUsed` is the field a caller checks before re-reading a body, and
    // every test above used a fresh Response, so a normalizer that
    // hard-coded `false` would pass all of them.
    const res = new Response("x");
    eq(normalizeResponse(res).bodyUsed, false, "false before the body is read");
    await res.text();
    eq(normalizeResponse(res).bodyUsed, true, "true afterwards, read from the response");
  });

  suite("readBlob");
  await test("carries the content type and the bytes", async () => {
    const res = new Response(new Uint8Array([1, 2, 3, 4]), {
      headers: { "content-type": "image/png" },
    });
    const b = await readBlob(res);
    ok(b instanceof Blob, "a Blob");
    eq(b.type, "image/png", "with the response content type");
    eq(b.size, 4, "and the right byte length");
    eq(Array.from(new Uint8Array(await b.arrayBuffer())), [1, 2, 3, 4], "and the right bytes");
  });
  await test("defaults the type when the response has none", async () => {
    // `new Response(bytes)` without a content-type: the Blob must still be
    // usable, and the documented default is application/octet-stream.
    const b = await readBlob(new Response(new Uint8Array([9])));
    eq(b.type, "application/octet-stream", "the documented default type");
    eq(b.size, 1, "with the body");
  });

  // `ResponseCache` was exported and had no test in ANY file in the suite.
  suite("ResponseCache");
  await test("stores, retrieves and deletes", async () => {
    const c = new ResponseCache({ ttlMs: 60_000 });
    eq(c.size, 0, "starts empty");
    await c.set("https://x.test/a", new Response("v1"));
    eq(c.size, 1, "one entry after a set");
    const hit = await c.get("https://x.test/a");
    ok(hit !== null, "the entry is found");
    eq(await hit!.text(), "v1", "with its body intact");
    // The stored Response is cloned, so consuming the returned one must not
    // empty the cache.
    const hit2 = await c.get("https://x.test/a");
    ok(hit2 !== null, "and it is still there after the first read was consumed");
    eq(await hit2!.text(), "v1", "returning the same body twice");
    c.delete("https://x.test/a");
    eq(c.size, 0, "delete removes it");
    eq(await c.get("https://x.test/a"), null, "and it is no longer found");
  });
  await test("keys on method as well as URL", async () => {
    const c = new ResponseCache({ ttlMs: 60_000 });
    await c.set("https://x.test/a", new Response("get"));
    await c.set(new Request("https://x.test/a", { method: "POST" }), new Response("post"));
    eq(c.size, 2, "the same URL under two methods is two entries");
    eq(await (await c.get("https://x.test/a"))!.text(), "get", "the GET one");
    eq(
      await (await c.get(new Request("https://x.test/a", { method: "POST" })))!.text(),
      "post",
      "and the POST one",
    );
  });
  await test("expires", async () => {
    const c = new ResponseCache({ ttlMs: 30 });
    await c.set("u", new Response("v"));
    ok((await c.get("u")) !== null, "fresh within the ttl");
    await delay(60);
    eq(await c.get("u"), null, "gone after it, and the entry is evicted");
    eq(c.size, 0, "so the map does not grow without bound");
  });
  await test("ttlMs: 0 means do not cache", async () => {
    // The expiry test was `Date.now() > expiresAt`, so an entry was still
    // served AT its expiry instant. With a zero TTL that made
    // `new ResponseCache({ ttlMs: 0 })` cache for an instant rather than not
    // at all — and on a fast machine, measurably.
    const c = new ResponseCache({ ttlMs: 0 });
    await c.set("u", new Response("v"));
    eq(await c.get("u"), null, "a zero ttl expires immediately");
  });
  await test("clear empties everything", async () => {
    const c = new ResponseCache({ ttlMs: 60_000 });
    await c.set("a", new Response("1"));
    await c.set("b", new Response("2"));
    eq(c.size, 2, "two entries");
    c.clear();
    eq(c.size, 0, "clear removes them all");
  });

  suite("Real HTTP via kinetex");
  await test("GET readText", async () => {
    const res = await ktx.get("https://jsonplaceholder.typicode.com/posts/1");
    const text = await readText(
      new Response(res.rawBody as any, { headers: { "content-type": "application/json" } }),
    );
    const parsed = JSON.parse(text);
    assert.equal(parsed.userId, 1);
    assert.equal(parsed.id, 1);
    assert.equal(typeof parsed.title, "string");
    assert.ok(parsed.title.length > 0);
  });
  await test("GET readBytes", async () => {
    const res = await ktx.get("https://jsonplaceholder.typicode.com/posts/1");
    const b = await readBytes(new Response(res.rawBody as any));
    assert.ok(b instanceof Uint8Array);
    assert.equal(b.byteLength, 292);
  });
  await test("sizeLimit throw", async () => {
    const res = await ktx.get("https://jsonplaceholder.typicode.com/posts");
    await assert.rejects(
      readText(new Response(res.rawBody as any), {
        sizeLimit: { maxBytes: 10, onExceed: "throw" },
      }),
      ResponseSizeLimitError,
    );
  });
  await test("sizeLimit truncate", async () => {
    const res = await ktx.get("https://jsonplaceholder.typicode.com/posts");
    const t = await readText(new Response(res.rawBody as any), {
      sizeLimit: { maxBytes: 50, onExceed: "truncate" },
    });
    assert.ok(t.length <= 50, `Expected length <= 50, got ${t.length}`);
    assert.equal(typeof t, "string");
  });
  await test("sizeLimit abort", async () => {
    const res = await ktx.get("https://jsonplaceholder.typicode.com/posts");
    const body = res.rawBody as any;

    // The three onExceed modes are genuinely different. A bare `length <= 5`
    // check cannot tell them apart: both "truncate" (returns exactly maxBytes)
    // and "abort" (returns nothing) satisfy it. Pin each behaviour:

    // "throw" rejects with ResponseSizeLimitError.
    let caught: unknown = null;
    try {
      await readText(new Response(body), { sizeLimit: { maxBytes: 5, onExceed: "throw" } });
    } catch (err) {
      caught = err;
    }
    ok(
      caught instanceof ResponseSizeLimitError,
      `expected ResponseSizeLimitError, got ${String(caught)}`,
    );
    eq((caught as ResponseSizeLimitError).limit, 5);
    ok((caught as ResponseSizeLimitError).bytesRead > 5);

    // "truncate" returns exactly maxBytes characters.
    const truncated = await readText(new Response(body), {
      sizeLimit: { maxBytes: 5, onExceed: "truncate" },
    });
    eq(truncated.length, 5);

    // "abort" yields no content at all — not a truncated prefix.
    const aborted = await readText(new Response(body), {
      sizeLimit: { maxBytes: 5, onExceed: "abort" },
    });
    eq(aborted, "");
  });
  await test("signal.aborted before read", async () => {
    const ac = new AbortController();
    ac.abort();
    // Aborts must be AbortError, not whatever else the read might raise.
    await assert.rejects(readText(new Response("hi"), { signal: ac.signal }), (e: unknown) => {
      assert.ok(e instanceof DOMException, "expected a DOMException, got " + String(e));
      assert.equal((e as DOMException).name, "AbortError");
      return true;
    });
  });
  await test("httpbin NDJSON", async () => {
    const res = await ktx.get("https://httpbin.org/stream/3");
    let count = 0;
    for await (const _l of readNDJSON(new Response(res.rawBody as any))) {
      count++;
      if (count >= 3) break;
    }
    assert.equal(count, 3);
  });

  console.log(`\n========================================`);
  console.log(`Tests: ${passed} passed, ${failed} failed`);
  if (failed > 0)
    for (const f of failures)
      console.log(`  - ${f.name}: ${f.err instanceof Error ? f.err.message : f.err}`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
