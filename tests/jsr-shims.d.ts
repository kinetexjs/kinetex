// Ambient declarations for specifiers that only resolve inside their own
// runtime. `tests/runtime/deno/*` imports Deno's standard library by its JSR
// URL, which the Node type-checker cannot resolve; without this the whole file
// is reported as `any`, hiding every real error inside it.
//
// Only the surface the suites actually use is declared, so a rename in Deno's
// std is still caught here.

declare module "jsr:@std/assert" {
  export function assert(expr: unknown, msg?: string): asserts expr;
  export function assertEquals<T>(actual: T, expected: T, msg?: string): void;
  export function assertNotEquals<T>(actual: T, expected: T, msg?: string): void;
  export function assertStrictEquals<T>(actual: T, expected: T, msg?: string): void;
  export function assertExists<T>(actual: T, msg?: string): asserts actual is NonNullable<T>;
  export function assertMatch(actual: string, expected: RegExp, msg?: string): void;
  export function assertRejects(
    fn: () => unknown | Promise<unknown>,
    ErrorClass: abstract new (...args: never[]) => unknown,
    msgIncludes?: string,
  ): Promise<unknown>;
  export function assertRejects(
    fn: () => unknown | Promise<unknown>,
    msg?: string,
  ): Promise<unknown>;
  export function assertThrows(fn: () => unknown, msg?: string): unknown;
  export function fail(msg?: string): never;
}

declare module "jsr:@std/assert/equal" {
  export function equal<T>(actual: T, expected: T, msg?: string): void;
}

declare module "jsr:@std/path" {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(p: string): string;
  export function basename(p: string, ext?: string): string;
  export const SEPARATOR: string;
}

/**
 * `Deno` is a global inside Deno, not in Node's lib. Only the members these
 * suites use are declared, so a rename in Deno still surfaces here rather than
 * being silently `any`.
 */
declare const Deno: {
  exit(code?: number): never;
  env: { get(key: string): string | undefined };
  readFile(path: string | URL): Promise<Uint8Array>;
  writeFile(path: string | URL, data: Uint8Array | string): Promise<void>;
  serve(options: Record<string, unknown>): { finished: Promise<void>; shutdown(): Promise<void> };
  listen(options: Record<string, unknown>): { finished: Promise<void>; shutdown(): Promise<void> };
  connect(options: Record<string, unknown>): unknown;
  build: { os: string; arch: string };
};
