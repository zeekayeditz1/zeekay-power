import bcrypt from "bcryptjs";

const SALT_ROUNDS = 12;

/**
 * Hash a plain text password.
 */
export async function hashPassword(password: string): Promise<string> {
  return await bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Compare a plain password with a hashed password.
 */
export async function verifyPassword(
  password: string,
  hashedPassword: string
): Promise<boolean> {
  return await bcrypt.compare(password, hashedPassword);
}