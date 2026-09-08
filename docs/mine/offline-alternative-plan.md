# Offline alternative architecture plan

Status: proposed

This plan supersedes the removal direction discussed after
`prime-agent-workspaces.md`. It does not remove Realmroot, Enbor, Cloudflare, or
GitHub from hosted production.

## Decision

Keep two explicit compositions of the same Agent Kanban product:

```text
Hosted production
Browser -> Cloudflare Worker -> D1
                         +----> Realmroot
                         +----> Enbor Sessions and Runners
                         +----> GitHub App

Offline localhost
Browser -> local Node server -> local SQLite
                            +-> local Prime Agent process
```

Future SSH execution extends the offline executor transport:

```text
Offline controller -> local process transport
                   -> future SSH transport -> remote Prime Agent
```

Hosted authentication and execution do not change when SSH is added.

The mode is selected once at process composition. Domain rules and application
use cases do not branch on `AK_OFFLINE_MODE`. HTTP routes use selected ports for
authentication, persistence, agent inventory, machine inventory, execution, and
observation.

## Why coexistence

Removing Realmroot would remove hosted Agent identity, tenancy, authorization,
DPoP, Toolbox access, profile discovery, and GitHub permission delegation.
Removing Enbor would remove hosted Agent configuration, scheduling, Sessions,
Runners, runtime provenance, recovery, and review continuation. Removing
Cloudflare would remove the production Worker, D1, static assets, and deployment
path.

None of those removals are needed to run one trusted localhost user and spawn
Prime Agent in a local directory. A strict offline branch is smaller and keeps
the deployed product intact.

## Mode contract

`AK_OFFLINE_MODE=true` means all of the following:

- the request URL and configured public origin are loopback;
- the API runs in the local Node composition, not a Cloudflare Worker;
- one local administrator session replaces Realmroot browser login;
- local SQLite replaces D1 for that process;
- local Agents, Machines, and Workspaces replace Enbor projections;
- Task execution starts Prime Agent through a local process transport;
- Prime Agent RPC events replace Enbor Session observation;
- no Realmroot, Enbor, GitHub App, or other hosted API is called.

Any mismatch fails startup. It must not silently fall back to hosted services.

Hosted mode means:

- the existing Cloudflare Worker and D1 composition remains authoritative;
- Realmroot OIDC, DPoP, scopes, identity, and token exchange remain active;
- Enbor Agents, Machines, Sessions, and Runners remain active;
- GitHub App setup, permission grants, repository bootstrap, and webhooks remain
  active;
- Prime Agent local process execution is unavailable.

`AK_OFFLINE_MODE` is never accepted from an HTTP request. It is process
configuration only.

## Shared model

### Boards and Tasks

Boards, labels, Tasks, dependencies, Notes, review rules, version CAS, and Task
statuses stay shared. The same domain behavior runs in both modes.

```text
todo -> in_progress -> in_review -> done
  +-------------------------------> cancelled
```

Hosted assignment keeps its current Enbor dispatch behavior. Offline trigger
creates a local Task Run and starts Prime Agent. A hosted Task and an offline
Task never share one database, so runtime-specific identifiers cannot cross
modes accidentally.

### Repository and Workspace

Repository remains the logical source identity. Workspace is a physical checkout
of a Repository on a Machine:

```text
Board
  +-- Task A -> Repository A
  +-- Task B -> Repository B

Machine
  +-- Workspace A -> Repository A -> /work/api
  +-- Workspace B -> Repository B -> /work/web
```

Every offline runnable Task must have `repository_id`. The scheduler selects an
idle Workspace with the same Repository. The Board is not a directory and no
new Project resource is needed.

Hosted mode continues using the Repository URL and Enbor Git volume bootstrap.
Offline mode uses the Workspace's existing directory and does not mint a GitHub
App token or clone automatically.

### Machine

Machine has one product representation but different sources:

- hosted: projected Enbor self-hosted Environment plus Runners;
- offline: an AK-owned local Machine with process execution capability;
- future offline: an AK-owned SSH Machine using the same executor transport
  interface.

