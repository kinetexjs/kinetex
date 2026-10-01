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

/**
 * Every test here drives a promise that only settles when the fake is told to
 * settle it, so the failure mode of this file is a hang rather than a throw —
 * and a hang at the top level is silent: node reports "unsettled top-level
 * await" and the process exits with the tests before it never printed. A
 * budget turns that into a named failure. The fake never schedules anything,
 * so five seconds is many orders of magnitude more than any correct test needs.
 */
const TEST_BUDGET_MS = 5_000;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      fn(),
      new Promise<void>((_resolve, rejectRace) => {
        timer = setTimeout(
          () => rejectRace(new Error("__RACE_EXPIRED__ the promise never settled")),
          TEST_BUDGET_MS,
        );
      }),
    ]).finally(() => clearTimeout(timer));
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
      // The settle path is asserted per outcome. `await p.catch(() => {})` was
      // satisfied by resolution *and* rejection, so a path that resolved when
      // it should have rejected — the exact bug this suite guards — passed.
      if (outcome === "load") {
        assert.deepEqual(await p, {
          status: 200,
          statusText: "",
          headers: {},
          body: "ok",
        });
      } else {
        await assert.rejects(
          () => p,
          (err: unknown) => {
            assert.ok(err instanceof Error, `${outcome} must reject with an Error`);
            // Each path rejects with its own diagnostic, not a shared one:
            // a handler wired to the wrong event is indistinguishable if the
            // message is not checked.
            if (outcome === "abort") {
              assert.equal((err as { name?: string }).name, "AbortError");
            } else {
              assert.ok(
                err instanceof TypeError,
                `${outcome} must reject with a TypeError, got ${err.constructor.name}`,
              );
              assert.match(err.message, outcome === "error" ? /network/i : /timed out/i);
            }
            return true;
          },
          `${outcome} must reject`,
        );
      }
    }
  } finally {
    g.AbortSignal.prototype.removeEventListener = realRemove;
  }
  assert.strictEqual(removed, 4, "each settle path must detach the abort listener");
});

// ============================================================================
// REGRESSIONS — one case per defect this round's audit found
// ============================================================================

suite("xhrFetch regressions");

await test("an empty-valued response header is not dropped", async () => {
  // The parser searched for `": "` and the input was `trim()`ed first, so the
  // single space of an empty value was stripped before the search: `"X-Empty:
  // \r\n"` became `"X-Empty:"`, missed, and the header was dropped. A response
  // whose headers were all empty-valued normalized to `{}` — and a header
  // written without the space was dropped the same way.
  const p = xhrFetch("https://example.com/empty", {});
  const xhr = xhrAfter(p);
  xhr.status = 200;
  xhr.response = "";
  xhr.rawHeaders = "X-Empty: \r\nX-After: 1\r\n";
  xhr.fire("load");
  const res = await p;
  // The presence of the key is the whole point — `res.headers["x-empty"]` being
  // `""` is indistinguishable from the key being absent unless it is checked
  // for, which no `deepStrictEqual` against a value-only expectation would do.
  assert.ok("x-empty" in res.headers, "an empty-valued header must still be present");
  assert.equal(res.headers["x-empty"], "");
  assert.equal(res.headers["x-after"], "1");

  // A response whose ONLY header is empty-valued is the case that reads as
  // "no headers at all".
  const only = xhrFetch("https://example.com/only", {});
  const oxhr = xhrAfter(only);
  oxhr.status = 204;
  oxhr.response = "";
  oxhr.rawHeaders = "X-Empty: \r\n";
  oxhr.fire("load");
  assert.deepEqual((await only).headers, { "x-empty": "" });

  // No space after the colon, and leading/trailing space, are handled too.
  const p3 = xhrFetch("https://example.com/spacing", {});
  const x3 = xhrAfter(p3);
  x3.status = 200;
  x3.response = "";
  x3.rawHeaders = "Content-Type:application/json\r\n  X-Lead: v\r\nX-Trail: v   \r\n";
  x3.fire("load");
  assert.deepEqual((await p3).headers, {
    "content-type": "application/json",
    "x-lead": "v",
    "x-trail": "v",
  });

  // A header named `__proto__` is a legal name — token characters only — and
  // `headers[name] = value` is a [[Set]], so it went to the inherited setter,
  // which ignores a primitive: the header vanished instead of being recorded.
  const p4 = xhrFetch("https://example.com/proto", {});
  const x4 = xhrAfter(p4);
  x4.status = 200;
  x4.response = "";
  x4.rawHeaders = "__proto__: polluted\r\nX-Real: kept\r\n";
  x4.fire("load");
  const h4 = (await p4).headers;
  assert.equal(h4["__proto__"], "polluted", "the header must be recorded");
  assert.equal(h4["x-real"], "kept");
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.getPrototypeOf(h4), Object.prototype);

  // And the ordinary case is unchanged, including the last-wins behaviour for
  // a repeated name.
  const p5 = xhrFetch("https://example.com/dup", {});
  const x5 = xhrAfter(p5);
  x5.status = 200;
  x5.response = "";
  x5.rawHeaders = "Content-Type: a\r\ncontent-type: b\r\n";
  x5.fire("load");
  assert.deepEqual((await p5).headers, { "content-type": "b" });
});

