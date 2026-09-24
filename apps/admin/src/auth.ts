import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const derived = (await scrypt(password, salt, expected.length)) as Buffer;
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** A well-formed but unusable hash (matching hashPassword's `salt:hash` shape
 * and KEY_LENGTH) — used to run a real scrypt computation for a login attempt
 * against an email that doesn't exist, so that case takes the same time as a
 * wrong-password attempt against a real account instead of returning early. */
export const DUMMY_PASSWORD_HASH = `${"0".repeat(32)}:${"0".repeat(KEY_LENGTH * 2)}`;
