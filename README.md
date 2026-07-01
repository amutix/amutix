# amutix -- Coordination layer for AI agent teams

amutix is a local, file-backed coordination layer for AI coding agents.

It does **not** run the agents for you. Instead, it gives independent agents a shared source of truth: project context, roles, backlog, task comments, file reservations, review handoffs, decisions, and compact prompt context.

Use amutix underneath your preferred agent runtime, terminal workspace, or IDE. Pi is the first full adapter, and the core is framework-agnostic so future hosts can share the same coordination behavior.

## Scope

Use amutix when you already have multiple coding agents or sessions and need them to behave like an aligned engineering team.

amutix is the coordination layer between agents and their work. It is not an LLM runtime, terminal pane manager, hosted agent platform, workflow DAG engine, or automatic planner. Those tools decide where agents run; amutix keeps what they are doing aligned, durable, reviewable, and visible.

## Key Problems Solved

- **No more invisible work ownership**: backlog state, task comments, and review handoffs show who owns what and why.
- **Fewer edit conflicts**: advisory file reservations let agents claim paths before editing, with owner/work context visible to teammates.
- **Less scattered coordination**: task-scoped comments, discussions, and journal entries keep decisions attached to durable project state instead of transient chat.
- **Safer multi-agent workspaces**: workspace intent, cwd/topology checks, and review handoffs make shared-working-tree risks visible without taking over your terminal setup.

## What the coordination layer owns

- **Project context**: shared goal, constraints, and direction
- **Ways of Working**: project-specific team norms
- **Roles and team templates**: reusable agent responsibilities
- **Backlog**: initiatives, milestones, tasks, bugs, chores, specs, dependencies
- **Task comments**: discussion attached to the work instead of scattered across chats
- **Reservations**: advisory file/path ownership to reduce edit conflicts
- **Review handoffs**: explicit lifecycle state before work is considered done
- **Journal**: durable decisions, learnings, and progress
- **Prompt assembly**: compact state-derived context for each agent

## What amutix deliberately does not own

- **Model execution**: agents still run in Pi, a terminal, an IDE, or another host
- **Pane/session management**: tools like tmux, Paneflow, or an IDE can own live terminals
- **Autonomous planning magic**: amutix provides the reviewable state surfaces; agents still make plans and trade-offs
- **Hosted server infrastructure**: state is local, file-backed, and inspectable

## Architecture

```
core/                          Host-runtime independent coordination library
  storage.ts                   Shared storage layer (paths, JSON/JSONL I/O)
  registry.ts                  Agent identity (UUID, online/offline)
  messaging.ts                 Crash-safe file-backed inboxes
  backlog.ts                   Structured backlog items and specs
  task-comments.ts             Task-scoped comments and activity
  reservations.ts              File/directory reservations
  journal.ts                   Decision & learning log
  roles.ts                     Project-local roles and team templates
  prompt-assembly.ts           Deliberate coordination prompt composition
  renderers.ts                 Shared progress/task/team renderers

pi/                            Pi adapter: tools, commands, prompt injection
cli/                           Read-only CLI over shared core services
```

No-magic data flow:

```text
Pi / host runtime / IDE
        |
        | calls command or model-facing tool
        v
amutix adapter / tool surface
        |
        | reads/writes shared state through core services
        v
~/.amutix/sessions/<project>/
        |
        +-- JSON:  agents, backlog, roles, config, reservations
        +-- JSONL: task comments, journal, messages/inboxes
```

See [VISION.md](./VISION.md) for the full vision, principles, and rationale.

## Install

### Pi Extension

```bash
# Stable (npm)
pi install npm:amutix

# Latest (git)
pi install git:github.com/amutix/amutix
```

### Standalone (core module)

```bash
git clone https://github.com/amutix/amutix.git
```

Import core services or the neutral tool registry directly when building another host adapter:

```typescript
import { addTask, readBacklog, allAmutixTools } from "./amutix/core/index.ts";

const now = new Date().toISOString();
await addTask("my-session", {
  title: "Review auth flow",
  status: "todo",
  createdBy: "Lead",
  createdAt: now,
  updatedAt: now,
});

console.log((await readBacklog("my-session")).map((item) => item.id));
console.log(allAmutixTools().map((tool) => tool.name));
```

