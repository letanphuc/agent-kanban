import {
  AuthError,
  authenticateWebSession,
  type RealmrootPrincipal,
  readRealmrootWebSession,
  validateCsrfToken,
  WEB_SESSION_SCOPES,
} from "@server/auth/realmroot";
import { akPublicUrl } from "@server/config/serviceUrls";
import type { Env } from "@server/env";
import type { Context } from "hono";

const SESSION_COOKIE = "ak_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;

type OfflineSession = {
  id: string;
  tenantId: string;
  subjectId: string;
  email: string;
  name: string;
  role: string;
  csrfToken: string;
  expiresAt: string;
};

export function isOfflineMode(c: Context<{ Bindings: Env }>): boolean {
  if (c.env.AK_OFFLINE_MODE !== "true") return false;
  const urls = [new URL(c.env.AK_PUBLIC_ORIGIN), new URL(c.req.url)];
  return urls.every((url) => (url.protocol === "http:" || url.protocol === "https:") && isLoopbackHostname(url.hostname));
}

export async function authenticateOfflineAgent(c: Context<{ Bindings: Env }>): Promise<RealmrootPrincipal | null> {
  if (!isOfflineMode(c)) return null;
  const authorization = c.req.header("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const expected = c.env.AK_LOCAL_AGENT_TOKEN;
  if (!expected || !(await validateCsrfToken(authorization.slice(7), expected))) return null;
  const sessionId = c.req.header("x-prime-session-id");
  if (!sessionId || sessionId.length > 200) throw new AuthError("X-Prime-Session-Id is required");
  return {
    source: "token",
    type: "agent",
    subjectId: "local-prime-agent",
    actorId: "local-prime-agent",
    controllerSubjectId: "offline-user",
    runtime: "enbor",
    runtimeSessionId: sessionId,
    tenantId: "offline",
    scopes: ["task:read", "task:write", "task:claim"],
  };
}

export async function beginOfflineSession(c: Context<{ Bindings: Env }>): Promise<Response> {
  const { token } = await createOfflineSession(c);
  return new Response(null, {
    status: 302,
    headers: {
      location: akPublicUrl(c.env, safeReturnTo(c.req.query("return_to"))),
      "set-cookie": sessionCookie(token, SESSION_TTL_SECONDS),
    },
  });
}

export async function readOfflineSession(c: Context<{ Bindings: Env }>): Promise<Response> {
  const existing = await readRealmrootWebSession(c);
  if (existing.status !== 401) return existing;
  const { session, token } = await createOfflineSession(c);
  c.header("set-cookie", sessionCookie(token, SESSION_TTL_SECONDS));
  return c.json(sessionRepresentation(session));
}

export async function endOfflineSession(c: Context<{ Bindings: Env }>): Promise<Response> {
  const principal = await authenticateWebSession(c);
  const session = c.get("session");
  if (!principal || !session) return c.json({ error: { code: "UNAUTHORIZED", message: "Authentication required" } }, 401);
  if (!(await validateCsrfToken(c.req.header("x-csrf-token"), session.csrfToken))) {
    return c.json({ error: { code: "CSRF_INVALID", message: "Invalid CSRF token" } }, 403);
  }
  await c.env.DB.prepare("DELETE FROM realmroot_web_sessions WHERE id = ?").bind(session.id).run();
  return new Response(null, { status: 204, headers: { "set-cookie": sessionCookie("", 0) } });
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

// ponytail: Offline mode supports one local admin; add local identity selection only for multi-user offline testing.
async function createOfflineSession(c: Context<{ Bindings: Env }>): Promise<{ session: OfflineSession; token: string }> {
  const token = randomToken(48);
  const session: OfflineSession = {
    id: crypto.randomUUID(),
    tenantId: "offline",
    subjectId: "offline-user",
    email: "offline@localhost",
    name: "Offline User",
    role: "admin",
    csrfToken: randomToken(),
    expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString(),
  };
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT OR IGNORE INTO realmroot_tenants (id) VALUES (?)").bind(session.tenantId),
    c.env.DB.prepare(
      `INSERT INTO realmroot_tenant_members (tenant_id, subject_id, email, name, role)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, subject_id) DO UPDATE SET email = excluded.email, name = excluded.name, role = excluded.role`,
    ).bind(session.tenantId, session.subjectId, session.email, session.name, session.role),
    c.env.DB.prepare(
      `INSERT INTO realmroot_web_sessions
         (id, token_hash, tenant_id, subject_id, email, name, role, scopes_json, csrf_token, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      session.id,
      await sha256Hex(token),
      session.tenantId,
      session.subjectId,
      session.email,
      session.name,
      session.role,
      JSON.stringify(WEB_SESSION_SCOPES),
      session.csrfToken,
      session.expiresAt,
    ),
  ]);
  return { session, token };
}

function sessionRepresentation(session: OfflineSession) {
  return {
    offline: true,
    session: { id: session.id, expiresAt: session.expiresAt, csrfToken: session.csrfToken },
    user: {
      id: session.subjectId,
      tenantId: session.tenantId,
      name: session.name,
      email: session.email,
      image: null,
      role: session.role,
    },
  };
}

function safeReturnTo(value: string | undefined): string {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/";
}

function sessionCookie(value: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

function randomToken(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return btoa(String.fromCharCode(...value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
