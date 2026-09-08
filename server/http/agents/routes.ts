import type { RuntimeName } from "@realmroot/enbor-sdk";
import { createAgentPermissionGateway } from "@server/adapters/realmroot/agentPermissions";
import { delegatedResourceToken } from "@server/adapters/realmroot/delegatedAgencyToken";
import { authorizeScope } from "@server/auth/middleware";
import { isOfflineMode } from "@server/auth/offline";
import type { Env } from "@server/env";
import { agentRepresentation } from "@server/http/agents/representation";
import { idempotencyMiddleware } from "@server/http/middleware/idempotency";
import { agencyDependencies } from "@server/http/resource-server/agencyDependencies";
import { externalPageResponse, readExternalPage } from "@server/http/resource-server/externalPagination";
import { representationEtag } from "@server/http/resource-server/representation";
import {
  assertResourceWriteFields,
  completeExternalCreation,
  externalCreationIdempotencyKey,
  readJsonBody,
} from "@server/http/resource-server/request";
import { executorHealth, LOCAL_AGENT_ID, localAgent } from "@server/offline/executor";
import { grantDefaultAgentPermissions } from "@server/usecases/agents/defaultPermissions";
import { createAgencyAgent } from "@server/usecases/agents/projectAgents";
import { AGENCY_RUNTIMES } from "@shared";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

