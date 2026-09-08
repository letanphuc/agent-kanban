// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../../server/env";
import { api } from "../../../server/http/app";
import { createTestEnv, setupMiniflare } from "../../helpers/db";

const origin = "http://localhost:6265";
let mf: Awaited<ReturnType<typeof setupMiniflare>>["mf"];
let env: Env;

beforeEach(async () => {
  const setup = await setupMiniflare();
  mf = setup.mf;
  env = { ...createTestEnv(), DB: setup.db, AK_PUBLIC_ORIGIN: origin, AK_OFFLINE_MODE: "true" } as Env;
});

afterEach(async () => {
  await mf.dispose();
});

describe("localhost offline authentication", () => {
  it("[spec: authentication/localhost-offline-session] creates a local session and preserves CSRF logout", async () => {
    const response = await api.fetch(new Request(`${origin}/api/auth/session`), env);

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(/^ak_session=.*HttpOnly; Secure; SameSite=Lax/);
    const body = (await response.json()) as {
      session: { csrfToken: string };
      user: { id: string; tenantId: string; role: string };
    };
    expect(body.user).toMatchObject({ id: "offline-user", tenantId: "offline", role: "admin" });

    const cookie = response.headers.get("set-cookie")!.split(";", 1)[0];
    const boards = await api.fetch(new Request(`${origin}/api/boards`, { headers: { cookie } }), env);
    expect(boards.status).toBe(200);

    const rejectedLogout = await api.fetch(new Request(`${origin}/api/auth/logout`, { method: "POST", headers: { cookie } }), env);
    expect(rejectedLogout.status).toBe(403);
    const logout = await api.fetch(
      new Request(`${origin}/api/auth/logout`, {
        method: "POST",
        headers: { cookie, "x-csrf-token": body.session.csrfToken },
      }),
      env,
    );
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("does not enable offline authentication for a non-loopback origin", async () => {
    env = { ...env, AK_PUBLIC_ORIGIN: "https://agent-kanban.dev" };
    const response = await api.fetch(new Request("https://agent-kanban.dev/api/auth/session"), env);
    expect(response.status).toBe(401);
  });
});
