// Small expect() on top of node:test and node:assert, so tests read naturally without a test framework dependency.
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";

function matchObject(actual, expected) {
  if (expected === null || typeof expected !== "object") return isDeepStrictEqual(actual, expected);
  if (actual === null || typeof actual !== "object") return false;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((v, i) => matchObject(actual[i], v));
  }
  return Object.keys(expected).every((k) => matchObject(actual[k], expected[k]));
}

/** toEqual semantics: structural equality that ignores undefined properties and prototypes. */
function looseEqual(a, b) {
  const strip = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return isDeepStrictEqual(a, b) || isDeepStrictEqual(strip(a), strip(b));
}

function checkThrown(err, expected) {
  if (expected === undefined) return;
  if (typeof expected === "function") assert.ok(err instanceof expected, `expected error to be instance of ${expected.name}, got ${err?.constructor?.name}: ${err?.message}`);
  else if (expected instanceof RegExp) assert.match(String(err?.message ?? err), expected);
  else if (typeof expected === "string") assert.ok(String(err?.message ?? err).includes(expected), `expected error message to include "${expected}", got "${err?.message}"`);
}

function matchers(actual, negate) {
  const check = (pass, message) => assert.ok(negate ? !pass : pass, `${negate ? "not: " : ""}${message}`);
  const show = (v) => {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  };
  return {
    toBe: (expected) => check(Object.is(actual, expected), `expected ${show(actual)} to be ${show(expected)}`),
    toEqual: (expected) => check(looseEqual(actual, expected), `expected ${show(actual)} to equal ${show(expected)}`),
    toBeNull: () => check(actual === null, `expected ${show(actual)} to be null`),
    toBeUndefined: () => check(actual === undefined, `expected ${show(actual)} to be undefined`),
    toBeDefined: () => check(actual !== undefined, "expected value to be defined"),
    toBeTruthy: () => check(Boolean(actual), `expected ${show(actual)} to be truthy`),
    toBeFalsy: () => check(!actual, `expected ${show(actual)} to be falsy`),
    toBeGreaterThan: (n) => check(actual > n, `expected ${actual} > ${n}`),
    toBeGreaterThanOrEqual: (n) => check(actual >= n, `expected ${actual} >= ${n}`),
    toBeLessThan: (n) => check(actual < n, `expected ${actual} < ${n}`),
    toBeLessThanOrEqual: (n) => check(actual <= n, `expected ${actual} <= ${n}`),
    toBeCloseTo: (n, digits = 2) => check(Math.abs(actual - n) < 10 ** -digits / 2, `expected ${actual} to be close to ${n} (${digits} digits)`),
    toContain: (item) =>
      check(typeof actual === "string" ? actual.includes(item) : Array.from(actual ?? []).some((v) => Object.is(v, item)), `expected ${show(actual)} to contain ${show(item)}`),
    toHaveLength: (n) => check(actual?.length === n, `expected length ${actual?.length} to be ${n}`),
    toMatch: (re) => check(re instanceof RegExp ? re.test(actual) : String(actual).includes(re), `expected ${show(actual)} to match ${re}`),
    toMatchObject: (expected) => check(matchObject(actual, expected), `expected ${show(actual)} to match object ${show(expected)}`),
    toBeInstanceOf: (cls) => check(actual instanceof cls, `expected instance of ${cls.name}`),
    toThrow: (expected) => {
      let thrown = null;
      try {
        actual();
      } catch (err) {
        thrown = err ?? new Error("thrown");
      }
      if (negate) return assert.ok(!thrown, `expected function not to throw, threw ${thrown?.message}`);
      assert.ok(thrown, "expected function to throw");
      checkThrown(thrown, expected);
    },
  };
}

export function expect(actual) {
  const base = matchers(actual, false);
  base.not = matchers(actual, true);
  base.rejects = {
    toThrow: async (expected) => {
      let thrown = null;
      try {
        await actual;
      } catch (err) {
        thrown = err ?? new Error("rejected");
      }
      assert.ok(thrown, "expected promise to reject");
      checkThrown(thrown, expected);
    },
    toBeInstanceOf: async (cls) => {
      let thrown = null;
      try {
        await actual;
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown instanceof cls, `expected rejection with ${cls.name}, got ${thrown?.constructor?.name}`);
    },
  };
  base.resolves = {
    toBe: async (expected) => matchers(await actual, false).toBe(expected),
    toEqual: async (expected) => matchers(await actual, false).toEqual(expected),
  };
  return base;
}

export { describe, it, before, after, beforeEach, afterEach, before as beforeAll, after as afterAll };