The first offline release creates exactly one local Machine automatically. Do
not add SSH fields or UI until SSH execution is implemented.

### Agent

Agent also has different sources:

- hosted: authoritative Enbor Agent bound to a Realmroot identity;
- offline: one built-in local Prime Agent identity.

Offline assignment stores the local Agent ID. It does not create Realmroot or
Enbor identities. Hosted assignment continues storing the Realmroot subject and
validating signed runtime provenance.

## Composition boundaries

Introduce narrow ports only where the two modes genuinely differ. Do not create
interfaces around shared deterministic logic or one-off helpers.

```text
AppServices
- auth
- database
- agents
- machines
- workspaces
- taskExecutor
- sessionObserver
- repositoryBootstrap
- assets
```

Expected implementations:

| Port | Hosted | Offline |
| --- | --- | --- |
| auth | Realmroot OIDC/DPoP | loopback local session |
| database | Cloudflare D1 | Node SQLite |
| agents | Enbor projections | built-in Prime Agent |
| machines | Enbor Environment/Runner projections | local Machine |
| workspaces | Enbor Git volume preparation | local directory records |
| taskExecutor | Enbor Session dispatcher | Prime Agent RPC process |
| sessionObserver | Enbor WebSocket relay | stored RPC events plus SSE |
| repositoryBootstrap | GitHub App token plus Enbor Vault | existing directory |
| assets | Cloudflare ASSETS | filesystem `dist/` |

Mode selection belongs in `server/worker/index.ts` and the new local Node entry.
Routes should receive or read the composed service rather than repeatedly test
`AK_OFFLINE_MODE`.

## Realmroot usage and offline alternatives

### Browser authentication

Hosted use:

- `server/auth/realmroot.ts` performs OIDC discovery, authorization-code/PKCE
  login, callback, logout, session storage, refresh, and JWT validation.
- `server/auth/middleware.ts` selects cookie or DPoP bearer authentication,
  provisions token principals, enforces scopes, and applies CSRF.
- `server/http/auth/routes.ts` exposes login, callback, session, and logout.
- `src/lib/auth-client.ts` and `src/features/auth/` present the hosted session.

Offline alternative:

- retain the current loopback-only opaque session behavior from
  `server/auth/offline.ts`;
- make it independent of `server/auth/realmroot.ts` types and helpers;
- use one fixed local tenant, user, and administrator role;
- keep HttpOnly cookies, hashed tokens, CSRF, and expiry;
- auto-create the local session when the browser first asks for it;
- hide hosted login, account, organization, and logout-redirect UI.

Do not accept arbitrary bearer identities offline. The local Prime Agent process
is controlled by the server and does not need a general API token.

### Tenancy and authorization

Hosted use:

- Realmroot tenant and subject claims select `ownerId`;
- scope middleware protects Board, Repository, Task, Agent, and Machine routes;
- controller/Agent actor chains decide assignment, claim, and review authority.

Offline alternative:

- use constant tenant `offline` and subject `offline-user`;
- grant the local administrator the existing application scopes internally;
- preserve the assignee self-review rule by distinguishing the built-in local
  Agent actor from the local human actor;
- never bypass Task version, dependency, review, or cancellation checks.

Rename shared application types to neutral names where Realmroot terminology
leaks into domain logic. Hosted adapters may continue using Realmroot-specific
wire types.

### Agent identity and profiles

Hosted use:

- `server/http/agents/` and `server/usecases/agents/` create and read Enbor
  Agents and Realmroot identities;
- `server/adapters/realmroot/agentPermissions.ts` grants GitHub permissions;
- `src/features/agent-identity/` discovers public Realmroot Agent profiles.

Offline alternative:

- return one stable built-in Agent such as `local-prime-agent`;
- use a local display name and existing identicon fallback;
- report runtime `prime-agent` and schedulability from local executable health;
- skip identity creation, public profile discovery, and permission grants;
- keep Agent list/detail UI only if it helps show local runtime health and Tasks.

### Token exchange and downstream authority

Hosted use:

- `server/adapters/realmroot/delegatedAgencyToken.ts` stores user grants,
  refreshes tokens, and performs token exchange for Enbor;
