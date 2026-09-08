// Run: node tests/integration/adapters/local-executor.check.mjs
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { runInNewContext } from "node:vm";

const children = [];
const requests = [];
let savedHeader = { type: "session", id: "real-session" };
const source = readFileSync(new URL("../../../scripts/local-executor.mjs", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
const api = runInNewContext(`${source}\n({ execute, sendMessage, runs, activeRuns, shutdown });`, {
  Buffer,
  URL,
  Headers,
  AbortSignal,
  console,
  isAbsolute,
  resolve,
  setTimeout,
  clearTimeout,
  setImmediate,
  randomUUID: () => "note-id",
  timingSafeEqual: () => true,
  statSync: () => ({ isDirectory: () => true, isFile: () => true }),
  readFileSync: () => JSON.stringify(savedHeader),
  process: {
    env: { AK_LOCAL_EXECUTOR_TOKEN: "x".repeat(32), AK_LOCAL_AGENT_TOKEN: "y".repeat(32), AK_PUBLIC_ORIGIN: "http://localhost:6265" },
    cwd: () => "/repo",
    on() {},
  },
  createServer: () => ({ listen() {}, close() {} }),
  fetch: async (url, init) => {
    requests.push({ path: url.pathname, ...init });
    return { ok: true };
  },
  spawn(_command, args) {
    const child = Object.assign(new EventEmitter(), {
      args,
      exitCode: null,
      signalCode: null,
      killed: false,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: Object.assign(new EventEmitter(), {
        destroyed: false,
        write(line) {
          child.messages.push(JSON.parse(line));
        },
      }),
      messages: [],
      kill() {
        this.killed = true;
      },
    });
    children.push(child);
    return child;
  },
});
const run = {
  runId: "assignment",
  taskId: "task",
  cwd: "/repo",
  sessionId: "prime-assignment",
  state: "running",
  prompt: "Do the task",
  taskNumber: 1,
  sessionName: "Task",
};
api.runs.set(run.runId, run);
api.activeRuns.set(run.cwd, run);
function state(child, overrides = {}) {
  child.stdout.emit(
    "data",
    Buffer.from(
      `${JSON.stringify({ type: "response", id: "kanban-state", success: true, data: { sessionFile: "/sessions/real-session.jsonl", sessionId: "real-session", isStreaming: false, ...overrides } })}\n`,
    ),
  );
}
function response() {
  return {
    writeHead(status) {
      this.status = status;
    },
    end(body) {
      this.body = JSON.parse(body);
    },
  };
}

const initial = api.execute(run);
const first = children[0];
assert.deepEqual(
  first.messages.map((message) => message.type),
  ["get_state"],
);
state(first);
await initial;
assert.equal(run.runtimeSessionId, "real-session");
assert.equal(first.messages.at(-1).message, "Do the task");

let reply = response();
await api.sendMessage("task", { prompt: "continue" }, reply);
assert.equal(reply.status, 202);
assert.equal(children.length, 1);
assert.equal(first.messages.at(-1).message, "continue");

first.signalCode = "SIGKILL";
first.stdout.emit(
  "data",
  Buffer.from(
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Built and ran Hello, world!"}]}}\n{"type":"agent_end","messages":[{"role":"assistant","stopReason":"stop","content":[{"type":"text","text":"Built and ran Hello, world!"}]}]}\n',
  ),
);
await new Promise(setImmediate);
assert.equal(requests.length, 2, "agent_end must post the final note and submit review");
assert.equal(JSON.parse(requests[0].body).detail, "Built and ran Hello, world!");
assert.equal(JSON.parse(requests[1].body).status, "in-review");
first.emit("close", null);
assert.equal(api.activeRuns.has(run.cwd), false);
reply = response();
const resumed = api.sendMessage("task", { prompt: "continue" }, reply);
const second = children[1];
assert.equal(second.args.at(-2), "--resume");
assert.equal(second.args.at(-1), run.sessionFile);
assert.deepEqual(
  second.messages.map((message) => message.type),
  ["get_state"],
);
const concurrent = response();
await api.sendMessage("task", { prompt: "continue" }, concurrent);
assert.equal(concurrent.status, 409);
state(second);
await resumed;
assert.equal(reply.status, 202);
assert.deepEqual(
  second.messages.map((message) => message.type),
  ["get_state", "prompt"],
);
assert.equal(second.messages.at(-1).message, "continue");

second.signalCode = "SIGKILL";
second.emit("close", null);
savedHeader = { type: "session", id: "wrong-session" };
reply = response();
await api.sendMessage("task", { prompt: "continue" }, reply);
assert.equal(reply.status, 409);
assert.equal(children.length, 2);
savedHeader.id = "real-session";
reply = response();
const mismatched = api.sendMessage("task", { prompt: "continue" }, reply);
const third = children[2];
state(third, { sessionId: "wrong-session" });
await mismatched;
assert.equal(reply.status, 502);
assert.equal(third.killed, true);
assert.deepEqual(
  third.messages.map((message) => message.type),
  ["get_state"],
);
third.signalCode = "SIGTERM";
third.emit("close", null);

reply = response();
api.activeRuns.set(run.cwd, { taskId: "another-task" });
await api.sendMessage("task", { prompt: "continue" }, reply);
assert.equal(reply.status, 409);
assert.equal(children.length, 3);
api.activeRuns.delete(run.cwd);

savedHeader = null;
reply = response();
await api.sendMessage("task", { prompt: "continue" }, reply);
assert.equal(reply.status, 409);
assert.equal(children.length, 3);
savedHeader = { type: "session", id: "real-session" };

reply = response();
const failed = api.sendMessage("task", { prompt: "continue" }, reply);
const fourth = children[3];
fourth.emit("error", new Error("spawn failed"));
await failed;
assert.equal(reply.status, 502);
assert.deepEqual(
  fourth.messages.map((message) => message.type),
  ["get_state"],
);
api.shutdown();
console.log("local executor continuation checks passed");
