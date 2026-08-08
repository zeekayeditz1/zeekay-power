import { hashPassword } from "../utils/hash";

export interface Env {
  zeekay_power_db: D1Database;
}

export interface User {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  created_at: string;
}

export interface CreateUserInput {
  name: string;
  email: string;
  password: string;
}

export async function getUserByEmail(
  env: Env,
  email: string
): Promise<User | null> {
  const user = await env.zeekay_power_db
    .prepare(
      `
      SELECT *
      FROM users
      WHERE email = ?
      LIMIT 1
      `
    )
    .bind(email.toLowerCase())
    .first<User>();

  return user ?? null;
}

export async function getUserById(
  env: Env,
  id: string
): Promise<User |null> {
  const user = await env.zeekay_power_db
    .prepare(
      `
      SELECT *
      FROM users
      WHERE id = ?
      LIMIT 1
      `
    )
    .bind(id)
    .first<User>();

  return user ?? null;
}

export async function countUsers(env: Env): Promise<number> {
  const row = await env.zeekay_power_db
    .prepare(`SELECT COUNT(*) AS n FROM users`)
    .first<{ n: number }>();

  return row?.n ?? 0;
}

/*
| Bootstrap the single dashboard account. The "is the table empty?" check and
| the INSERT are one atomic statement (INSERT ... SELECT ... WHERE NOT EXISTS),
| so two concurrent registration requests can never both create an account —
| the loser inserts zero rows and gets null back.
*/
export async function createFirstUser(
  env: Env,
  data: CreateUserInput
): Promise<string | null> {

  const passwordHash = await hashPassword(data.password);

  const id = crypto.randomUUID();

  const result: any = await env.zeekay_power_db
    .prepare(
      `INSERT INTO users (id, name, email, password_hash)
       SELECT ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM users)`
    )
    .bind(
      id,
      data.name,
      data.email.toLowerCase(),
      passwordHash
    )
    .run();

  return (result.meta?.changes ?? 0) > 0 ? id : null;
}

export async function deleteUser(
  env: Env,
  id: string
): Promise<void> {

  await env.zeekay_power_db
    .prepare(
      `
      DELETE FROM users
      WHERE id = ?
      `
    )
    .bind(id)
    .run();
}

export async function updateUserName(
  env: Env,
  id: string,
  name: string
): Promise<void> {

  await env.zeekay_power_db
    .prepare(
      `
      UPDATE users
      SET name = ?
      WHERE id = ?
      `
    )
    .bind(
      name,
      id
    )
    .run();
}