- Agent permissions exchange authority for GitHub;
- webhook dispatch reuses stored user authorization.

Offline alternative:

- none; local execution calls no Realmroot or Enbor service;
- local Git operations use the user's existing checkout credentials through
  Prime Agent;
- GitHub App setup and webhook-triggered completion are disabled offline;
- do not read or write grant, refresh lease, DPoP replay, or token-exchange data.

### Toolbox and Resource Server

Hosted use:

- `server/http/resource-server/routes.ts` publishes protected-resource metadata,
  Realmroot security declarations, Toolbox OpenAPI, and Agent Skills;
- `skills/` instruct Agents to operate Tasks through `realmroot toolbox`.

Offline alternative:

- do not publish Realmroot protected-resource metadata;
- keep a plain local OpenAPI document only if useful to the browser or local
  automation;
- the Prime Agent process receives the full Task prompt over RPC and the
  controller performs state transitions from execution events;
- a future direct callback uses a per-Run opaque token, not OAuth or DPoP;
- hosted Skill archives remain built and published for production.

## Enbor usage and offline alternatives

### Project binding

Hosted use:

- `server/usecases/agency/ensureAgencyProject.ts` and
  `server/adapters/d1/agencyProjectBinding.ts` map each tenant to Enbor's
  `Agent Kanban` Project.

Offline alternative:

- no Project binding;
- local tenant owns its local Agent, Machine, Workspaces, and Runs directly;
- Repository is the logical project and Workspace is the execution directory.

### Agent and Machine projections

Hosted use:

- `server/usecases/agents/projectAgents.ts` and Agent routes call Enbor;
- `server/usecases/machines/projectMachines.ts` and Machine routes project
  Environments and Runners;
- Machine UI displays runner runtime inventory and usage windows.

Offline alternative:

- local Agent projection checks `prime-agent --version`;
- local Machine projection reports controller hostname, process transport,
  Prime Agent availability, and Workspace count;
- runtime quota/usage windows are absent unless Prime Agent RPC reports them;
- offline UI labels the source clearly instead of imitating Enbor Runner state.

### Session dispatch

Hosted use:

- Task assignment stores a durable launch intent;
- `server/http/tasks/dispatchAssignedTask.ts` exchanges authority;
- `prepareTaskLaunch.ts` resolves the Enbor Agent and Git volume;
- `dispatchTaskLaunches.ts` creates the exact Enbor Session idempotently;
- D1 launch metadata tracks request, response, leases, and cleanup.

Offline alternative:

- triggering or assigning a Task creates an offline Task Run;
- the scheduler selects one matching idle Workspace;
- the local executor spawns `prime-agent --mode rpc --cwd <path>`;
- it sends `get_state`, stores the exact Prime Agent Session ID, then prompts;
- process state and trace sequence are stored in SQLite;
- no Enbor request, Project ID, Vault, secret reference, or bootstrap token is
  created.

Keep hosted launch code unchanged behind the hosted executor adapter. Do not add
Prime Agent cases to Enbor request construction.

### Claim and provenance

Hosted use:

- Realmroot signs the Agent runtime and Enbor Session binding;
- Claim accepts no client-written Session ID and verifies the exact launched
  Enbor Session.

Offline alternative:

- the server owns the child process and learns Session ID from `get_state`;
- it creates the offline Claim internally after the Session ID is durable;
- browser JSON cannot supply or replace the Session ID;
- Task Run ID, Workspace ID, process identity, and Prime Session ID form local
  provenance;
- preserve one active Claim and exact-Session conflict behavior.

### Observation and review continuation

Hosted use:

- Session observation resolves the exact Enbor Session;
- `server/http/tasks/resourceRoutes.ts` proxies its WebSocket read-only;
- review rejection sends feedback to the same Enbor Session.

Offline alternative:

- parse LF-delimited Prime Agent RPC stdout;
- store bounded normalized events with unique `(run_id, sequence)`;
- expose history and live updates through HTTP/SSE;
- retain the full JSONL Session in Prime Agent's normal local session directory;
- on rejection, resume the stored Session and send feedback through RPC;
- never infer the latest Session from Agent, Repository, or directory.

