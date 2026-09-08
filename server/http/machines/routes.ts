import { authorizeScope } from "@server/auth/middleware";
import type { Env } from "@server/env";
import { machineProvider } from "@server/http/machines/provider";
import { machineDetailRepresentation, machineRepresentation } from "@server/http/machines/representation";
import { idempotencyMiddleware } from "@server/http/middleware/idempotency";
import { externalPageResponse, readExternalPage } from "@server/http/resource-server/externalPagination";
import { representationEtag } from "@server/http/resource-server/representation";
import {
  completeExternalCreation,
  externalCreationIdempotencyKey,
  rejectRequestBody,
  setCreatedResourceHeaders,
} from "@server/http/resource-server/request";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

export function registerMachineRoutes(api: Hono<{ Bindings: Env }>): void {
  api.get("/api/machines", authorizeScope("machine:read"), async (c) => {
    const page = await readExternalPage(c);
    if (page instanceof Response) return page;
    const machines = await machineProvider(c);
    const result = await machines.list({ limit: page.pageSize, cursor: page.sourceCursor });
    return externalPageResponse(
      c,
      result.items.map((machine) => machineRepresentation(machine, c.req.url)),
      result.nextCursor,
    );
  });

  api.post("/api/machines", authorizeScope("machine:write"), idempotencyMiddleware, async (c) => {
    const bodyError = await rejectRequestBody(c, "Machine");
    if (bodyError) return bodyError;
    const machines = await machineProvider(c, ["environments:write"]);
    const idempotencyKey = externalCreationIdempotencyKey(c);
    const result = await machines.create(idempotencyKey);
    const commands = machines.commands(result.machine);
    const response = {
      machine: machineRepresentation(result.machine, c.req.url),
      authCommand: commands.authCommand,
      startCommand: result.setup.command || commands.startCommand,
    };
    const machineEtag = await representationEtag(response.machine);
    await completeExternalCreation(c, "machines", result.machine.environment.metadata.uid, machineEtag.slice(1, -1), response);
    setCreatedResourceHeaders(c, "machines", result.machine.environment.metadata.uid, machineEtag.slice(1, -1));
    return c.json(response, 201);
  });

  api.get("/api/machines/:machineId", authorizeScope("machine:read"), async (c) => {
    const machines = await machineProvider(c);
    const machine = await machines.get(c.req.param("machineId")!);
    if (!machine) throw new HTTPException(404, { message: "Machine not found" });
    const commands = machines.commands(machine);
    const represented = {
      ...machineDetailRepresentation(machine, c.req.url),
      authCommand: commands.authCommand,
      startCommand: commands.startCommand,
    };
    c.header("ETag", await representationEtag(represented));
    return c.json(represented);
  });

  api.delete("/api/machines/:machineId", authorizeScope("machine:write"), async (c) => {
    const machines = await machineProvider(c, ["environments:write"]);
    await machines.delete(c.req.param("machineId")!);
    return c.body(null, 204);
  });
}
