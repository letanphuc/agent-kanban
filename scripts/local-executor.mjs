import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import { createServer } from "node:http";
import { isAbsolute, resolve } from "node:path";

const host = "127.0.0.1";
const port = Number(process.env.AK_LOCAL_EXECUTOR_PORT ?? 6267);
const executorToken = process.env.AK_LOCAL_EXECUTOR_TOKEN ?? "";
const agentToken = process.env.AK_LOCAL_AGENT_TOKEN ?? "";
const akOrigin = process.env.AK_PUBLIC_ORIGIN ?? "";
const worktree = resolve(process.env.AK_LOCAL_WORKTREE ?? process.cwd());
const configuredWorkspaces = readWorkspaces();
const workspaces = configuredWorkspaces;
const maxOutputBytes = 1024 * 1024;
const runs = new Map();
const activeRuns = new Map();

if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("AK_LOCAL_EXECUTOR_PORT must be a valid user port");
if (executorToken.length < 32 || agentToken.length < 32) throw new Error("Local executor tokens must contain at least 32 characters");
if (!isAbsolute(worktree) || !statSync(worktree).isDirectory()) throw new Error("AK_LOCAL_WORKTREE must be an absolute directory");
const akUrl = new URL(akOrigin);
if (akUrl.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(akUrl.hostname)) {
  throw new Error("AK_PUBLIC_ORIGIN must use loopback HTTP for local execution");
}

const server = createServer(async (request, response) => {
  try {
    if (!authorized(request)) return json(response, 401, { error: "Unauthorized" });
    if (request.method === "GET" && request.url === "/health") {
      return json(response, 200, {
        online: true,
        activeRunId: [...activeRuns.values()][0]?.runId ?? null,
        worktree,
        workspaces,
        runtime: "prime-agent",
      });
    }
    const messageMatch = request.method === "POST" ? request.url?.match(/^\/v1\/tasks\/([^/]+)\/message$/) : null;
    if (messageMatch) return sendMessage(decodeURIComponent(messageMatch[1]), await readJson(request), response);
    const match = request.method === "PUT" ? request.url?.match(/^\/v1\/tasks\/([^/]+)$/) : null;
    if (!match) return json(response, 404, { error: "Not found" });
    const body = validateRun(await readJson(request), decodeURIComponent(match[1]));
    const existing = runs.get(body.runId);
    if (existing) return json(response, 200, { sessionId: existing.sessionId, state: existing.state });
    const workspace = workspaceFor(body.repositoryId);
    if (!workspace) return json(response, 409, { error: "No local Workspace is configured for this Repository" });
    if (activeRuns.has(workspace.cwd))
      return json(response, 409, { error: "The local Workspace is busy", activeRunId: activeRuns.get(workspace.cwd).runId });

    const run = { ...body, cwd: workspace.cwd, sessionId: `prime-${body.runId}`, state: "claiming", child: null };
    runs.set(run.runId, run);
    activeRuns.set(workspace.cwd, run);
    if (!run.continueRun) {
      const claim = await akFetch(`/api/tasks/${encodeURIComponent(run.taskId)}/claims`, run, {
        method: "POST",
        headers: { "Idempotency-Key": JSON.stringify(`${run.runId}-claim`) },
      });
      if (!claim.ok) {
        runs.delete(run.runId);
        activeRuns.delete(run.cwd);
        return json(response, claim.status, { error: `Task Claim failed: ${await claim.text()}` });
      }
    }
    run.state = "running";
    json(response, 202, { sessionId: run.sessionId, state: run.state });
    setImmediate(() => execute(run));
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : String(error) });
  }
});

function sendMessage(taskId, value, response) {
  const run = [...runs.values()].find((candidate) => candidate.taskId === taskId);
  if (!run || !run.child || run.child.stdin.destroyed) return json(response, 409, { error: "The Prime Agent session is no longer running" });
  if (!value || value.prompt !== "continue") return json(response, 400, { error: "Only the continue message is supported" });
  run.state = "running";
  run.child.stdin.write(`${JSON.stringify({ type: "prompt", message: value.prompt })}\n`);
  return json(response, 202, { state: run.state, sessionId: run.sessionId });
}

server.listen(port, host, () => {
  console.log(`Local Prime Agent executor listening on http://${host}:${port}`);
  setInterval(() => void pickup(), 1500);
  void pickup();
});

async function pickup() {
  if (![...workspaces].some((workspace) => !activeRuns.has(workspace.cwd))) return;
  try {
    const response = await akFetch("/api/tasks?status=todo", { sessionId: "prime-runner" }, { method: "GET" });
    if (!response.ok) return;
    const page = await response.json();
    for (const task of page.items ?? []) {
      const workspace = workspaceFor(task.repositoryId ?? task.repository_id);
      if (!workspace || activeRuns.has(workspace.cwd)) continue;
      const claim = await akFetch(
        `/api/offline/tasks/${encodeURIComponent(task.id)}/claim`,
        { sessionId: "prime-runner" },
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ repositoryId: task.repositoryId ?? task.repository_id }),
        },
      );
      if (claim.ok) {
        await fetch(new URL(`/api/offline/tasks/${encodeURIComponent(task.id)}/run`, akOrigin), {
          method: "POST",
          headers: { Authorization: `Bearer ${agentToken}`, "API-Version": "2026-08-29", "X-Prime-Session-Id": "prime-runner" },
        });
        return;
      }
    }
  } catch (error) {
    console.error(`Local scheduler poll failed: ${error}`);
  }
}