Host adapters should prefer `allAmutixTools()` so Pi and future runtimes share the same behavior.

### CLI (read-only, phase 1)

```bash
amutix work [--session <name>]         # Project progress overview
amutix work show <ITEM-ID> [--session <name>]  # Item details + comments
amutix team [--session <name>]         # Agent availability
amutix project [--session <name>]      # Vision/WoW/role overview
amutix list [--session <name>]         # Backlog listing
amutix progress/show/status            # Compatibility aliases
amutix --help                           # Show available commands
```

Session is auto-detected if only one exists. The CLI uses shared core services and renderers. For full interactive workflows (create, assign, pick), use the Pi extension.

## Quick Start (Pi)

### Lead/project setup

```bash
# Terminal 1: set up the project and first agent
pi
/amutix new project myapp --repo current --vision "Build ..."
/amutix new agent Lead --role architect --workspace current --join
/amutix new agent Developer --role developer --workspace worktree

# Terminal 2: the registered developer joins from its workspace
cd <developer-worktree> && pi
/amutix join            # → select project → select offline agent → start working
```

### Agent quickstart: already joined

If your prompt includes an amutix identity/session and assigned or active work:

1. Treat the prompt's work state and task comments as the current source of truth, not an old direct message.
2. On wake/resume or when unsure, call `amutix_next({})` for a read-only digest of attention, work, awaiting replies, reservations, and safe next pointers.
3. Pull more state only when needed: `/amutix work`, `/amutix work show TASK-01`, or `amutix_task({ action: "show", id: "TASK-01" })`.
4. Inspect parent context for child work, then pick one ready item: `amutix_task({ action: "pick", id: "TASK-01", reason: "Starting implementation" })`.
5. Use task comments for task-scoped questions, rely on auto-reservations from `pick` (or `amutix_reserve` for extra paths), and move substantive work to `review` with a compact handoff.

### Agent quickstart: not joined

If amutix says you are not in a project:

1. Run `/amutix join` and select the project plus an offline agent identity.
2. If no project exists, a lead should create one with `/amutix new project <name>`.
3. If no suitable agent exists, create one with `/amutix new agent <name> --role <role> [--workspace worktree|current|none]`.
4. After joining, use `/amutix prompt` to verify the coordination block and then follow the joined-agent path above.

## Commands

amutix exposes a small Pi command surface plus framework-neutral tools:

| Surface | Purpose | Examples |
|---------|---------|----------|
| Setup/join | Create projects/agents and join an identity | `/amutix new project myapp`, `/amutix new agent Dev --role developer`, `/amutix join`, `/amutix leave` |
| Project alignment | Vision/context and Ways of Working | `/amutix project`, `/amutix project vision set ...`, `/amutix wow`, `/amutix project wow ...` |
| Work | Progress and backlog item details | `/amutix work`, `/amutix work show TASK-01`, `/amutix progress`, `/amutix show TASK-01` |
| Team | Agent roster, availability, and workspace helpers | `/amutix team`, `/amutix status set focus "reviewing"`, `/amutix workspace` |
| Prompt/debug | Preview the amutix-appended coordination block | `/amutix prompt`, `/amutix prompt workState`, `/amutix prompt all` |
| Tools | Agent-callable coordination primitives | `amutix_task`, `amutix_project`, `amutix_send`, `amutix_reserve`, `amutix_journal` |

### Project Vision / Context

```bash
/amutix new project <name>              # Create a project/session from Pi
/amutix project                         # Show current project vision/context
/amutix project vision set <t>          # Replace project vision/context
/amutix project vision append <t>       # Append to project vision/context
/amutix project vision edit             # Open editor to edit CONTEXT.md
/amutix project vision clear            # Clear project vision/context
/amutix project vision path             # Print CONTEXT.md file path
/amutix project wow ...                 # Manage Ways of Working (also available as /amutix wow)
amutix_project({ action: "create", content: "myapp" })  # Neutral setup tool for adapters that expose tools before join
```

Project vision/context is stored in `artifacts/project/CONTEXT.md` and auto-injected into agent prompts. Prefer `/amutix project vision ...` or the `amutix_project` tool over direct file edits.

### Ways of Working