export function registerAgentRoutes(api: Hono<{ Bindings: Env }>): void {
  api.post("/api/agents", authorizeScope("agent:write"), idempotencyMiddleware, async (c) => {
    const body = await readJsonBody<Record<string, unknown>>(c);
    if (body instanceof Response) return body;
    assertResourceWriteFields(body, new Set(["name", "description", "username", "runtime", "systemPrompt", "provider", "model", "skills"]), "Agent");
    const name = requiredString(body.name, "Agent.name", 160);
    const username = requiredString(body.username, "Agent.username", 80);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(username)) throw new HTTPException(422, { message: "Agent.username is invalid" });
    const runtime = requiredString(body.runtime, "Agent.runtime", 60) as RuntimeName;
    if (!AGENCY_RUNTIMES.includes(runtime as (typeof AGENCY_RUNTIMES)[number])) {
      throw new HTTPException(422, { message: "Agent.runtime is unsupported" });
    }
    const systemPrompt = requiredString(body.systemPrompt, "Agent.systemPrompt", 8_000);
    const description = optionalNullableString(body.description, "Agent.description", 1_000);
    const provider = optionalNullableString(body.provider, "Agent.provider", 160);
    const model = optionalNullableString(body.model, "Agent.model", 200);
    const skills = optionalStringArray(body.skills, "Agent.skills");
    const idempotencyKey = externalCreationIdempotencyKey(c);
    const principal = c.get("principal");
    const platformResource = new URL("/api", c.env.OIDC_ISSUER).toString();
    const permissionToken = await delegatedResourceToken(c.env, {
      user: { tenantId: principal.tenantId, subjectId: principal.subjectId },
      resource: platformResource,
      scopes: ["agents:write"],
    });
    const { client } = await agencyDependencies(c, ["identities:write", "agents:write"]);
    const agent = await createAgencyAgent(
      client,
      {
        name,
        username,
        runtime,
        systemPrompt,
        description,
        provider,
        model,
        skills,
        idempotencyKey,
      },
      createAgentPermissionGateway(platformResource, permissionToken),
      c.env.GITHUB_RESOURCE,
    );
    const represented = agentRepresentation(agent, c.req.url);
    const etag = await representationEtag(represented);
    await completeExternalCreation(c, "agents", agent.metadata.uid, etag.slice(1, -1), represented);
    c.header("Location", new URL(`/api/agents/${encodeURIComponent(agent.metadata.uid)}`, c.req.url).toString());
    c.header("ETag", etag);
    return c.json(represented, 201);
  });

  api.post("/api/agents/:agentId/permissions", authorizeScope("agent:write"), async (c) => {
    const body = await readJsonBody<Record<string, unknown>>(c);
    if (body instanceof Response) return body;
    assertResourceWriteFields(body, new Set(), "Agent permissions");
    const { client } = await agencyDependencies(c, ["agents:read"]);
    const agent = await client.agents.get(c.req.param("agentId")!);
    if (!agent.spec.identity?.agentId) {
      throw new HTTPException(409, { message: "Agent has no bound Realmroot identity" });
    }
    const principal = c.get("principal");
    const platformResource = new URL("/api", c.env.OIDC_ISSUER).toString();
    const permissionToken = await delegatedResourceToken(c.env, {
      user: { tenantId: principal.tenantId, subjectId: principal.subjectId },
      resource: platformResource,
      scopes: ["agents:write"],
    });
    try {
      await grantDefaultAgentPermissions(createAgentPermissionGateway(platformResource, permissionToken), agent.spec.identity.agentId, {
        githubResource: c.env.GITHUB_RESOURCE,
      });
    } catch (cause) {
      throw new HTTPException(502, {
        message: `Agent permission configuration failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      });
    }
    return c.body(null, 204);
  });

  api.get("/api/agents", authorizeScope("agent:read"), async (c) => {
    const page = await readExternalPage(c);
    if (page instanceof Response) return page;
    const schedulable = optionalBoolean(c.req.query("schedulable"));
    const runtime = optionalRuntime(c.req.query("runtime"));
    const search = optionalBoundedString(c.req.query("search"), "search", 160);
    if (isOfflineMode(c)) {
      const online = (await executorHealth(c.env))?.online === true;
      const agent = localAgent(c.req.url, online);
      const matches =
        (!search || `${agent.name} ${agent.username}`.toLowerCase().includes(search.toLowerCase())) &&
        (!runtime || runtime === agent.runtime) &&
        (schedulable === undefined || schedulable === agent.schedulable);
      return externalPageResponse(c, matches && !page.sourceCursor ? [agent] : [], null);
    }
    const { client } = await agencyDependencies(c, ["agents:read"]);
    const result = await client.agents.list({
      limit: page.pageSize,
      cursor: page.sourceCursor ?? undefined,
      runtime,
      schedulable: schedulable === undefined ? undefined : (String(schedulable) as "true" | "false"),
      search,
    });
    return externalPageResponse(
      c,
      result.data.map((agent) => agentRepresentation(agent, c.req.url)),
      result.pagination.nextCursor,
    );
  });

  api.get("/api/agents/:agentId", authorizeScope("agent:read"), async (c) => {
    if (isOfflineMode(c)) {
      if (c.req.param("agentId") !== LOCAL_AGENT_ID) throw new HTTPException(404, { message: "Agent not found" });
      const represented = localAgent(c.req.url, (await executorHealth(c.env))?.online === true);
      c.header("ETag", await representationEtag(represented));
      return c.json(represented);
    }
    const { client } = await agencyDependencies(c, ["agents:read"]);
    const agent = await client.agents.get(c.req.param("agentId")!);
    const represented = agentRepresentation(agent, c.req.url);
    c.header("ETag", await representationEtag(represented));
    return c.json(represented);
  });
}

function optionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new HTTPException(400, { message: "schedulable must be true or false" });
}

function optionalRuntime(value: string | undefined): RuntimeName | undefined {
  if (value === undefined) return undefined;
  if (!AGENCY_RUNTIMES.includes(value as (typeof AGENCY_RUNTIMES)[number])) {
    throw new HTTPException(400, { message: "runtime is unsupported" });
  }
  return value as RuntimeName;
}

function optionalBoundedString(value: string | undefined, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0 || value.length > max) {
    throw new HTTPException(400, { message: `${field} must contain between 1 and ${max} characters` });
  }
  return value;
}

function requiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new HTTPException(422, { message: `${field} must be a non-empty string of at most ${max} characters` });
  }
  return value.trim();
}

function optionalNullableString(value: unknown, field: string, max: number): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string" || value.length > max) throw new HTTPException(422, { message: `${field} is invalid` });
  return value;
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new HTTPException(422, { message: `${field} must be an array of non-empty strings` });
  }
  return value;
}