await test("a responseType that cannot yield text is refused", async () => {
  // `XHRResult.body` is a string, but `responseType` was typed with the whole
  // XHR enum. Everything outside "" / "text" hands back a parsed value, and
  // `String(xhr.response)` turned an ArrayBuffer, a Blob and a parsed JSON
  // object alike into the literal string "[object Object]" — indistinguishable
  // from a body, and not one. On the upload path, which is the entire reason
  // this function exists, a binary response came back as seven characters.
  for (const responseType of ["json", "arraybuffer", "blob", "document"] as const) {
    const p = xhrFetch("https://example.com/rt", { responseType });
    await assert.rejects(
      () => p,
      (err: unknown) => {
        assert.ok(err instanceof TypeError, `${responseType} must reject with a TypeError`);
        assert.match((err as Error).message, new RegExp(responseType));
        // The message has to say what to do instead, not just what went wrong.
        assert.match((err as Error).message, /"text"/);
        return true;
      },
      `responseType "${responseType}" must be refused`,
    );
  }
  // Refused before anything is constructed: no request is opened.
  const before = FakeXHR.last;
  await xhrFetch("https://example.com/never", { responseType: "blob" }).catch(() => {});
  assert.equal(FakeXHR.last, before, "no XMLHttpRequest may be constructed for a refused call");

  // The two forms that do produce text still work, and "" (the default) is not
  // a refusal.
  const ok = xhrFetch("https://example.com/ok", { responseType: "text" });
  const xok = xhrAfter(ok);
  assert.strictEqual(xok.responseType, "text");
  xok.status = 200;
  xok.response = "plain";
  xok.fire("load");
  assert.equal((await ok).body, "plain");

  const dflt = xhrFetch("https://example.com/dflt", {});
  const xd = xhrAfter(dflt);
  assert.strictEqual(xd.responseType, "", "the default is left alone");
  xd.status = 200;
  xd.response = "plain";
  xd.fire("load");
  assert.equal((await dflt).body, "plain");
});

await test("a send() that throws still detaches the abort listener", async () => {
  // The file's own comment above the abort wiring says what accumulates when
  // the listener is not detached on every exit, and the test above covers four
  // exits — load, error, timeout, abort. There is a fifth: a body the XHR
  // refuses throws straight out of the promise executor. The promise rejects
  // with it, so the caller sees an error, but no handler runs on that path and
  // the listener stayed attached, holding the XHR and the closures alive for as
  // long as the caller keeps the signal.
  const controller = new AbortController();
  const g = globalThis as unknown as {
    AbortSignal: { prototype: { removeEventListener: (t: string, f: unknown) => void } };
  };
  const realRemove = g.AbortSignal.prototype.removeEventListener;
  let removed = 0;
  g.AbortSignal.prototype.removeEventListener = function (t, f) {
    if (t === "abort") removed++;
    return realRemove.call(this, t, f);
  };
  const realSend = FakeXHR.prototype.send;
  try {
    FakeXHR.prototype.send = function (this: FakeXHR) {
      throw new DOMException("Failed to execute 'send'", "InvalidStateError");
    };
    // Repeated on one signal, which is the pattern the comment describes: a
    // single leaked listener is a bounded cost, N of them is the bug.
    for (let i = 0; i < 3; i++) {
      const p = xhrFetch(`https://example.com/throw-${i}`, { signal: controller.signal });
      await assert.rejects(
        () => p,
        (err: unknown) => {
          // The original error is surfaced unchanged, not replaced by a
          // generic one — a caller diagnosing the body needs it.
          assert.equal((err as Error).name, "InvalidStateError");
          assert.match((err as Error).message, /send/);
          return true;
        },
        "a throwing send must reject the caller's promise",
      );
    }
    assert.strictEqual(removed, 3, "each throwing send must detach the abort listener");
  } finally {
    FakeXHR.prototype.send = realSend;
    g.AbortSignal.prototype.removeEventListener = realRemove;
  }

  // The signal is still usable afterwards, and a request on it settles normally.
  const after = xhrFetch("https://example.com/after", { signal: controller.signal });
  const xa = xhrAfter(after);
  xa.status = 200;
  xa.response = "ok";
  xa.rawHeaders = "";
  xa.fire("load");
  assert.deepEqual(await after, { status: 200, statusText: "", headers: {}, body: "ok" });
});

console.log(`\n────────────────────────────────────────`);
console.log(`Tests passed: ${passed}`);
console.log(`Tests failed: ${failed}`);
if (failed > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.err}`);
  process.exit(1);
}