```bash
/amutix wow                         # Show current team Ways of Working
/amutix wow set <text>              # Replace WOW.md
/amutix wow append <text>           # Append to WOW.md
/amutix wow edit                    # Open editor to edit WOW.md
/amutix wow clear                   # Clear WOW.md
/amutix wow path                    # Print WOW.md file path
```

Ways of Working is stored in `artifacts/project/WOW.md` and auto-injected into agent prompts after the built-in common principles. New projects start with a small default WoW covering task comments, review, waiting/reminders, and learnings. Edit it for project-specific collaboration norms. Keep it concise because it appears in every agent's prompt. Agents can also use the `amutix_wow` tool.

### Prompt preview

```bash
/amutix prompt                      # Section summary for this agent
/amutix prompt roleProfile          # Preview one section
/amutix prompt all                  # Explicitly show the full amutix-appended block
```

amutix **appends** a coordination block to the host agent runtime's base system prompt — it never replaces the base prompt. `/amutix prompt` is a debug surface for understanding what each agent actually sees. By default it shows a compact section summary to avoid dumping the whole prompt; inspect a single section by name (for example `teamContext`) or use `/amutix prompt all` when you explicitly want the full amutix-appended block. The host's base system prompt is **not** shown (amutix never sees or owns it). The preview uses the same gathering path that injects the live prompt, so it never drifts from what agents receive.

### Task Workflow

Task assignments are **state-derived** — agents discover their tasks from the current backlog, not from queued inbox messages. This ensures task context is always current and never stale. `amutix_next` is the lightweight cockpit for checking current pointers; use task comments, reviews, and lifecycle actions for coordination changes.

Human-facing Pi/CLI commands:

```bash
# Compact project progress overview
/amutix work
/amutix progress            # shortcut
amutix work                 # read-only CLI

# View compact task details
/amutix work show TASK-01
/amutix show TASK-01        # shortcut
amutix work show TASK-01    # read-only CLI
```

When shaping larger work, create the high-level item first (`initiative` or `milestone`), add child executable items, review the structure with `/amutix progress`, then assign the leaf work. Assign `task`/`bug`/`chore`/`spec` items rather than container items unless you intentionally want broad ownership.

#### Under the hood / agent tools

Agent runtimes use `amutix_task` for durable task lifecycle changes. These examples are model/tool calls, not commands a human types into a shell:

```typescript
amutix_task({ action: "summary" })
amutix_task({ action: "show", id: "TASK-01" })
amutix_task({ action: "comment", id: "TASK-01", content: "Looks good, one suggestion..." })
amutix_task({ action: "plan", id: "TASK-01", content: "# Plan\n..." })
amutix_task({ action: "pick", id: "TASK-01", reason: "Starting implementation" })
amutix_task({ action: "review", id: "TASK-01", summary: "Branch agent/dev. Diff: ... Tests: npm test. Risks: ..." })
amutix_task({ action: "archive" })   // Move done items out of the active backlog
```

For token-efficient review handoff, include a compact free-form summary when marking work ready for review:

```typescript
amutix_task({
  action: "review",
  id: "TASK-01",
  summary: "Commit abc123 on agent/alice. Diff: extracted auth parser. Tests: npm test. Risk: token refresh edge cases."
})
```

Lifecycle events (assign, pick, review, done, drop, block) are automatically recorded as activity in `task-comments/<ITEM-ID>.jsonl`. Task comments are durable and notify relevant subscribers by default (assignee, creator, previous commenters, and `@AgentName` mentions); pass `notify: false` or `silent: true` for a quiet note. When a lifecycle change needs another agent's attention (ready for review, blocked, unblocked, dependency handoff, help needed), add a task comment mentioning that agent; do not reassign work just to notify. Agent prompts include only compact latest substantive task-discussion previews; full comment history stays pull-based via `amutix_task show`. Use `review` when implementation is ready for review/integration; use `done` when work is reviewed, integrated, and verified. Use `archive` to move done items that are no longer needed for ongoing implementation out of the active backlog. Simple workflows can still mark work done directly. Use `amutix_send` only for exceptional non-task communication; delivered messages show intent and age so stale context is visible.

Reviewer flow: read the linked spec, inspect the diff, inspect test output, then add a task comment or mark the item done. This keeps review scoped to spec + diff + tests instead of reloading broad project context.