### Cancellation and cleanup

Hosted use:

- close the exact Enbor Session before revoking GitHub bootstrap credentials.

Offline alternative:

- send RPC `abort`;
- wait for bounded graceful exit, then terminate the child process if needed;
- release the Workspace only after process exit is confirmed;
- no Vault credential cleanup is needed.

## Cloudflare usage and offline alternatives

### HTTP runtime

Hosted use:

- `server/worker/index.ts` calls `api.fetch(request, env)`;
- Worker Fetch APIs host Hono.

Offline alternative:

- add a Node entry that builds the offline services and runs the same Hono app;
- use the official Hono Node adapter for request abort, streaming, and SSE;
- bind to `127.0.0.1` by default;
- supervise Prime Agent child processes in the Node process.

The Worker entry stays. The Node entry is additional, not a replacement.

### Database

Hosted use:

- `wrangler.toml` binds D1 as `Env.DB`;
- adapters call D1's `prepare/bind/first/all/run/batch` surface;
- Wrangler applies ordered SQL migrations.

Offline alternative:

- use Node 24 `node:sqlite` with a project-owned D1-shaped compatibility adapter;
- preserve `prepare().bind().first/all/run` and atomic `batch` while existing
  repositories are shared;
- enable foreign keys, WAL, busy timeout, and explicit transactions;
- store the file at `AK_OFFLINE_DB`, default `.data/agent-kanban.sqlite`;
- apply the same compatible migrations with a local migration ledger;
- add offline-only Workspace, Task Run, and trace tables in forward migrations.

<!-- ponytail: node:sqlite is sufficient for one localhost controller; use a stable external driver only if Node API churn or measured write contention requires it. -->

D1 remains the hosted implementation. Do not make Worker code import Node
built-ins.

### Static assets

Hosted use:

- Cloudflare `ASSETS` serves the built SPA and supplies `index.html` to public
  share metadata rendering.

Offline alternative:

- serve `dist/` from the local filesystem with contained normalized paths;
- use `dist/index.html` as SPA fallback;
- read and cache `index.html` directly when metadata rendering needs it;
- do not expose files outside `dist`.

### Development and configuration

Hosted use:

- `@cloudflare/vite-plugin`, Wrangler, `.dev.vars`, and Miniflare provide Worker,
  D1, bindings, and assets locally.

Offline alternative:

- add `pnpm dev:offline` for the Node API plus plain Vite proxy;
- add `pnpm start:offline` for built assets, SQLite, scheduler, and executor;
- add `pnpm db:migrate:offline` for the local SQLite file;
- keep current hosted `pnpm dev`, build, deploy, and Wrangler migration scripts;
- load offline configuration from `.env` without hosted secrets;
- provide safe `.env.example` values and never commit machine paths or secrets.

### Tests

Hosted tests continue using Miniflare and D1. Add offline projects using temporary
SQLite files and a fake Prime Agent RPC process. Shared domain/use-case tests run
once unless an adapter contract differs.

Do not replace hosted tests with offline tests. Both compositions must remain
covered.

## GitHub usage and offline alternatives

Hosted mode keeps:

- App installation and repository import;
- repository-scoped bootstrap tokens;
- permission grants;
- pull request webhooks and dependent Task dispatch.

Offline mode:

- allows manual Repository creation and Workspace directory selection;
- marks GitHub App controls unavailable with a clear hosted-only explanation;
- does not call GitHub during startup, repository reads, assignment, execution,
  or review;
- lets Prime Agent use Git and any credentials already configured in the
  Workspace;
- accepts a PR URL as result metadata but does not verify it by webhook.

## Offline persistence schema

Add only the offline state not already represented by shared tables:

```sql
CREATE TABLE offline_machines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('local', 'ssh')),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE offline_workspaces (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES offline_machines(id),
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  name TEXT NOT NULL,
  cwd TEXT NOT NULL,
  canonical_cwd TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(machine_id, canonical_cwd)
);

CREATE TABLE offline_task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  workspace_id TEXT REFERENCES offline_workspaces(id),
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  prime_session_id TEXT,
  session_ref TEXT,
  process_started_at TEXT,
  heartbeat_at TEXT,
  finished_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, attempt)
);

CREATE UNIQUE INDEX offline_one_active_run_per_workspace
ON offline_task_runs(workspace_id)
WHERE status IN ('starting', 'running');

CREATE TABLE offline_run_events (
  run_id TEXT NOT NULL REFERENCES offline_task_runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(run_id, sequence)
);
```

Final names should omit `offline_` if the tables will also support future SSH.
Keep the prefix during the first additive migration if it prevents collision
with hosted legacy tables.

## Offline execution details

### Workspace selection

For the first release:

1. require `repository_id` on a runnable Task;
2. find enabled Workspaces for that Repository;
3. validate that their local Machine and directory are healthy;
4. exclude Workspaces with `starting` or `running` Runs;
5. choose least recently used, then stable ID;
6. atomically reserve it in SQLite;
7. leave the Run queued with an actionable reason if none is available.

No priority, preemption, auto-clone, or multiple concurrent Tasks per directory.

### Local process lock

SQLite enforces one active Run per Workspace. Also take an atomic filesystem lock
based on `realpath(cwd)` before spawning Prime Agent. Store lock owner Run ID and
process ID. On restart, inspect the process and exact Session before considering
the lock stale.

The filesystem lock is required because a second local controller process could
open the same SQLite file or use a different one.

### Prime Agent RPC

Start:

```sh
prime-agent --mode rpc --cwd /absolute/workspace/path
```

Pass executable and arguments separately to `spawn`; never build a shell command.
Task text is sent in RPC JSON, not command arguments. Split stdout records only
on LF, bound record size, validate JSON shape, and treat stderr as diagnostics.

Persist `get_state.sessionId` before sending the Task prompt. Normalize only
useful trace events and truncate large tool output. On successful completion,
move Task to `in_review`; never directly accept the work.

Review rejection resumes the exact stored Session. If it is missing or corrupt,
mark the Run failed and require an explicit new attempt instead of starting an
unrelated Session silently.

## Failure behavior

| Failure | Offline behavior | Hosted behavior |
| --- | --- | --- |
| Prime Agent missing | Workspace unhealthy; do not start | unchanged Enbor scheduling |
| directory missing | Workspace unhealthy; queue Task | unchanged Git volume preparation |
| process exits before Session ID | fail Run, keep Task actionable | unchanged launch recovery |
| malformed RPC event | fail or skip by documented severity; record diagnostic | unchanged Enbor relay |
| controller restarts | reconcile PID, lock, Run, and exact Session | unchanged D1/Enbor recovery |
| review Session missing | explicit failed continuation | unchanged Enbor continuation |
| GitHub unavailable | irrelevant; no offline call | existing hosted error handling |
| Realmroot unavailable | irrelevant; no offline call | existing hosted error handling |
| invalid offline public origin | refuse startup | offline branch not selected |

No offline failure may trigger a hosted fallback. No hosted failure may trigger a
local Prime Agent process.

## File-level change map

### Composition

- Refactor `server/http/app.ts` to create the Hono app from composed services.
- Keep `server/worker/index.ts` as the hosted composition.
- Add `server/node/index.ts` as the offline composition.
- Split `server/env.ts` into shared app configuration plus hosted Worker bindings
  and offline Node configuration.

### Authentication

- Extract neutral session/CSRF helpers from `server/auth/realmroot.ts`.
- Keep hosted Realmroot authentication in its adapter.
- Make `server/auth/offline.ts` a complete local adapter with no Realmroot import.
- Have `server/auth/middleware.ts` delegate to the composed auth service.
- Make `server/http/auth/routes.ts` expose mode-appropriate routes without
  contacting hosted discovery offline.
- Update auth and Header components to use capabilities returned by session API.

### Persistence

- Replace the direct `D1Database` alias in `server/db/index.ts` with the shared
  database contract.
- Add hosted D1 and offline SQLite implementations.
- Keep `server/adapters/d1/` while both implementations support its surface;
  rename only if the name becomes materially confusing.
- Add local migration and explicit temporary SQLite test helpers.

