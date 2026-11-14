// A simple "at most N at once" counter. Logins are slow on purpose (the password check takes about
// a quarter of a second of CPU), so without a cap, a flood of login requests could keep the server
// busy and slow down everyone else. When the cap is reached, extra attempts are turned away at once.
//
// This protects ONE running server process. That is the right unit: the CPU being protected is that process's.

export type ConcurrencyGate = {
  // Returns a function to call when finished, or null when the limit is reached.
  tryEnter(): (() => void) | null;
  readonly inFlight: number;
};

export function createConcurrencyGate(max: number): ConcurrencyGate {
  if (!Number.isInteger(max) || max < 1) throw new Error("max must be a whole number of at least 1");
  let active = 0;
  return {
    tryEnter() {
      if (active >= max) return null;
      active += 1;
      let released = false;
      return () => {
        if (released) return; // calling it twice must not free someone else's place
        released = true;
        active -= 1;
      };
    },
    get inFlight() {
      return active;
    },
  };
}