For direct messages that need an answer, set `responseRequired: true`; `brainstorm` messages default to requiring a response. Pending replies are shown in the sender's prompt until the recipient replies with `inReplyTo`.

**Documentation types:**

| Type | Use for | Tool |
|------|---------|------|
| Task description | Brief inline context and acceptance criteria | `amutix_task add` |
| Linked spec | Detailed plans, checklists, design notes | `amutix_task plan/edit-plan` |
| Journal | Decisions, learnings, progress shared across agents | `amutix_journal add` |

**Recommended workflow:** Create a high-level initiative with child tasks, assign all executable leaves to the intended agent(s) upfront, and let `dependsOn` enforce ordering. The assignee picks one task at a time after completing the current one. Auto-pick (`amutix_task pick` without an ID) prefers assigned-to-self items with met dependencies before open todo items.

### Team discussions

Use discussions for cross-cutting multi-party collaboration such as retros, brainstorms, design jams, and syncs. Keep task-scoped discussion on `amutix_task comment`; discussions are for topics whose audience is a group rather than one task thread.

Human-facing ways to inspect discussion-related state:

```bash
/amutix prompt discussions   # compact open-discussion prompt section, when present
/amutix prompt all           # full amutix-appended prompt block, including discussion metadata
amutix work                  # read-only progress overview; task discussion stays attached to tasks
```

#### Under the hood / agent tools

Agent runtimes use `amutix_discussion` to start, post to, list, show, and close discussions:

```typescript
amutix_discussion({ action: "start", topic: "Retro: v1.2", kind: "retro", audience: "all" })
amutix_discussion({ action: "start", topic: "Storage design", audience: "agents", participants: ["Lead", "Developer2"] })
amutix_discussion({ action: "post", id: "DISC-01", content: "One option is..." })
amutix_discussion({ action: "show", id: "DISC-01" })
amutix_discussion({ action: "close", id: "DISC-01", summary: "Outcome: use append-only JSONL." })
```

Audience controls expected participation and notifications, not access control. `all` resolves all same-session agents at creation time; `agents` resolves the explicit same-session participants. Open discussions appear in prompts as compact metadata only; full discussion text is shown on demand with `show`.

### Backlog Model

Backlog items (`BacklogItem`) support optional structure fields:

| Field | Purpose |
|-------|---------|
| `itemType` | `task` (default), `initiative`, `milestone`, `bug`, `chore`, `spec` |
| `dependsOn` | Array of task IDs that must be done before this item can be picked |
| `parentId` | Parent item ID for hierarchy grouping |
| `order` | Sort order within siblings |

Existing items without these fields behave as regular tasks. New item IDs use type-specific prefixes: `TASK-*`, `INIT-*`, `MS-*`, `BUG-*`, `CHORE-*`, and `SPEC-*`. Existing `TASK-*` IDs remain valid.

### Availability

```bash
/amutix status set idle        # Ready for new work
/amutix status set working     # Actively working (auto-set on pick)
/amutix status set focus       # Do not interrupt
/amutix status set away        # Unavailable
```

Availability is auto-updated by task lifecycle: `pick` → working, `done`/`drop` → idle (preserves explicit focus/away). Idle agents receive a concrete assignment notification when new work is assigned; working/focus/away agents are not interrupted.

## Tools (14 current)

The canonical model-facing names use the `amutix_*` prefix. Legacy `amux_*` aliases still resolve for backward compatibility but are deprecated.

