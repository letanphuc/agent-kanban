import type { Env } from "@server/env";

export const LOCAL_AGENT_ID = "local-prime-agent";
export const LOCAL_MACHINE_ID = "local-machine";

export type ExecutorHealth = {
  online: boolean;
  activeRunId: string | null;
  worktree: string;
  runtime: string;
};

export async function executorHealth(env: Env): Promise<ExecutorHealth | null> {
  try {
    const response = await executorFetch(env, "/health");
    return response.ok ? ((await response.json()) as ExecutorHealth) : null;
  } catch {
    return null;
  }
}

export async function startLocalRun(
  env: Env,
  input: {
    runId: string;
    taskId: string;
    ownerId: string;
    prompt: string;
    repositoryId: string | null;
    sessionName: string;
    taskNumber: number;
    continueRun?: boolean;
  },
): Promise<void> {
  const response = await executorFetch(env, `/v1/tasks/${encodeURIComponent(input.taskId)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Local executor returned HTTP ${response.status}`);
  }
}

export async function sendLocalMessage(env: Env, input: { taskId: string; prompt: string }): Promise<void> {
  const response = await executorFetch(env, `/v1/tasks/${encodeURIComponent(input.taskId)}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`Local executor returned HTTP ${response.status}`);
}

export function localAgent(requestUrl: string, online: boolean) {
  const now = new Date().toISOString();
  return {
    id: LOCAL_AGENT_ID,
    name: "Local Prime Agent",
    description: "Runs Prime Agent as a local process in the configured worktree.",
    username: "local-prime-agent",
    runtime: "enbor",
    model: null,
    skills: [],
    subject: LOCAL_AGENT_ID,
    schedulable: online,
    createdAt: now,
    updatedAt: now,
    links: { self: new URL(`/api/agents/${LOCAL_AGENT_ID}`, requestUrl).toString() },
  };
}

async function executorFetch(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const origin = required(env.AK_LOCAL_EXECUTOR_ORIGIN, "AK_LOCAL_EXECUTOR_ORIGIN");
  const url = new URL(path, origin);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Local executor must use 127.0.0.1 HTTP");
  return fetch(url, {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init.headers)),
      "x-ak-local-executor-token": required(env.AK_LOCAL_EXECUTOR_TOKEN, "AK_LOCAL_EXECUTOR_TOKEN"),
    },
    signal: AbortSignal.timeout(2_000),
  });
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}
