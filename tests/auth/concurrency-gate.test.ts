import { describe, expect, it } from "vitest";
import { createConcurrencyGate } from "@/lib/auth/concurrency-gate";

describe("concurrency gate", () => {
  it("lets in up to the limit and turns the rest away", () => {
    const gate = createConcurrencyGate(2);
    const a = gate.tryEnter();
    const b = gate.tryEnter();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(gate.inFlight).toBe(2);
    expect(gate.tryEnter()).toBeNull();
    expect(gate.inFlight).toBe(2); // a refused request takes no place
  });
  it("frees a place when someone finishes", () => {
    const gate = createConcurrencyGate(1);
    const release = gate.tryEnter()!;
    expect(gate.tryEnter()).toBeNull();
    release();
    expect(gate.inFlight).toBe(0);
    expect(gate.tryEnter()).not.toBeNull();
  });
  it("releasing twice does not free someone else's place", () => {
    const gate = createConcurrencyGate(1);
    const first = gate.tryEnter()!;
    first();
    const second = gate.tryEnter()!;
    first(); // a mistaken second call from the first holder
    expect(gate.inFlight).toBe(1);
    expect(gate.tryEnter()).toBeNull();
    second();
    expect(gate.inFlight).toBe(0);
  });
  it("refuses a nonsense limit", () => {
    for (const bad of [0, -1, 1.5, NaN]) expect(() => createConcurrencyGate(bad)).toThrow();
  });
});