| Tool | Actions | Purpose |
|------|---------|---------|
| `amutix_artifacts` | -- | List shared project and private agent artifacts |
| `amutix_list` | -- | List online/effectively-online agents across the current session, with optional cross-session discovery; use `/amutix team` or CLI `amutix team` for offline/availability views |
| `amutix_project` | create, show, set, append, clear, path | Create project sessions and manage project vision/context |
| `amutix_wow` | show, set, append, clear, path | Manage project/team Ways of Working |
| `amutix_send` | -- | Send direct messages for exceptional non-task communication; supports response-required tracking |
| `amutix_broadcast` | -- | Broadcast a message to online agents |
| `amutix_discussion` | start, post, show, list, close | Multi-party discussions for retros, brainstorms, design jams, and syncs |
| `amutix_role` | add, list, remove, templates, apply-template, show, path | Manage roles and apply team templates |
| `amutix_reserve` | claim, release, list | Advisory file/directory reservations |
| `amutix_journal` | add, list | Record durable decisions, learnings, and progress |
| `amutix_feedback` | add, list, path | Record project-independent feedback about amutix itself |
| `amutix_agent` | register, update, list, validate-team, plan-workspace, create-workspace, assign-workspace, request-user-action | Manage agent identities, workspace intent, topology validation, and human runtime handoffs |
| `amutix_task` | add, list, show, comment, plan, edit-plan, assign, pick, review, done, drop, block, archive, summary | Backlog lifecycle with task comments, linked specs, dependencies, batch assignment, review, and archive |
| `amutix_next` | -- | Read-only state digest/cockpit with identity, attention, awaiting replies, relevant work, reservations, reviews, discussions, and safe next pointers |

## Built-in Roles

Five role templates ship with amutix, ready to use during agent creation:

| Role | Description |
|------|-------------|
| `developer` | Write clean, well-structured code |
| `architect` | System design, trade-offs, technical decisions |
| `reviewer` | Code review, quality, constructive feedback |
| `devops` | Infrastructure, CI/CD, deployment |
| `planner` | Task breakdown, requirements, coordination |

Built-in roles are copied to the project on first use and can be customized.

## Role Profiles & Team Templates

For lead-agent orchestration, amutix ships richer **role profiles** (markdown) and **team templates** for quick setup.

**Bundled role profiles** (`roles/*.md`):

| Profile | Focus |
|---------|-------|
| `lead-architect` | Decompose goals, delegate, coordinate, guard quality |
| `developer` | Implement assigned tasks from specs, write tests |
| `reviewer` | Verify implementations against specs and acceptance criteria |

**Team templates** (`team-templates/*.json`):

| Template | Roles |
|----------|-------|
| `core-team` | lead-architect + developer + reviewer |

```bash
amutix_role({ action: "templates" })                       # list bundled profiles + teams
amutix_role({ action: "apply-template", template: "core-team" })  # copy profiles + register roles
amutix_role({ action: "show", name: "lead-architect" })    # resolved role text
amutix_role({ action: "path", name: "lead-architect" })    # project-local profile file path
```

Applying a team template copies the role markdown into `artifacts/project/roles/` and registers role definitions. It **does not create agents** — create those separately via `/amutix new agent`. The copied markdown is the source of truth (`profilePath`); edit it to customize a role. Existing customized profiles are preserved unless `force` is used.

## Lead Orchestration Workflow

amutix is built for a lead agent (e.g. the `lead-architect` role) to turn high-level user goals into coordinated, reviewed delivery through a team of specialists. The recommended lead loop:

1. **Clarify the goal** — outcomes, constraints, non-goals.
2. **Confirm/update project vision** — `amutix_project` (durable, prompt-injected context).
3. **Create structure** — an initiative/milestone/spec for the work.
4. **Decompose** — break into executable leaf tasks with `files` and `dependsOn`.
5. **Delegate** — assign executable leaves to specialists (not container items); assign ready leaves up front and let `dependsOn` enforce order.
6. **Monitor** — `amutix_task summary` / `/amutix progress`, reservations, review status.
7. **Require review** — substantive work goes to `review` before `done`.
8. **Integrate** — verify and merge the final changes.
9. **Archive** — move done items no longer needed for ongoing implementation out of the active backlog.
10. **Report** — give the user a clear outcome: what shipped, files/commits, tests, decisions, risks, next steps.

This workflow is guidance, not magic automation — the lead agent orchestrates through the existing primitives (`amutix_task`, `amutix_project`, reservations, journal). There is no auto-decomposition action; decomposition is the lead's judgment and stays reviewable.

## Human-in-the-loop Team Management

amutix can manage **team topology state** — agent identities, roles, preferred models, intended workspaces, workspace plans, and topology risks — but it does **not** manage terminals, panes, or live model processes for you.

Humans still perform host/runtime actions:

- open a terminal or pane
- `cd` into the intended worktree
- start Pi or another host runtime
- run `/amutix join` as the intended agent
- approve high-risk workspace or topology changes

Human-facing Pi/CLI commands come first:

```bash
# Inspect current team/work state
/amutix team
/amutix work
amutix team --session myapp

# Create or join an agent identity from Pi
/amutix new agent Developer --role developer --workspace worktree
cd /path/to/main-developer && pi
/amutix join

# Check workspace state from the running agent
/amutix workspace
```

### Under the hood / agent tools

Lead agents can make those human actions faster and safer by using `amutix_agent` tool actions. These update durable topology/workspace state and produce clear handoff text; they do not open terminals or move live processes.

```typescript
amutix_agent({ action: "list" })
amutix_agent({ action: "validate-team" })
amutix_agent({ action: "plan-workspace", name: "Developer" })
amutix_agent({ action: "create-workspace", name: "Developer", repoPath: "/path/to/main" })
amutix_agent({ action: "assign-workspace", name: "Developer", workspace: "/path/to/main-developer" })
amutix_agent({ action: "request-user-action", name: "Developer", workspace: "/path/to/main-developer" })
```

A typical handoff looks like:

1. Lead applies roles/templates and registers the intended agent.
2. Lead plans a dedicated worktree (`plan-workspace`) and checks risks (`validate-team`).
3. If safe and execution is available, lead creates the worktree (`create-workspace`).
4. Lead assigns workspace metadata (`assign-workspace`). This records **registry intent**; it does not move a running process.
5. amutix emits a clear human action request, for example: “Open a terminal, `cd /path/to/worktree`, start Pi, then `/amutix join` as Developer.”
6. Once the runtime joins from that cwd, topology signals clear naturally from authoritative state.

Guardrails:

- Workspace assignment is not task ownership.
- Do not claim a live agent moved cwd unless the runtime actually joins from that path.
- Use `validate-team` / `amutix_next` topology signals to catch shared cwd/workspace risks.
- Focus/away agents should not be nagged for non-urgent topology cleanup.

### Prompt composition

amutix **appends** a composed coordination block to the host agent runtime's base system prompt (it never replaces it). The block is assembled in a deliberate, documented order (see `core/prompt-assembly.ts`):

1. Common amutix operating principles (collaboration contract)
2. Ways of Working (`WOW.md`)
3. Project vision/context (`CONTEXT.md`)
4. Role profile (role-specific only)
5. Agent identity + workspace
6. Current work state (active/assigned/review items, spec preview, recent comments, recent journal)
7. Team/project snapshot/reservation context
8. Interface/tool guidance and shared artifact paths
9. Compact open-discussions metadata

Role profiles supply only the role-specific section; common principles, WoW, vision, work state, team context, and interface guidance are separate, deliberately ordered sections.

## Team Learning & Retrospectives

amutix teams learn from mistakes, successes, and user corrections through **curated learnings** — selective, durable lessons that evolve how the team works.

### Artifact boundaries

| Artifact | Purpose | Changes how |
|----------|---------|-------------|
| `CONTEXT.md` | Project vision and strategy | Via `/amutix project vision` or `amutix_project` |
| `WOW.md` | Team collaboration norms | Via `/amutix wow` or `amutix_wow` |
| role profiles | Per-role behavior | Via editing `roles/<name>.md` |
| `journal.jsonl` | Curated lessons, decisions, proposals | Via `amutix_journal add` |

### Retrospectives

After completing a major initiative or milestone, the lead runs a **lightweight retro** (no new command — just 4 questions through existing primitives):

1. What worked?
2. What failed or caused rework?
3. What user correction should we remember?
4. What should change in WoW, role profiles, or project context?

Outputs are recorded as `amutix_journal` learning entries. Norm-changing proposals use the `context: "wow-proposal"` convention — the journal entry is the proposal; WoW only changes by deliberate lead/user edit via `/amutix wow`. Nothing auto-mutates.

## Workspaces

Agents can work in isolated git worktrees:

```bash
# Create an agent with a dedicated worktree
/amutix new agent Alice --role developer --workspace worktree
# → creates ~/myapp-alice on branch agent/alice
# names are sanitized: "My Agent!" → agent/my-agent

# Agent starts in their worktree
cd ~/myapp-alice && pi
/amutix join

# Sync from main (fetches origin, rebases on origin/<mainBranch>)
/amutix workspace > sync

# Check status (compares against origin/<mainBranch>)
/amutix workspace > status
```

