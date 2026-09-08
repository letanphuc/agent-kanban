# Prime Agent workspace execution

Status: proposed

## Goal

Trigger an Agent Kanban Task in a persistent Prime Agent Session, stream its
execution back to the Task, and allow at most one active Task in each local
working directory.

A Board may contain Tasks for many repositories and directories. Routing is
therefore based on each Task's Repository, not directly on its Board.

## Model

```text
Board
  +-- Task A --> Repository A
  +-- Task B --> Repository B
  +-- Task C --> Repository A

Machine
  +-- Workspace 1 --> Repository A --> /work/api
  +-- Workspace 2 --> Repository B --> /work/web
```

The existing `board_repositories` relation says which Repositories may be used
by a Board. The existing `tasks.repository_id` says which source tree a Task
needs.

A Workspace is one machine-local checkout of one Repository:

```text
Workspace
- id
- machine_id
- repository_id
- name
- status: online | offline
```

The server stores the Workspace identity and Repository association. The local
runner stores the absolute directory because it is machine-specific and may be
sensitive:

```yaml
machineId: machine_123
workspaces:
  - id: workspace_api
    repositoryId: repository_api
    cwd: /Users/phuc/Work/api
  - id: workspace_web
    repositoryId: repository_web
    cwd: /Users/phuc/Work/web
```

Repository is the logical project. Workspace is its physical checkout. No new
Project resource is needed.

## Task routing

Triggering a Task creates a queued Task Run. Assignment may remain the trigger,
or a later explicit Run operation may create the same resource.

The scheduler:

1. Reads the Task's `repository_id`.
2. Finds an online Workspace registered for that Repository.
3. Excludes Workspaces with an active Run.
4. Atomically leases one eligible Workspace.
5. Returns the Task, Run, and fencing token to that Workspace's runner.

A Task without `repository_id` cannot run in the first version. This avoids an
ambiguous directory fallback. If several idle Workspaces serve the same
Repository, select the least recently used one with a stable ID tie-breaker.
Machine affinity can be added later if a real use case requires it.

## Task Run

Execution state is separate from Task lifecycle state:

```text
TaskRun
- id
- task_id
- workspace_id
- status: queued | leased | running | waiting_review | completed | failed | cancelled
- prime_session_id
- session_ref
- lease_token
- lease_expires_at
- last_event_seq
- created_at
- updated_at
```

`session_ref` is an opaque runner-owned reference. It must not expose an
absolute session-file path to browser clients.

Only one Run may actively own a Workspace:

```sql
CREATE UNIQUE INDEX one_active_run_per_workspace
ON task_runs(workspace_id)
WHERE status IN ('leased', 'running');
```

D1 provides the global scheduling constraint. The runner also takes an atomic
local lock against the canonical `realpath(cwd)` before starting Prime Agent.
The second lock prevents two runner processes on the same machine from using
the directory concurrently.

## Runner protocol

The runner is a long-lived process on the Machine. It authenticates to AK,
heartbeats its Workspaces, and long-polls for leases. A lease contains a short
expiry and a random fencing token. Every heartbeat, event batch, and state
update must carry that token. AK rejects updates from expired or replaced
leases.

After validating that the configured directory exists and remains under an
allowed local root, the runner starts:

```sh
prime-agent --mode rpc --cwd /Users/phuc/Work/api
```

The runner communicates through Prime Agent's LF-delimited JSON RPC protocol:

1. Send `get_state` and record `sessionId`.
2. Send the Task instructions with `prompt`.
3. Consume events from stdout without parsing terminal presentation text.
4. Batch normalized events to AK in monotonically increasing sequence order.
5. On review rejection, resume the same Session and send feedback as a new
   prompt or follow-up.
6. On cancellation, send `abort`, wait for shutdown, and release the local
   lock.

The initial prompt includes the Task ID, Task description, Repository identity,
and the requirement to work only inside the selected Workspace.

## Trace and Task updates

The full Prime Agent JSONL Session remains on its Machine. AK stores a bounded,
normalized trace suitable for live observation:

- turn started and completed
- assistant text
- tool name and bounded input summary
- tool result status and bounded output summary
- token and cost summary
- runtime errors

Each event has `(run_id, sequence)` uniqueness, making retried batches
idempotent. Large tool output is truncated before upload; full output remains in
the local Session.

Task lifecycle updates are driven by the runner, not inferred by the browser:

```text
Run starts                 -> Task in_progress
Prime Agent emits progress -> trace events and optional Task Notes
Prime Agent succeeds       -> Run waiting_review, Task in_review
Prime Agent fails          -> Run failed, Task remains in_progress with an error Note
Review rejected            -> resume same Run and Session, Task in_progress
Review accepted            -> Run completed, Task done, Workspace released
Task cancelled             -> abort Run, release Workspace, Task cancelled
```

A successful agent turn is not automatically accepted as completed work. It is
submitted for the existing independent review gate.

## Recovery

The runner heartbeats while Prime Agent is active. If the runner disappears,
the lease expires and the Run becomes recoverable.

Recovery must reuse the existing `prime_session_id` and `session_ref`; it must
not silently create a second Session. The same Machine can resume the Session
and reacquire the local directory lock. If the Session is unavailable, mark the
Run failed and require an explicit retry that creates a new Run.

An expired runner may still have a live child process. Its obsolete fencing
token prevents it from changing AK state, while the local directory lock blocks
a replacement process on that Machine until the old process exits or is safely
reconciled.

## Authentication boundary

The current AK Claim flow trusts Realmroot-signed Enbor Session provenance. A
Prime Agent process started directly by a new runner does not have that proof.
The integration must not weaken Claim validation or accept a client-supplied
Session ID.

Before replacing Enbor dispatch, define a runner credential that binds all of:

- tenant
- Machine and Workspace
- Task and Run
- Prime Agent Session ID
- lease fencing token and expiry

AK issues this binding only after leasing the Run. The runner presents it when
starting the Task and uploading events. This is a new execution authority
boundary and requires a dedicated ADR and threat review. Alternatively, Enbor
can add Prime Agent as a native runtime and preserve the existing signed Session
boundary.

## Minimal server operations

```text
POST /runner/workspaces/heartbeat
POST /runner/runs/acquire
POST /runner/runs/{runId}/heartbeat
POST /runner/runs/{runId}/session
POST /runner/runs/{runId}/events
POST /runner/runs/{runId}/finish
POST /runner/runs/{runId}/fail
```

All mutations are authenticated, scoped to the registered Machine, and fenced
by the current lease token. Event ingestion validates size, sequence, and event
type at the HTTP trust boundary.

## Delivery order

1. Specify Task Run lifecycle, Workspace leasing, recovery, and runner auth.
2. Add Workspace registration and local path configuration.
3. Add the atomic scheduler and one-active-Run database constraint.
4. Implement the runner with Prime Agent RPC and local directory locking.
5. Store normalized idempotent trace events and expose them through the existing
   Task activity surface.
6. Connect success, failure, cancellation, review rejection, and acceptance to
   the existing Task lifecycle.
7. Prove crash recovery, stale-token rejection, and one-Task-per-directory
   behavior before enabling automatic triggers.

## Acceptance criteria

- Tasks from one Board can route to different directories through their
  Repository associations.
- Triggering a Task starts one persistent Prime Agent Session in the matching
  Workspace.
- Two Tasks never execute concurrently in the same canonical directory.
- Separate Workspaces may execute concurrently.
- Trace events appear in order and retries do not duplicate them.
- Review rejection continues the exact Prime Agent Session.
- Runner restart either resumes that Session or reports an explicit failure.
- A stale or forged runner cannot update a Task or upload trace events.
