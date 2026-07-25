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

export async function emailExists(
  env: Env,
  email: string
): Promise<boolean> {
  const user = await env.zeekay_power_db
    .prepare(
      `
      SELECT id
      FROM users
      WHERE email = ?
      LIMIT 1
      `
    )
    .bind(email.toLowerCase())
    .first();

  return user !== null;
}

export async function createUser(
  env: Env,
  data: CreateUserInput
): Promise<string> {

  const passwordHash = await hashPassword(data.password);

  const id = crypto.randomUUID();

  await env.zeekay_power_db
    .prepare(
      `
      INSERT INTO users
      (
        id,
        name,
        email,
        password_hash
      )
      VALUES
      (
        ?,
        ?,
        ?,
        ?
      )
      `
    )
    .bind(
      id,
      data.name,
      data.email.toLowerCase(),
      passwordHash
    )
    .run();

  return id;
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