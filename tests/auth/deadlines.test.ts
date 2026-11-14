import { describe, expect, it } from "vitest";
import { sessionTimings } from "@/lib/auth/config";
import { computeInitialDeadlines, extendIdleDeadline, isSessionLive, shouldTouch } from "@/lib/auth/deadlines";

const MIN = 60_000;
const HOUR = 60 * MIN;
const timings = sessionTimings({
  SESSION_IDLE_MINUTES: 60,
  SESSION_ABSOLUTE_HOURS: 12,
  SESSION_TOUCH_INTERVAL_SECONDS: 60,
});
const t0 = new Date("2026-11-14T10:00:00.000Z");
const at = (ms: number) => new Date(t0.getTime() + ms);

describe("session timings from settings", () => {
  it("converts minutes, hours and seconds to milliseconds", () => {
    expect(timings).toEqual({ idleMs: 60 * MIN, absoluteMs: 12 * HOUR, touchIntervalMs: 60_000 });
  });
});

describe("initial deadlines", () => {
  it("idle = now + 60 min, hard = now + 12 h", () => {
    const d = computeInitialDeadlines(t0, timings);
    expect(d.expiresAt).toEqual(at(60 * MIN));
    expect(d.absoluteExpiresAt).toEqual(at(12 * HOUR));
  });
  it("never lets the idle deadline pass the hard deadline", () => {
    const odd = { idleMs: 2 * HOUR, absoluteMs: HOUR, touchIntervalMs: 60_000 };
    const d = computeInitialDeadlines(t0, odd);
    expect(d.expiresAt).toEqual(d.absoluteExpiresAt);
  });
  it("does not change the date it was given", () => {
    const copy = new Date(t0);
    computeInitialDeadlines(t0, timings);
    expect(t0).toEqual(copy);
  });
});

describe("sliding the idle deadline", () => {
  it("moves to now + 60 min while far from the hard deadline", () => {
    expect(extendIdleDeadline(at(30 * MIN), at(12 * HOUR), timings)).toEqual(at(90 * MIN));
  });
  it("is clamped to the hard deadline near the end of the session", () => {
    expect(extendIdleDeadline(at(11.5 * HOUR), at(12 * HOUR), timings)).toEqual(at(12 * HOUR));
  });
  it("can never exceed the hard deadline, whatever the time", () => {
    const hard = at(12 * HOUR);
    for (const offset of [0, HOUR, 5 * HOUR, 11 * HOUR + 59 * MIN, 12 * HOUR]) {
      expect(extendIdleDeadline(at(offset), hard, timings).getTime()).toBeLessThanOrEqual(hard.getTime());
    }
  });
});

describe("throttling the last-seen write", () => {
  it("does not write before the interval has passed", () => {
    expect(shouldTouch(at(59_999), t0, timings)).toBe(false);
  });
  it("writes once the interval has passed", () => {
    expect(shouldTouch(at(60_000), t0, timings)).toBe(true);
    expect(shouldTouch(at(10 * MIN), t0, timings)).toBe(true);
  });
  it("ignores a last-seen time in the future", () => {
    expect(shouldTouch(t0, at(5 * MIN), timings)).toBe(false);
  });
});

describe("is the session still usable?", () => {
  const live = { expiresAt: at(60 * MIN), absoluteExpiresAt: at(12 * HOUR), revokedAt: null };
  it("accepts a normal session", () => expect(isSessionLive(at(MIN), live)).toBe(true));
  it("rejects a revoked session", () =>
    expect(isSessionLive(at(MIN), { ...live, revokedAt: at(0) })).toBe(false));
  it("rejects after the idle deadline", () => expect(isSessionLive(at(61 * MIN), live)).toBe(false));
  it("rejects after the hard deadline even if the idle deadline is later", () => {
    const odd = { ...live, expiresAt: at(13 * HOUR) };
    expect(isSessionLive(at(12 * HOUR + 1), odd)).toBe(false);
  });
  it("treats a deadline equal to now as expired", () => {
    expect(isSessionLive(at(60 * MIN), live)).toBe(false);
    expect(isSessionLive(at(60 * MIN - 1), live)).toBe(true);
  });
});
