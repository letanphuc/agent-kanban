import { d1TaskAssignmentRepository } from "@server/adapters/d1/tasks/d1TaskAssignments";
import { authorizeScope } from "@server/auth/middleware";
import { isOfflineMode } from "@server/auth/offline";
import type { Env } from "@server/env";
import { LOCAL_AGENT_ID } from "@server/offline/executor";
import { continueOfflineTask, runOfflineTask } from "@server/offline/taskExecution";
import { replaceTaskAssignment } from "@server/usecases/tasks/replaceTaskAssignment";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

export function registerOfflineTaskRoutes(api: Hono<{ Bindings: Env }>): void {
  api.post("/api/offline/tasks/:taskId/claim", authorizeScope("task:claim"), async (c) => {
    if (!isOfflineMode(c) || c.get("principal").type !== "agent") throw new HTTPException(404, { message: "Not found" });
    const taskId = c.req.param("taskId")!;
    const task = await c.env.DB.prepare(
      `SELECT t.id, t.version, t.status, t.repository_id FROM tasks t
       JOIN boards b ON b.id = t.board_id WHERE t.id = ? AND b.owner_id = ?`,
    )
      .bind(taskId, c.get("ownerId"))
      .first<{ id: string; version: number; status: string; repository_id: string | null }>();
    if (!task) throw new HTTPException(404, { message: "Task not found" });
    if (!task.repository_id) throw new HTTPException(409, { message: "Task must reference a Repository Workspace" });
    try {
      const result = await replaceTaskAssignment(d1TaskAssignmentRepository(c.env.DB), {
        ownerId: c.get("ownerId"),
        taskId,
        assigneeActorId: LOCAL_AGENT_ID,
        assignedByActorId: LOCAL_AGENT_ID,
        authorizationSubjectId: "offline-user",
        expectedTaskVersion: task.version,
      });
      return c.json({ taskId, repositoryId: task.repository_id, runId: result.version }, 202);
    } catch (error) {
      if (error instanceof Error && error.message.includes("not available")) throw new HTTPException(409, { message: error.message });
      throw error;
    }
  });

  api.post("/api/offline/tasks/:taskId/run", authorizeScope("task:write"), (c) => {
    if (!isOfflineMode(c)) throw new HTTPException(404, { message: "Not found" });
    return runOfflineTask(c);
  });
  api.post("/api/offline/tasks/:taskId/continue", authorizeScope("task:write"), (c) => {
    if (!isOfflineMode(c)) throw new HTTPException(404, { message: "Not found" });
    return continueOfflineTask(c);
  });
}
