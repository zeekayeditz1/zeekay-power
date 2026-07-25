import { SignJWT, jwtVerify } from "jose";

const encoder = new TextEncoder();

export interface JwtPayload {
  id: string;
  name: string;
  email: string;
}

function getSecret(secret: string): Uint8Array {
  return encoder.encode(secret);
}

/**
 * Generate JWT token
 */
export async function createToken(
  payload: JwtPayload,
  secret: string
): Promise<string> {
  return await new SignJWT({
    id: payload.id,
    name: payload.name,
    email: payload.email,
  })
    .setProtectedHeader({
      alg: "HS256",
      typ: "JWT",
    })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(getSecret(secret));
}

/**
 * Verify JWT token
 */
export async function verifyToken(
  token: string,
  secret: string
): Promise<JwtPayload> {
  const { payload } = await jwtVerify(
    token,
    getSecret(secret)
  );

  return {
    id: String(payload.id),
    name: String(payload.name),
    email: String(payload.email),
  };
}

/**
 * Decode JWT without verifying.
 * Useful only for debugging.
 */
export function decodePayload(token: string): JwtPayload | null {
  try {
    const parts = token.split(".");

    if (parts.length !== 3) {
      return null;
    }

    const payload = JSON.parse(
      atob(parts[1])
    );

    return {
      id: String(payload.id),
      name: String(payload.name),
      email: String(payload.email),
    };
  } catch {
    return null;
  }
}