Sync runs `git fetch origin` followed by `git rebase origin/<mainBranch>`, where `<mainBranch>` is the current branch of the main repo (defaults to `main`). This avoids rebasing against a stale local branch. Status compares commit counts against the same remote ref and handles missing refs gracefully.

## Key Features

- **Framework-agnostic core** -- works with any agent framework, not just Pi
- **Zero overhead** -- invisible until you opt in
- **UUID identity** -- 128-bit UUIDs, unique names per session (case-insensitive), agents persist across restarts
- **Heartbeat presence** -- crashed agents auto-expire after 90s, stale reservations cleared automatically
- **Agent availability** -- idle/working/focus/away status, auto-updated by task lifecycle, descriptive attention notifications for idle agents
- **Crash-safe messaging** -- messages survive crashes, delivered on reconnect
- **File reservations** -- claim files before editing; conflicts show age, linked task context, and owner work state
- **Task backlog** -- state-derived workflow with task-scoped comments, dependencies, batch assign, assignee ownership. Assignments are visible via task state, not inbox messages.
- **Shared journal** -- decisions and learnings in every agent's context
- **Git workspaces** -- isolated worktrees per agent
- **Built-in roles** -- ready to use, customizable per project
- **Zero dependencies** -- just Node.js

## FAQ

### How is amutix different from pi-messenger?

pi-messenger-style tools are useful for direct message passing between running Pi sessions. amutix is a broader coordination layer: backlog ownership, task comments, reservations, reviews, roles, workspace intent, journal entries, and prompt context are durable project state rather than only chat messages.

### Bring Your Own Terminal / no subprocess management

amutix does not spawn agents, open panes, or supervise subprocesses. Humans or host tools decide where agents run. amutix records identity, work, workspace intent, topology risks, and handoff text so those human/runtime actions stay coordinated.

### Framework-agnostic file-backed core

Pi is the first full adapter, but amutix core is framework-agnostic. State lives in local JSON/JSONL files under `~/.amutix/sessions/`, and other hosts can call the same core services or neutral tool registry.

### Zero UI intrusion

amutix does not require a hosted dashboard, terminal multiplexer, or IDE overlay. It surfaces state through Pi commands, model-facing tools, prompt context, and a read-only CLI while leaving your existing workspace UI alone.

### State-driven vs chat-driven coordination

Chat is useful for conversation, but team delivery needs durable source-of-truth state: assigned work, comments attached to tasks, file reservations, review handoffs, and decisions that survive restarts. amutix keeps direct messages available for exceptional cases while making the shared project state the coordination backbone.

## Session Files

Default root: `~/.amutix/sessions/`. Override with environment variables:

| Variable | Effect |
|----------|--------|
| `AMUTIX_SESSIONS_DIR` | Use this path as the sessions directory (highest priority) |
| `AMUTIX_HOME` | Use `$AMUTIX_HOME/sessions` as the sessions directory |

Both core modules and the Pi adapter resolve the same root.

```
~/.amutix/sessions/<project>/
├── agents.json             Agent registry (UUID-keyed)
├── roles.json              Role definitions
├── config.json             Project config (main repo path)
├── backlog.json            Task backlog
├── task-comments/          Per-task comment/activity history (JSONL)
├── reservations.json       File reservations
├── journal.jsonl           Decisions & learnings
├── discussions.json        Open/closed team discussions
├── messages.log            Message history
├── inbox/<agent-uuid>/     Per-agent message inbox
└── artifacts/
    ├── project/            Shared across all agents
    │   ├── CONTEXT.md      Auto-injected project vision/context
    │   ├── WOW.md          Auto-injected Ways of Working
    │   ├── roles/          Project-local role profiles
    │   └── tasks/          Linked task specs/plans
    └── agents/<uuid>/      Private per-agent space
```

Global amutix product feedback is stored outside project sessions so it does not pollute project state.

## Development

Requires Node >= 22 (uses `--experimental-strip-types`).

```bash
npm test    # Parse-check all .ts files + run E2E flow tests
```

### Benchmarks

See [`benchmarks/solo-vs-amutix/`](benchmarks/solo-vs-amutix/) for the solo-vs-amutix token efficiency benchmark harness.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT -- see [LICENSE](LICENSE).
