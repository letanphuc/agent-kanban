import type { EnborClient, Environment, Runner } from "@realmroot/enbor-sdk";
import { isOfflineMode } from "@server/auth/offline";
import type { Env } from "@server/env";
import { agencyDependencies } from "@server/http/resource-server/agencyDependencies";
import { executorHealth, LOCAL_MACHINE_ID } from "@server/offline/executor";
import { createMachine, getMachine, listMachinesPage, type MachineProjection } from "@server/usecases/machines/projectMachines";
import type { MachineSetup } from "@shared";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

export type MachineProvider = {
  list(page: { limit: number; cursor: string | null }): Promise<{ items: MachineProjection[]; nextCursor: string | null }>;
  get(id: string): Promise<MachineProjection | null>;
  create(idempotencyKey: string): Promise<{ machine: MachineProjection; setup: MachineSetup }>;
  commands(machine: MachineProjection): { authCommand: string; startCommand: string };
  delete(id: string): Promise<void>;
};

export async function machineProvider(
  c: Context<{ Bindings: Env }>,
  scopes: readonly string[] = ["environments:read", "runners:read"],
): Promise<MachineProvider> {
  if (isOfflineMode(c)) return offlineProvider(c);
  const dependencies = await agencyDependencies(c, scopes);
  return productionProvider(dependencies.client, dependencies.projectId, c);
}

function productionProvider(client: EnborClient, projectId: string, c: Context<{ Bindings: Env }>): MachineProvider {
  return {
    list: (page) => listMachinesPage(client, page),
    get: (id) => getMachine(client, id),
    async create(idempotencyKey) {
      const result = await createMachine(
        client,
        projectId,
        idempotencyKey,
        (project, environment) =>
          `enbor-runner start --api-server ${quote(c.env.AGENCY_ORIGIN)} --project-id ${quote(project)} --environment-id ${quote(environment)} --allow-unsafe-process`,
      );
      return result;
    },
    commands(machine) {
      return {
        authCommand: `enbor-runner auth login --api-server ${quote(c.env.AGENCY_ORIGIN)}`,
        startCommand: machine
          ? `enbor-runner start --api-server ${quote(c.env.AGENCY_ORIGIN)} --project-id ${quote(projectId)} --environment-id ${quote(machine.environment.metadata.uid)} --allow-unsafe-process`
          : "",
      };
    },
    async delete(id) {
      await client.environments.delete(id);
    },
  };
}

async function offlineProvider(c: Context<{ Bindings: Env }>): Promise<MachineProvider> {
  const health = await executorHealth(c.env);
  const machine = offlineProjection(health?.online === true);
  return {
    list: async (page) => ({ items: page.cursor ? [] : [machine], nextCursor: null }),
    get: async (id) => (id === LOCAL_MACHINE_ID ? machine : null),
    async create() {
      throw new HTTPException(409, { message: "The local Machine is already configured" });
    },
    commands() {
      return { authCommand: "", startCommand: "" };
    },
    async delete(id) {
      if (id === LOCAL_MACHINE_ID) throw new HTTPException(409, { message: "The local Machine cannot be archived" });
      throw new HTTPException(404, { message: "Machine not found" });
    },
  };
}

function offlineProjection(online: boolean): MachineProjection {
  const now = "1970-01-01T00:00:00.000Z";
  const runtime = { runtime: "enbor", models: [], state: "ready" as const, detail: "Prime Agent" };
  const runner: Runner = {
    id: "offline-prime-agent-runner",
    projectId: "offline",
    name: "Prime Agent",
    environmentId: LOCAL_MACHINE_ID,
    secretRef: null,
    authMode: "realmroot",
    state: online ? "active" : "offline",
    currentLoad: 0,
    maxConcurrent: 1,
    runtimeUsage: [],
    runtimes: [runtime],
    metadata: {},
    lastHeartbeatAt: null,
    createdAt: now,
    updatedAt: now,
  };
  const environment: Environment = {
    metadata: {
      uid: LOCAL_MACHINE_ID,
      projectId: "offline",
      name: "This Computer",
      description: "Local Prime Agent process.",
      labels: {},
      annotations: {},
      createdBy: "offline-user",
      createdAt: now,
      updatedAt: now,
    },
    spec: {
      scope: "project",
      type: "self_hosted",
      networking: { type: "open", allowMcpServers: true, allowPackageManagers: true },
      packages: { type: "packages", apt: [], cargo: [], gem: [], go: [], npm: [], pip: [], webi: [] },
      variables: {},
    },
    status: { phase: "active", currentVersionId: null, version: 1 },
  };
  return { environment, runners: online ? [runner] : [] };
}

function quote(value: string | undefined): string {
  if (!value) throw new HTTPException(503, { message: "AGENCY_ORIGIN is required" });
  return `"${value.replace(/["$`]/g, "$&")}"`;
}
