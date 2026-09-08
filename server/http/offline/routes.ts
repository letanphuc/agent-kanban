import { authorizeScope } from "@server/auth/middleware";
import { isOfflineMode } from "@server/auth/offline";
import type { Env } from "@server/env";
import { runOfflineTask } from "@server/offline/taskExecution";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

export function registerOfflineTaskRoutes(api: Hono<{ Bindings: Env }>): void {
  api.post("/api/offline/tasks/:taskId/run", authorizeScope("task:write"), (c) => {
    if (!isOfflineMode(c)) throw new HTTPException(404, { message: "Not found" });
    return runOfflineTask(c);
  });
}
