import { getTask } from "@server/adapters/d1/taskRepo";
import { d1TaskAssignmentRepository } from "@server/adapters/d1/tasks/d1TaskAssignments";
import type { Env } from "@server/env";
import { LOCAL_AGENT_ID, sendLocalMessage, startLocalRun } from "@server/offline/executor";
import { replaceTaskAssignment } from "@server/usecases/tasks/replaceTaskAssignment";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

export async function runOfflineTask(c: Context<{ Bindings: Env }>): Promise<Response> {
  const ownerId = c.get("ownerId");
  const taskId = c.req.param("taskId")!;
  let task = await getTask(c.env.DB, taskId, ownerId);
  if (!task) throw new HTTPException(404, { message: "Task not found" });
  if (task.assigned_to && task.assigned_to !== LOCAL_AGENT_ID) throw new HTTPException(409, { message: "Task is assigned to another Agent" });
  if (task.status !== "todo") throw new HTTPException(409, { message: `Task cannot run locally from ${task.status}` });

  const assignment = await replaceTaskAssignment(d1TaskAssignmentRepository(c.env.DB), {
    ownerId,
    taskId,
    assigneeActorId: LOCAL_AGENT_ID,
    assignedByActorId: c.get("principal").subjectId,
    authorizationSubjectId: c.get("principal").subjectId,
    expectedTaskVersion: task.version,
  });
  await removeAgencyLaunchIntent(c.env.DB, ownerId, taskId);
  task = (await getTask(c.env.DB, taskId, ownerId))!;
  await startLocalRun(c.env, {
    runId: assignment.version,
    taskId,
    ownerId,
    prompt: taskPrompt(task),
    repositoryId: task.repository_id,
    sessionName: task.title,
    taskNumber: task.seq,
  });
  return c.json({ runId: assignment.version, status: "running" }, 202);
}

async function removeAgencyLaunchIntent(db: D1Database, ownerId: string, taskId: string): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE tasks SET metadata = json_remove(metadata,
         '$."agent-kanban.dev/launch"', '$.annotations."agent-kanban.dev/session-id"')
       WHERE id = ? AND board_id IN (SELECT id FROM boards WHERE owner_id = ?)
         AND assigned_to = ? AND status = 'todo'`,
    )
    .bind(taskId, ownerId, LOCAL_AGENT_ID)
    .run();
  if (result.meta.changes !== 1) throw new Error("Local Task assignment changed before launch");
}

function taskPrompt(task: NonNullable<Awaited<ReturnType<typeof getTask>>>): string {
  return [
    `Work on Agent Kanban Task #${task.seq}: ${task.title}`,
    task.description
      ? `Description:
${task.description}`
      : "",
    task.input
      ? `Input:
${JSON.stringify(task.input, null, 2)}`
      : "",
    "Work directly in the configured repository. Validate your changes. Return a concise final summary for review.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function continueOfflineTask(c: Context<{ Bindings: Env }>): Promise<Response> {
  const ownerId = c.get("ownerId");
  const taskId = c.req.param("taskId")!;
  const task = await getTask(c.env.DB, taskId, ownerId);
  if (!task) throw new HTTPException(404, { message: "Task not found" });
  if (task.status !== "in_progress" || task.assigned_to !== LOCAL_AGENT_ID) {
    throw new HTTPException(409, { message: "Only an in-progress local Task can be continued" });
  }
  await sendLocalMessage(c.env, { taskId, prompt: "continue" });
  return c.json({ runId: task.session_binding?.runtime_session_id ?? task.id, status: "running" }, 202);
}