### Agents and Machines

- Put existing Enbor logic behind hosted Agent and Machine providers.
- Add one offline Prime Agent provider and one local Machine provider.
- Add Workspace storage/routes/UI only in offline capabilities initially.
- Make representations declare capabilities instead of fabricating Enbor fields
  offline.

### Tasks and execution

- Put current `dispatchAssignedTask.ts` Enbor flow behind hosted executor.
- Add offline Task Run repository, scheduler, process lock, and Prime RPC client.
- Select executor once from composed services.
- Keep shared lifecycle use cases and CAS repositories.
- Add internal offline Claim creation from the server-observed Session.
- Route review rejection and cancellation through the selected executor.

### Observation

- Keep hosted Enbor WebSocket observation.
- Add offline stored event history plus SSE.
- Select the observer from Run provenance, never from a request flag.
- Update `ChatPanel` and activity components to consume one normalized event
  representation.

### GitHub and resources

- Keep hosted GitHub and Resource Server routes registered in hosted mode.
- Do not register GitHub webhook/setup and Realmroot discovery routes offline.
- Return explicit capability data so the UI hides hosted-only actions offline.
- Keep generated hosted Agent Skills unchanged until an offline Prime skill is
  actually needed.

### Tooling

- Keep Wrangler, Miniflare, Cloudflare Vite plugin, Worker types, and deploy
  scripts for hosted mode.
- Add Node server adapter and offline scripts.
- Do not load `node:sqlite`, `node:child_process`, or filesystem modules into the
  Worker bundle; enforce this with a structure test.
- Keep `.dev.vars` for hosted Worker development and `.env` for offline local
  development.

## Delivery phases

### Phase 0: specify the mode boundary

Add scenarios for:

- hosted mode retaining Realmroot, Enbor, D1, and GitHub behavior;
- offline startup making no hosted requests;
- refusal of non-loopback offline configuration;
- mode-specific capabilities in the browser;
- local Workspace execution and trace;
- one active Task per directory;
- exact Session review continuation and crash recovery.

Add an ADR that makes coexistence and no-fallback behavior explicit.

Gate: every changed behavior has a scenario and hosted behavior is stated as a
regression constraint.

### Phase 1: composition and database seam

1. Introduce the shared DB contract from the D1 methods already used.
2. Keep D1 as the hosted implementation.
3. Add Node SQLite implementation and migration runner.
4. Refactor app construction to receive services.
5. Add Node HTTP/static entry without Task execution.
6. Add a structure test preventing Node imports from the Worker graph.

Gate: hosted tests and build pass unchanged; offline Node serves Board CRUD from
a persistent SQLite file.

### Phase 2: complete local authentication

1. Decouple offline sessions from Realmroot implementation code.
2. Enforce loopback Host, Origin, and configured public origin.
3. Keep cookie, token hash, expiry, and CSRF protections.
4. Add session capabilities such as `hostedAuth`, `github`, `toolbox`, and
   `localExecution`.
5. Hide or replace hosted account controls offline.

Gate: offline browser CRUD works without any network request; hosted OIDC E2E
continues passing.

### Phase 3: offline Agent, Machine, and Workspace

1. Add built-in Prime Agent projection.
2. Add the local Machine record.
3. Add Workspace schema and CRUD.
4. Validate `realpath`, read/write access, and Prime Agent availability.
5. Route Tasks to Workspaces by Repository.
6. Add focused offline UI while preserving hosted Machine pages.

Gate: one Board can contain Tasks routed to different directories; hosted Enbor
projection tests remain unchanged.

### Phase 4: offline Task Runs

1. Add Run and event schema.
2. Add explicit trigger/retry/cancel operations offline.
3. Add atomic idle-Workspace selection.
4. Add filesystem locking and startup reconciliation.
5. Create local Claims from server-owned Run provenance.

Gate: concurrent tests prove one active Run per canonical directory and parallel
execution across distinct directories.

### Phase 5: Prime Agent execution and observation

