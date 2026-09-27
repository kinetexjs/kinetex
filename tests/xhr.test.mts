/**
 * kinetex — xhrFetch tests (XMLHttpRequest transport).
 *
 * `xhrFetch` is the browser-only upload/download-progress transport, and
 * `src/progress.ts` captures `globalThis.XMLHttpRequest` at module-evaluation
 * time. Node has no XHR, so the whole function body was unreachable from the
 * normal suites. This file installs a fake XHR *before* dynamically importing
 * the module, which is the only way to reach it outside a browser.
 *
 * It lives in its own file because ESM hoists static imports: the global has to
 * be in place before anything pulls `src/progress.ts` into the graph, and node
 * --test gives each test file its own process.
 */

import assert from "node:assert/strict";

type Listener = (e: unknown) => void;

/** Minimal but faithful XMLHttpRequest double. */
class FakeXHR {
  static last: FakeXHR | null = null;

  method = "";
  url = "";
  async = true;
  status = 0;
  statusText = "";
  response: unknown = null;
  responseText = "";
  responseType = "";
  withCredentials = false;
  timeout = 0;
  readyState = 0;
  sent: unknown = undefined;
  requestHeaders: Record<string, string> = {};
  rawHeaders = "";
  aborted = false;

  onreadystatechange: (() => void) | null = null;
  onload: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onprogress: ((e: unknown) => void) | null = null;
  onloadstart: ((e: unknown) => void) | null = null;

  private listeners: Record<string, Listener[]> = {};
  upload = {
    listeners: {} as Record<string, Listener[]>,
    addEventListener: (t: string, fn: Listener) => {
      (this.upload.listeners[t] ||= []).push(fn);
    },
  };

  constructor() {
    FakeXHR.last = this;
  }

  open(method: string, url: string, async = true): void {
    this.method = method;
    this.url = url;
    this.async = async;
  }

  setRequestHeader(name: string, value: string): void {
    this.requestHeaders[name] = value;
  }

  send(body?: unknown): void {
    this.sent = body;
  }

  abort(): void {
    this.aborted = true;
    this.fire("abort");
  }

  addEventListener(type: string, fn: Listener): void {
    (this.listeners[type] ||= []).push(fn);
  }

  getResponseHeader(): string | null {
    return null;
  }

  getAllResponseHeaders(): string {
    return this.rawHeaders;
  }

  /** Drive an event on the request itself. */
  fire(type: string, e: unknown = {}): void {
    for (const fn of this.listeners[type] ?? []) fn(e);
  }

  /** Drive an event on request.upload. */
  fireUpload(type: string, e: unknown = {}): void {
    for (const fn of this.upload.listeners[type] ?? []) fn(e);
  }
}

// Must happen before the dynamic import below.
(globalThis as Record<string, unknown>).XMLHttpRequest = FakeXHR;

const { xhrFetch } = await import("../src/progress.ts");

let passed = 0,
  failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.log(`  ❌  ${name}: ${m}`);
    failures.push({ name, err });
    failed++;
  }
}

function suite(name: string): void {
  console.log(`\n── ${name}`);
}

/**
 * xhrFetch constructs its own XHR, so the instance to drive is whichever one
 * the constructor last produced — read it after the call, never before.
 */
function xhrAfter<T>(p: Promise<T>): FakeXHR {
  assert.ok(FakeXHR.last, "xhrFetch must have constructed an XMLHttpRequest");
  return FakeXHR.last;
}

suite("xhrFetch request setup");

await test("applies method, url, headers and responseType", async () => {
  const p = xhrFetch("https://example.com/upload", {
    method: "POST",
    headers: { "X-A": "1", "X-B": "2" },
    responseType: "text",
    body: "payload",
  });
  const xhr = xhrAfter(p);
  assert.strictEqual(xhr.method, "POST");
  assert.strictEqual(xhr.url, "https://example.com/upload");
  assert.strictEqual(xhr.async, true);
  assert.deepStrictEqual(xhr.requestHeaders, { "X-A": "1", "X-B": "2" });
  assert.strictEqual(xhr.responseType, "text");
  assert.strictEqual(xhr.sent, "payload");
  xhr.fire("load");
  await p;
});

await test("defaults to GET with no headers and no responseType", async () => {
  const p = xhrFetch("https://example.com/", {});
  const xhr = xhrAfter(p);
  assert.strictEqual(xhr.method, "GET");
  assert.deepStrictEqual(xhr.requestHeaders, {});
  assert.strictEqual(xhr.responseType, "");
  assert.strictEqual(xhr.sent, null); // send(options.body ?? null)
  xhr.fire("load");
  await p;
});

suite("xhrFetch response");

await test("resolves with status, lowercased headers and body", async () => {
  const p = xhrFetch("https://example.com/ok", {});
  const xhr = xhrAfter(p);

  xhr.status = 201;
  xhr.statusText = "Created";
  xhr.response = "hello";
  xhr.rawHeaders = "Content-Type: application/json\r\nX-Trace-Id: abc123\r\n";
  xhr.fire("load");

  const res = await p;
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.statusText, "Created");
  assert.deepStrictEqual(res.headers, {
    "content-type": "application/json",
    "x-trace-id": "abc123",
  });
  assert.strictEqual(res.body, "hello");
});

