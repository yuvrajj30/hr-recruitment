import "server-only";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";

const COST = 12;
const MIN_LENGTH = 12;
const MAX_BYTES = 72; // bcrypt silently ignores anything past 72 bytes, so we refuse longer passwords

export async function hashPassword(plain: string): Promise<string> {
  if (Buffer.byteLength(plain, "utf8") > MAX_BYTES) throw new Error("Password is too long");
  return bcrypt.hash(plain, COST);
}

let dummyHash: string | undefined;
async function getDummyHash(): Promise<string> {
  dummyHash ??= await bcrypt.hash(randomBytes(16).toString("hex"), COST);
  return dummyHash;
}

// When the account does not exist we still do a full password check against a throw-away hash,
// so a login for a missing account takes about as long as a login for a real one.
export async function verifyPassword(plain: string, storedHash: string | null | undefined): Promise<boolean> {
  const hash = storedHash || (await getDummyHash());
  const tooLong = Buffer.byteLength(plain, "utf8") > MAX_BYTES;
  const ok = await bcrypt.compare(tooLong ? "x" : plain, hash);
  return Boolean(storedHash) && ok && !tooLong;
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export type PasswordCheck = { ok: true } | { ok: false; reason: string };

// `avoid` holds things the password must not contain: the person's email, name, company name.
export function validateNewPassword(plain: string, avoid: string[] = []): PasswordCheck {
  if (plain.length < MIN_LENGTH) return { ok: false, reason: `Use at least ${MIN_LENGTH} characters.` };
  if (Buffer.byteLength(plain, "utf8") > MAX_BYTES) return { ok: false, reason: "That password is too long (72 bytes maximum)." };
  if (new Set(plain).size < 5) return { ok: false, reason: "That password is too repetitive." };
  const flat = squash(plain);
  for (const item of avoid) {
    // The whole phrase (for an email, the part before the @) and each word of 5+ letters in it.
    const whole = squash(item.includes("@") ? item.split("@")[0]! : item);
    const words = item.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 5);
    const pieces = [...(whole.length >= 4 ? [whole] : []), ...words];
    if (pieces.some((p) => flat.includes(p))) {
      return { ok: false, reason: "The password must not contain your name, email or company name." };
    }
  }
  return { ok: true };
}
