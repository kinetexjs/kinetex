import process from "node:process";
import assert from "node:assert/strict";
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
function eq<T>(a: T, b: T) {
  const sa = JSON.stringify(a),
    sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`Expected ${sb} got ${sa}`);
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
    eq(r?.mediaType, "application/json");
    eq(r?.type, "application");
  });
  testSync("charset+boundary", () => {
    const r = parseContentType("multipart/form-data; boundary=abc; charset=utf-8");
    eq(r?.boundary, "abc");
    eq(r?.charset, "utf-8");
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
    eq(e.bytesRead, 1000);
    eq(e.limit, 500);
  });
  testSync("ContentTypeError", () => {
    const e = new ContentTypeError("json", "text", "");
    eq(e.expected, "json");
    eq(e.received, "text");
  });
  testSync("ResponseDecodeError", () => {
    const e = new ResponseDecodeError("bad", "utf-8", "");
    eq(e.charset, "utf-8");
  });

  suite("extractServerTiming");
  testSync("single", () => {
    const t = extractServerTiming({ "server-timing": "cache;desc=Hit" });
    eq(t.length, 1);
    eq(t[0].name, "cache");
  });
  testSync("multiple", () => {
    const t = extractServerTiming({ "server-timing": "cache;desc=Hit, db;dur=5" });
    eq(t.length, 2);
  });
  testSync("empty header", () => eq(extractServerTiming({}).length, 0));
  testSync("empty names filtered", () =>
    eq(extractServerTiming({ "server-timing": ";;;" }).length, 0),
  );

  suite("readBodyWithLimit");
  await test("signal abort during limited read", async () => {
    const ac = new AbortController();
    const stream = new ReadableStream({
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
    await assert.rejects(p);
  });

  suite("readJSONStream");
  await test("concatenated JSON objects", async () => {
    const res = new Response(new TextEncoder().encode('{"a":1}{"a":2}'), {
      headers: { "content-type": "application/json" },
    });
    const objs: any[] = [];
    for await (const obj of readJSONStream(res)) objs.push(obj);
    eq(objs.length, 2);
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
    eq(objs.length, 1);
    eq(objs[0], { a: 1 });
  });
  await test("onObject callback", async () => {
    const res = new Response(new TextEncoder().encode('{"x":1}'));
    const called: any[] = [];
    for await (const _o of readJSONStream(res, { onObject: (o) => called.push(o) })) {
    }
    eq(called.length, 1);
  });
  await test("onParseError skips bad JSON", async () => {
    const res = new Response(new TextEncoder().encode('{"a":1}{bad}{"a":2}'));
    const errors: any[] = [];
    const objs: any[] = [];
    for await (const o of readJSONStream(res, { onParseError: (e, s) => errors.push(s) }))
      objs.push(o);
    eq(objs.length, 2);
    eq(errors.length, 1);
  });

  suite("readNDJSON");
  await test("parses NDJSON", async () => {
    const res = new Response(new TextEncoder().encode('{"a":1}\n{"a":2}\n'));
    const lines: any[] = [];
    for await (const l of readNDJSON(res)) lines.push(l);
    eq(lines.length, 2);
  });
  await test("skips comments and empty lines", async () => {
    const res = new Response(new TextEncoder().encode('#c\n{"a":1}\n\n{"a":2}'));
    const lines: any[] = [];
    for await (const l of readNDJSON(res)) lines.push(l);
    eq(lines.length, 2);
  });
  await test("onParseError for bad lines", async () => {
    const res = new Response(new TextEncoder().encode('{"a":1}\nbad\n{"a":2}'));
    const errors: any[] = [];
    const lines: any[] = [];
    for await (const l of readNDJSON(res, { onParseError: (e, s) => errors.push(s) }))
      lines.push(l);
    eq(lines.length, 2);
    eq(errors.length, 1);
  });
  await test("final buffer without newline", async () => {
    const res = new Response(new TextEncoder().encode('{"a":1}'));
    const lines: any[] = [];
    for await (const l of readNDJSON(res)) lines.push(l);
    eq(lines.length, 1);
  });

  suite("parseMultipartResponse");
  await test("two parts", async () => {
    const body =
      "--B\r\nContent-Type: text/plain\r\n\r\np1\r\n--B\r\nContent-Type: text/plain\r\n\r\np2\r\n--B--".replace(
        /\r\n/g,
        "\r\n",
      );
    const res = new Response(body, { headers: { "content-type": "multipart/mixed; boundary=B" } });
    const parts = await parseMultipartResponse(res);
    eq(parts.length, 2);
  });
  await test("no boundary throws", async () => {
    const res = new Response("", { headers: { "content-type": "text/plain" } });
    await assert.rejects(parseMultipartResponse(res));
  });
  await test("no boundary found returns empty", async () => {
    const res = new Response("no boundary", {
      headers: { "content-type": "multipart/mixed; boundary=abc" },
    });
    eq((await parseMultipartResponse(res)).length, 0);
  });

  suite("readFormData");
  await test("parses form fields", async () => {
    const body =
      '--F\r\nContent-Disposition: form-data; name="f1"\r\n\r\nv1\r\n--F\r\nContent-Disposition: form-data; name="f2"; filename="t.txt"\r\nContent-Type: text/plain\r\n\r\ncontent\r\n--F--';
    const res = new Response(body, {
      headers: { "content-type": "multipart/form-data; boundary=F" },
    });
    const form = await readFormData(res);
    eq(form.get("f1"), "v1");
  });

  suite("readJSON expectedContentType");
  await test("passes on match", async () => {
    const data = await readJSON(
      new Response('{"ok":true}', { headers: { "content-type": "application/json" } }),
      { expectedContentType: "application/json" },
    );
    eq(data, { ok: true });
  });
  await test("throws on mismatch", async () => {
    const res = new Response('{"ok":true}', { headers: { "content-type": "text/plain" } });
    await assert.rejects(readJSON(res, { expectedContentType: "application/json" }));
  });

  suite("assertOk / assertOkJSON");
  await test("responseAssertOk returns on 2xx", async () => {
    const r = await responseAssertOk(new Response("ok", { status: 200 }));
    assert.notEqual(r, null);
    assert.equal(r.status, 200);
  });
  await test("responseAssertOk throws on 4xx", async () => {
    await assert.rejects(responseAssertOk(new Response("error", { status: 400 })));
  });
  await test("responseAssertOk custom isError", async () => {
    await responseAssertOk(new Response("", { status: 404 }), { isError: (s: number) => s >= 500 });
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
    eq(await r.json(new Response('{"x":1}', { headers: { "content-type": "application/json" } })), {
      x: 1,
    });
  });
  await test("text", async () => {
    eq(await createLimitedReader(1000).text(new Response("hi")), "hi");
  });
  await test("bytes", async () => {
    const b = await createLimitedReader(1000).bytes(new Response(new Uint8Array([1, 2, 3])));
    eq(Array.from(b), [1, 2, 3]);
  });
  await test("blob", async () => {
    const b = await createLimitedReader(1000).blob(new Response("test"));
    ok(b instanceof Blob);
    eq(await b.text(), "test");
  });
  await test("stream", async () => {
    ok(createLimitedReader(1000).stream(new Response("d")) instanceof ReadableStream);
  });
  await test("throws when exceeded", async () => {
    const r = createLimitedReader(5, "throw");
    await assert.rejects(r.text(new Response("hello world")));
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
    const t = await readText(new Response(res.rawBody as any), {
      sizeLimit: { maxBytes: 5, onExceed: "abort" },
    });
    assert.ok(t.length <= 5, `Expected length <= 5, got ${t.length}`);
  });
  await test("signal.aborted before read", async () => {
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(readText(new Response("hi"), { signal: ac.signal }));
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