await test("stringifies a non-string response and a null response", async () => {
  const p = xhrFetch("https://example.com/obj", {});
  xhrAfter(p).status = 200;
  xhrAfter(p).response = { a: 1 };
  xhrAfter(p).rawHeaders = "";
  xhrAfter(p).fire("load");
  assert.strictEqual((await p).body, "[object Object]");

  const p2 = xhrFetch("https://example.com/none", {});
  xhrAfter(p2).status = 204;
  xhrAfter(p2).response = null;
  xhrAfter(p2).rawHeaders = "";
  xhrAfter(p2).fire("load");
  assert.strictEqual((await p2).body, "");
});

suite("xhrFetch progress");

await test("upload progress events reach onUploadProgress", async () => {
  const seen: number[] = [];
  const p = xhrFetch("https://example.com/up", {
    onUploadProgress: (s) => {
      seen.push(s.loaded);
    },
  });
  const xhr = xhrAfter(p);

  // loadstart is a no-op by design (tracker.total is readonly) but must not throw.
  xhr.fireUpload("loadstart", { total: 10 });
  xhr.fireUpload("progress", { loaded: 4, total: 10 });
  xhr.fireUpload("progress", { loaded: 10, total: 10 });
  xhr.fireUpload("load");

  xhr.status = 200;
  xhr.response = "ok";
  xhr.rawHeaders = "";
  xhr.fire("load");
  await p;

  assert.ok(seen.length > 0, "upload progress must be reported");
  assert.strictEqual(seen[seen.length - 1], 10);
});

await test("download progress events reach onDownloadProgress", async () => {
  const seen: number[] = [];
  const p = xhrFetch("https://example.com/down", {
    onDownloadProgress: (s) => {
      seen.push(s.loaded);
    },
  });
  const xhr = xhrAfter(p);

  xhr.fire("progress", { loaded: 5, total: 20 });
  xhr.status = 200;
  xhr.response = "ok";
  xhr.rawHeaders = "";
  xhr.fire("load");
  await p;

  assert.ok(seen.length > 0, "download progress must be reported");
  assert.strictEqual(seen[seen.length - 1], 5);
});

await test("no progress listeners are attached when none are requested", async () => {
  const p = xhrFetch("https://example.com/plain", {});
  const xhr = xhrAfter(p);
  assert.deepStrictEqual(Object.keys(xhr.upload.listeners), []);
  assert.strictEqual(xhr.listeners["progress"], undefined);
  xhr.status = 200;
  xhr.response = "";
  xhr.rawHeaders = "";
  xhr.fire("load");
  await p;
});

suite("xhrFetch failure");

await test("a network error rejects with a TypeError", async () => {
  const p = xhrFetch("https://example.com/err", {});
  xhrAfter(p).fire("error");
  await assert.rejects(p, (err: any) => {
    assert.ok(err instanceof TypeError);
    assert.strictEqual(err.message, "Network request failed");
    return true;
  });
});

await test("a timeout rejects with a TypeError", async () => {
  const p = xhrFetch("https://example.com/slow", {});
  xhrAfter(p).fire("timeout");
  await assert.rejects(p, (err: any) => {
    assert.ok(err instanceof TypeError);
    assert.strictEqual(err.message, "Request timed out");
    return true;
  });
});

await test("an in-XHR abort rejects with an AbortError", async () => {
  const p = xhrFetch("https://example.com/aborted", {});
  xhrAfter(p).fire("abort");
  await assert.rejects(p, (err: any) => {
    assert.strictEqual(err.name, "AbortError");
    assert.strictEqual(err.message, "Request aborted");
    return true;
  });
});

await test("aborting the signal aborts the XHR and rejects", async () => {
  const controller = new AbortController();
  const p = xhrFetch("https://example.com/sig", { signal: controller.signal });
  const xhr = xhrAfter(p);
  controller.abort();
  assert.strictEqual(xhr.aborted, true, "the signal must abort the underlying XHR");
  await assert.rejects(p, (err: any) => err.name === "AbortError");
});

await test("an already-aborted signal rejects without sending", async () => {
  const controller = new AbortController();
  controller.abort();
  const p = xhrFetch("https://example.com/preset", { signal: controller.signal });
  const xhr = xhrAfter(p);
  await assert.rejects(p, (err: any) => err.name === "AbortError");
  assert.strictEqual(xhr.aborted, true);
});

await test("the abort listener is detached once the request settles", async () => {
  // With `{ once: true }` a listener that never fires stays registered, so a
  // caller reusing one signal across many xhrFetch calls accumulated listeners
  // that kept the XHR and promise closures alive after the request finished.
  const controller = new AbortController();
  const g = globalThis as unknown as {
    AbortSignal: { prototype: { removeEventListener: (t: string, f: unknown) => void } };
  };
  let removed = 0;
  const realRemove = g.AbortSignal.prototype.removeEventListener;
  g.AbortSignal.prototype.removeEventListener = function (t, f) {
    if (t === "abort") removed++;
    return realRemove.call(this, t, f);
  };
  try {
    for (const outcome of ["load", "error", "timeout", "abort"] as const) {
      const p = xhrFetch(`https://example.com/${outcome}`, { signal: controller.signal });
      const xhr = xhrAfter(p);
      xhr.status = 200;
      xhr.response = "ok";
      xhr.rawHeaders = "";
      xhr.fire(outcome);
      await p.catch(() => {});
    }
  } finally {
    g.AbortSignal.prototype.removeEventListener = realRemove;
  }
  assert.strictEqual(removed, 4, "each settle path must detach the abort listener");
});

console.log(`\n────────────────────────────────────────`);
console.log(`Tests passed: ${passed}`);
console.log(`Tests failed: ${failed}`);
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.err}`);
  process.exit(1);
}