1. Implement bounded LF-delimited RPC client.
2. Spawn Prime Agent without a shell.
3. Persist exact Session before prompt.
4. Normalize and persist trace events.
5. Expose offline history and SSE.
6. Submit success for review, report failure, abort cancellation, and resume the
   exact Session after rejection.

Gate: a real local acceptance journey reaches `in_review`, displays trace,
resumes after rejection, and completes only after human acceptance.

### Phase 6: hard separation and regression

1. Add network-denied offline integration and E2E runs.
2. Assert no offline request reaches Realmroot, Enbor, or GitHub.
3. Assert Worker bundle has no Node-only runtime imports.
4. Run hosted contract, integration, build, and E2E suites.
5. Update README, architecture, setup, and operations documentation.

Gate: both compositions pass independently from a clean checkout.

### Future phase: SSH transport

1. Add SSH Machine fields and strict host-key validation.
2. Implement `SshPrimeAgentTransport` behind the existing executor transport.
3. Move Workspace path validation and locking to the remote host.
4. Carry RPC over SSH stdin/stdout with stderr separate.
5. Add disconnect reconciliation before releasing a remote Workspace.

Do not change hosted Realmroot authentication, Enbor execution, or Cloudflare
composition for SSH support.

## Test plan

### Shared regression

- Board, Repository, Task, dependency, Note, review, pagination, idempotency, and
  CAS tests run against shared use cases.
- Hosted D1/Realmroot/Enbor/GitHub tests remain in their current projects.

### Offline adapter tests

- SQLite adapter matches required D1-shaped semantics, including atomic batch;
- local migration ledger is idempotent and rejects changed migration digests;
- offline auth rejects non-loopback and cross-origin writes;
- Workspace validation rejects missing, duplicate, and unwritable directories;
- scheduler chooses only matching idle Workspaces;
- process spawning never invokes a shell;
- RPC framing handles split records, multiple records, CRLF input, malformed
  JSON, Unicode separators inside JSON, and oversized records;
- trace sequence replay is idempotent;
- stale processes and locks are reconciled before reuse;
- rejection resumes exact Session; missing Session fails explicitly.

### Cross-mode tests

- hosted composition never selects local auth or process executor;
- offline composition never constructs Realmroot, Enbor, GitHub, D1, or ASSETS
  clients;
- offline failure never falls back to hosted execution;
- hosted failure never spawns Prime Agent;
- mode-specific routes and UI controls match advertised capabilities.

## Configuration

Hosted configuration remains in `wrangler.toml` and `.dev.vars`.

Offline `.env` needs only safe local values:

```dotenv
AK_OFFLINE_MODE=true
AK_PUBLIC_ORIGIN=http://127.0.0.1:6265
AK_OFFLINE_DB=.data/agent-kanban.sqlite
AK_OFFLINE_HOST=127.0.0.1
AK_OFFLINE_PORT=6265
PRIME_AGENT_BIN=prime-agent
```

Workspace directories are user data stored through the local UI or SQLite, not
committed environment variables. Offline startup ignores hosted secrets even if
they exist in the parent environment.

## Acceptance checklist

- [ ] Hosted Worker still deploys with Cloudflare and D1.
- [ ] Hosted browser login still uses Realmroot.
- [ ] Hosted Agent permissions and GitHub integration still work.
- [ ] Hosted assignment still creates and observes exact Enbor Sessions.
- [ ] Offline starts with one local Node command and SQLite file.
- [ ] Offline refuses non-loopback configuration.
- [ ] Offline starts and operates without Realmroot, Enbor, GitHub, or Cloudflare
      network access.
- [ ] Offline exposes one local Prime Agent and local Machine.
- [ ] Offline Workspaces map Repositories to canonical directories.
- [ ] Tasks on one Board can route to different Workspaces.
- [ ] Only one active Task uses a canonical directory at a time.
- [ ] Prime Agent Session ID and normalized trace are stored.
- [ ] Review rejection resumes the exact Prime Agent Session.
- [ ] Cancellation confirms process shutdown before Workspace reuse.
- [ ] Offline failures never fall back to hosted services.
- [ ] Worker bundle contains no Node-only offline code.
- [ ] Shared, hosted, offline, and cross-mode checks pass from a clean checkout.
