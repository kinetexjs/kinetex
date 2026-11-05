/**
 * kinetex — Node transport internals added by the 1.5.0 hardening batch.
 *
 * `createPinnedLookup()` closes the DNS-rebinding gap for the Node transports,
 * but it was only reached by live public-host tests, so its offline branches
 * had no coverage. The invalid-`httpVersion` refusal likewise only fires for a
 * caller mistake that no other suite made.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Kinetex } from "../src/client.ts";
import { createPinnedLookup, FetchTransport, NodeHTTP2Transport } from "../src/core.ts";
import { KinetexError } from "../src/types.ts";
import type { KinetexRequest } from "../src/types.ts";

function request(url: string, httpVersion: string): KinetexRequest {
  return {
    url,
    method: "GET",
    headers: {},
    body: null,
    signal: null,
    meta: {},
    httpVersion,
  } as KinetexRequest;
}

test("an unknown httpVersion is rejected before any dial", async () => {
  const transport = new NodeHTTP2Transport();
  try {
    await assert.rejects(
      () => transport.send(request("http://127.0.0.1:1/", "HTTP/9")),
      (err: unknown) => {
        assert.ok(err instanceof KinetexError);
        assert.equal(err.code, "EVALIDATION");
        assert.match(err.message, /Invalid httpVersion "HTTP\/9"/);
        return true;
      },
    );
  } finally {
    transport.destroy();
  }
});

test("the pinned lookup accepts a public IP literal in both callback shapes", async () => {
  const lookup = createPinnedLookup();

  const all = await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
    lookup("8.8.8.8", { all: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses as { address: string; family: number }[]);
    });
  });
  assert.deepEqual(all, [{ address: "8.8.8.8", family: 4 }]);

  const single = await new Promise<{ address: string; family: number }>((resolve, reject) => {
    lookup("8.8.8.8", {}, (err, address, family) => {
      if (err) reject(err);
      else resolve({ address: address as string, family: family ?? 0 });
    });
  });
  assert.deepEqual(single, { address: "8.8.8.8", family: 4 });
});

test("a resolver failure is forwarded as-is", async () => {
  const lookup = createPinnedLookup();
  // A 64-character label is invalid by DNS rules, so the resolver rejects it
  // locally. A well-formed `.invalid` name would query the network and take
  // tens of seconds on a resolver that drops unknown names.
  const err = await new Promise<NodeJS.ErrnoException>((resolve) => {
    lookup(`${"a".repeat(64)}.invalid`, { all: true }, (lookupErr) => {
      resolve(lookupErr as NodeJS.ErrnoException);
    });
  });
  assert.ok(err instanceof Error, "the resolver error must be forwarded");
  assert.notEqual(err.code, "EBLOCKEDHOST", "a missing name is not a blocked address");
});

test("the fetch preflight recognises an IPv6 literal without resolving it", async () => {
  // `URL.hostname` keeps IPv6 literals bracketed. The DNS preflight must treat
  // that as an address it cannot usefully look up, rather than asking the
  // resolver for the literal string "[::1]".
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("ipv6-ok", { status: 200 });
  }) as typeof globalThis.fetch;
  try {
    // Keep the fake in place while sending: the transport only runs the DNS
    // preflight when its captured fetch is still the global one.
    const transport = new FetchTransport();
    const raw = await transport.send(request("http://[::1]:9/", "HTTP/1.1"));
    assert.equal(raw.status, 200);
    assert.equal(calls, 1, "the fake fetch must be reached without a DNS lookup");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("destroy tolerates an abort controller that throws", async () => {
  const client = new Kinetex({ allowPrivateNetwork: true });
  const controllers = (
    client as unknown as {
      _activeRequestControllers: Set<{ abort: (reason?: unknown) => void }>;
    }
  )._activeRequestControllers;
  let aborts = 0;
  controllers.add({
    abort() {
      aborts++;
      throw new Error("controller already disposed");
    },
  });

  await client.destroy();
  assert.equal(aborts, 1, "destroy must attempt every tracked controller");
  assert.equal(controllers.size, 0, "a throwing controller must not stop the sweep");
});

test("a host that resolves only to loopback is refused, not dialled", async () => {
  const lookup = createPinnedLookup();
  const err = await new Promise<NodeJS.ErrnoException>((resolve) => {
    lookup("localhost", { all: true }, (lookupErr) => {
      resolve(lookupErr as NodeJS.ErrnoException);
    });
  });
  assert.ok(err instanceof Error);
  assert.equal(err.code, "EBLOCKEDHOST");
  assert.match(err.message, /resolves only to a blocked address/);
});
