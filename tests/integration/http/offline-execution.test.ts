// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBoard } from "../../../server/adapters/d1/boardRepo";
import type { Env } from "../../../server/env";
import { api } from "../../../server/http/app";
import { createTestEnv, setupMiniflare } from "../../helpers/db";

const origin = "http://localhost:6265";
const agentToken = "local-agent-token-that-is-long-enough";
let mf: Awaited<ReturnType<typeof setupMiniflare>>["mf"];
let env: Env;

beforeEach(async () => {
  const setup = await setupMiniflare();
  mf = setup.mf;
  env = {
    ...createTestEnv(),
    DB: setup.db,
    AK_PUBLIC_ORIGIN: origin,
    AK_OFFLINE_MODE: "true",
    AK_LOCAL_EXECUTOR_ORIGIN: "http://127.0.0.1:6267",
    AK_LOCAL_EXECUTOR_TOKEN: "local-executor-token-that-is-long-enough",
    AK_LOCAL_AGENT_TOKEN: agentToken,
  } as Env;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await mf.dispose();
});

describe("offline local execution", () => {
  it("creates a repositoryless local Task, assigns it, and accepts the Prime Agent lifecycle", async () => {
    const board = await createBoard(env.DB, "offline", "Offline Dev", "dev");
    const sessionResponse = await api.fetch(new Request(`${origin}/api/auth/session`), env);
    const session = (await sessionResponse.json()) as { session: { csrfToken: string } };
    const cookie = sessionResponse.headers.get("set-cookie")!.split(";", 1)[0];
    const browserHeaders = {
      cookie,
      "x-csrf-token": session.session.csrfToken,
      "API-Version": "2026-08-29",
    };
    const created = await api.fetch(
      new Request(`${origin}/api/tasks`, {
        method: "POST",
        headers: { ...browserHeaders, "content-type": "application/json", "Idempotency-Key": JSON.stringify("offline-create") },
        body: JSON.stringify({ title: "Run locally", boardId: board.id }),
      }),
      env,
    );
    expect(created.status, await created.clone().text()).toBe(201);
    const task = (await created.json()) as { id: string };

    let runBody: { runId: string; taskId: string } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        expect(url.origin).toBe("http://127.0.0.1:6267");
        runBody = JSON.parse(String(init?.body));
        const sessionId = `prime-${runBody!.runId}`;
        const claim = await api.fetch(
          new Request(`${origin}/api/tasks/${task.id}/claims`, {
            method: "POST",
            headers: agentHeaders(sessionId, { "Idempotency-Key": JSON.stringify(`${runBody!.runId}-claim`) }),
          }),
          env,
        );
        expect(claim.status, await claim.clone().text()).toBe(201);
        return Response.json({ sessionId }, { status: 202 });
      }),
    );

    const run = await api.fetch(new Request(`${origin}/api/offline/tasks/${task.id}/run`, { method: "POST", headers: browserHeaders }), env);
    expect(run.status, await run.clone().text()).toBe(202);
    expect(runBody).toMatchObject({ taskId: task.id });

    const claimed = await api.fetch(new Request(`${origin}/api/tasks/${task.id}`, { headers: { cookie, "API-Version": "2026-08-29" } }), env);
    expect((await claimed.json()) as { status: string }).toMatchObject({ status: "in-progress" });

    const sessionId = `prime-${runBody!.runId}`;
    const note = await api.fetch(
      new Request(`${origin}/api/tasks/${task.id}/notes`, {
        method: "POST",
        headers: agentHeaders(sessionId, { "content-type": "application/json", "Idempotency-Key": JSON.stringify(`${runBody!.runId}-note`) }),
        body: JSON.stringify({ detail: "Prime Agent finished the work." }),
      }),
      env,
    );
    expect(note.status, await note.clone().text()).toBe(201);
    const review = await api.fetch(
      new Request(`${origin}/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: agentHeaders(sessionId, { "content-type": "application/merge-patch+json" }),
        body: JSON.stringify({ status: "in-review" }),
      }),
      env,
    );
    expect(review.status, await review.clone().text()).toBe(200);
    expect((await review.json()) as { status: string }).toMatchObject({ status: "in-review" });
  });
});

function agentHeaders(sessionId: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${agentToken}`,
    "X-Prime-Session-Id": sessionId,
    "API-Version": "2026-08-29",
    ...extra,
  };
}