function readWorkspaces() {
  if (!process.env.AK_LOCAL_WORKSPACES) return [];
  let value;
  try {
    value = JSON.parse(process.env.AK_LOCAL_WORKSPACES);
  } catch {
    throw new Error("AK_LOCAL_WORKSPACES must be JSON");
  }
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item?.id !== "string" || typeof item?.repositoryId !== "string" || typeof item?.cwd !== "string")
  ) {
    throw new Error("AK_LOCAL_WORKSPACES must be an array of { id, repositoryId, cwd }");
  }
  return value.map((item) => ({ id: item.id, repositoryId: item.repositoryId, cwd: resolve(item.cwd) }));
}

function workspaceFor(repositoryId) {
  return workspaces.find((workspace) => workspace.repositoryId === repositoryId) ?? null;
}

function execute(run) {
  const childEnv = { ...process.env };
  for (const name of ["AK_LOCAL_EXECUTOR_TOKEN", "AK_LOCAL_AGENT_TOKEN"]) delete childEnv[name];
  const child = spawn("prime-agent", ["--mode", "rpc", "--print", "--cwd", run.cwd], {
    cwd: run.cwd,
    env: childEnv,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  run.child = child;
  child.stdin.write(`${JSON.stringify({ type: "set_session_name", name: `[kanban] #${run.taskNumber} ${run.sessionName}` })}\n`);
  child.stdin.write(`${JSON.stringify({ type: "prompt", message: run.prompt })}\n`);
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let rpcBuffer = "";
  let agentCompleted = false;
  const collect = (current, chunk) => {
    const next = Buffer.concat([current, chunk]);
    if (next.length > maxOutputBytes) child.kill("SIGTERM");
    return next.subarray(0, maxOutputBytes);
  };
  child.stdout.on("data", (chunk) => {
    stdout = collect(stdout, chunk);
    rpcBuffer += chunk.toString("utf8");
    const records = rpcBuffer.split("\n");
    rpcBuffer = records.pop() ?? "";
    for (const record of records) {
      try {
        if (JSON.parse(record).type === "agent_end") {
          agentCompleted = true;
          if (run.state === "running") {
            run.state = "waiting_review";
            void report(run, finalMessage(stdout) || "Prime Agent completed without a final message.", true);
          }
        }
      } catch {
        // Keep the raw stream for the task note; malformed output is diagnostic only.
      }
    }
  });
  child.stderr.on("data", (chunk) => (stderr = collect(stderr, chunk)));
  child.on("error", (error) => finish(run, 1, "", error.message));
  child.on("close", (code) => finish(run, agentCompleted ? 0 : (code ?? 1), stdout.toString("utf8"), stderr.toString("utf8")));
}

function finish(run, exitCode, stdout, stderr) {
  if (run.state !== "running") return;
  run.state = exitCode === 0 ? "complete" : "failed";
  activeRuns.delete(run.cwd);
  const detail =
    exitCode === 0
      ? finalMessage(stdout) || "Prime Agent completed without a final message."
      : `Prime Agent failed with exit code ${exitCode}.\n\n${stderr.trim() || finalMessage(stdout) || "No diagnostic output."}`;
  void report(run, detail, exitCode === 0);
}

async function report(run, detail, succeeded) {
  try {
    const note = await akFetch(`/api/tasks/${encodeURIComponent(run.taskId)}/notes`, run, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": JSON.stringify(`${run.runId}-note`) },
      body: JSON.stringify({ detail }),
    });
    if (!note.ok) throw new Error(`Task Note returned HTTP ${note.status}: ${await note.text()}`);
    if (!succeeded) return;
    const review = await akFetch(`/api/tasks/${encodeURIComponent(run.taskId)}`, run, {
      method: "PATCH",
      headers: { "content-type": "application/merge-patch+json" },
      body: JSON.stringify({ status: "in-review" }),
    });
    if (!review.ok) throw new Error(`Task review submission returned HTTP ${review.status}: ${await review.text()}`);
  } catch (error) {
    console.error(`Local executor report failed: ${error}`);
  }
}

function finalMessage(stdout) {
  let final = "";
  for (const line of stdout.split("\n")) {
    try {
      const event = JSON.parse(line);
      if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
      final =
        event.message.content
          ?.filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
          .trim() ?? final;
    } catch {
      // RPC records are validated opportunistically; malformed records stay local.
    }
  }
  return final;
}

function akFetch(path, run, init) {
  return fetch(new URL(path, akOrigin), {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init.headers)),
      Authorization: `Bearer ${agentToken}`,
      "API-Version": "2026-08-29",
      "X-Prime-Session-Id": run.sessionId,
    },
  });
}

function validateRun(value, taskId) {
  if (!value || typeof value !== "object") throw new Error("Run body must be an object");
  for (const key of ["runId", "taskId", "ownerId", "prompt", "sessionName"]) {
    if (typeof value[key] !== "string" || !value[key]) throw new Error(`${key} is required`);
  }
  if (!Number.isInteger(value.taskNumber) || value.taskNumber < 1) throw new Error("taskNumber must be a positive integer");
  if (value.repositoryId !== null && typeof value.repositoryId !== "string") throw new Error("repositoryId must be a string or null");
  if (value.taskId !== taskId) throw new Error("Task path and body differ");
  if (
    value.runId.length > 200 ||
    value.taskId.length > 200 ||
    value.ownerId.length > 200 ||
    value.sessionName.length > 200 ||
    value.prompt.length > 50_000
  ) {
    throw new Error("Run body exceeds local executor limits");
  }
  return value;
}

function authorized(request) {
  const supplied = request.headers["x-ak-local-executor-token"] ?? "";
  const left = Buffer.from(String(supplied));
  const right = Buffer.from(executorToken);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function shutdown() {
  active?.child?.kill("SIGTERM");
  server.close();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
