/**
 * amux — Task Workflow Service
 *
 * Framework-agnostic business logic for task operations.
 * Handles validation, state mutation, file reservations, and activity recording.
 * Returns structured results for adapters to format and deliver.
 *
 * Pi adapter (or CLI, or any framework) calls these and handles only
 * framework-specific concerns (tool schemas, notifications, response format).
 */

import {
  type BacklogItem,
  readBacklog,
  writeBacklog,
  unmetDependencies,
  readSpecPreview,
} from "./backlog.ts";
import {
  assertTaskTransitionAllowed,
  assertTaskTransitionOwnership,
  requireTaskTransitionDefinition,
  formatTaskTransitionActivity,
  type TaskTransitionAction,
  type TaskTransitionDefinition,
} from "./task-state-machine.ts";
import {
  reserve,
  release,
} from "./reservations.ts";
import {
  getOnlineAgents,
  findById,
  updateAgent,
  shouldSignalAgentForWork,
  type AgentInfo,
} from "./registry.ts";
import {
  appendTaskActivity,
  readTaskComments,
  type TaskComment,
} from "./task-comments.ts";

// ─── Result Types ────────────────────────────────────────────

export interface AssignResult {
  assigned: BacklogItem[];
  /** Whether the target agent should receive an attention signal. */
  shouldSignal: boolean;
  targetId: string;
}

export interface PickResult {
  task: BacklogItem;
  reserved: string[];
  conflicts: Array<{ path: string; detail: string }>;
}

export interface CompleteResult {
  task: BacklogItem;
  released: string[];
  /** Whether the agent has no remaining in-progress tasks. */
  nowIdle: boolean;
}

export interface ReviewResult {
  task: BacklogItem;
  released: string[];
  /** Whether the implementer has no remaining in-progress tasks. */
  nowIdle: boolean;
}

export interface DropResult {
  task: BacklogItem;
  released: string[];
  nowIdle: boolean;
}

export interface BlockResult {
  task: BacklogItem;
}

export interface TaskShowData {
  task: BacklogItem;
  allTasks: BacklogItem[];
  comments: TaskComment[];
  specPreview: string | null;
}

interface TransitionSideEffectResult {
  reserved: string[];
  conflicts: Array<{ path: string; detail: string }>;
  released: string[];
  nowIdle: boolean;
}

function prepareTransition(
  task: BacklogItem,
  action: TaskTransitionAction,
  actorId: string,
): TaskTransitionDefinition {
  assertTaskTransitionAllowed(task, action);
  assertTaskTransitionOwnership(task, action, actorId);
  return requireTaskTransitionDefinition(task, action);
}

function applyTransitionTarget(task: BacklogItem, def: TaskTransitionDefinition): void {
  if (def.to !== "same" && def.to !== "archive") {
    task.status = def.to;
  }
}

function transitionReserveReason(task: BacklogItem, reason: "task-id-title"): string {
  switch (reason) {
    case "task-id-title":
      return `${task.id}: ${task.title}`;
  }
}

function appendTransitionActivity(
  session: string,
  task: BacklogItem,
  def: TaskTransitionDefinition,
  actorId: string,
  actorName: string,
  metadata: { targetName?: string; summary?: string; reason?: string } = {},
): void {
  const text = formatTaskTransitionActivity(def, { actorName, ...metadata });
  if (!text) return;
  appendTaskActivity(session, task.id, {
    timestamp: task.updatedAt,
    agent: actorName,
    agentId: actorId,
    text,
  });
}

async function runTransitionSideEffects(
  session: string,
  tasks: BacklogItem[],
  task: BacklogItem,
  def: TaskTransitionDefinition,
  agentId: string,
  agentName: string,
): Promise<TransitionSideEffectResult> {
  const result: TransitionSideEffectResult = {
    reserved: [],
    conflicts: [],
    released: [],
    nowIdle: false,
  };

  for (const effect of def.sideEffects) {
    switch (effect.type) {
      case "set-availability": {
        if (effect.mode === "always") {
          await updateAgent(session, agentId, {
            availability: effect.availability,
            availabilityUpdatedAt: new Date().toISOString(),
          });
          break;
        }

        const remainingActive = tasks.filter((t) => t.status === "in-progress" && t.assigneeId === agentId);
        if (remainingActive.length === 0) {
          const agent = await findById(session, agentId);
          if (!agent?.availability || agent.availability === "working") {
            await updateAgent(session, agentId, {
              availability: effect.availability,
              availabilityUpdatedAt: new Date().toISOString(),
            });
            result.nowIdle = effect.availability === "idle";
          }
        }
        break;
      }
      case "reserve-files": {
        if (!task.files?.length) break;
        const online = await getOnlineAgents(session).catch(() => [] as AgentInfo[]);
        const onlineIds = online.map((a) => a.id);
        const reserveReason = transitionReserveReason(task, effect.reason);

        for (const filePath of task.files) {
          try {
            await reserve(session, [filePath], agentId, agentName, reserveReason, onlineIds);
            result.reserved.push(filePath);
          } catch (err) {
            result.conflicts.push({ path: filePath, detail: err instanceof Error ? err.message : String(err) });
          }
        }
        break;
      }
      case "release-files": {
        if (task.files?.length) {
          result.released = await release(session, task.files, agentId);
        }
        break;
      }
    }
  }

  return result;
}

// ─── Assign ──────────────────────────────────────────────────

/**
 * Assign one or more tasks to an agent.
 * Validates all tasks before assigning any (all-or-nothing).
 */
export async function serviceAssignTasks(
  session: string,
  taskIds: string[],
  targetId: string,
  targetName: string,
  assignerId: string,
  assignerName: string,
): Promise<AssignResult> {
  const tasks = await readBacklog(session);
  const toAssign: BacklogItem[] = [];
  const transitions = new Map<string, TaskTransitionDefinition>();

  for (const taskId of taskIds) {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`Task ${taskId} not found.`);
    transitions.set(task.id, prepareTransition(task, "assign", assignerId));
    toAssign.push(task);
  }

  const now = new Date().toISOString();
  for (const task of toAssign) {
    applyTransitionTarget(task, transitions.get(task.id)!);
    task.assignee = targetName;
    task.assigneeId = targetId;
    task.updatedAt = now;
  }
  await writeBacklog(session, tasks);

  // Record activity
  for (const task of toAssign) {
    appendTransitionActivity(session, task, transitions.get(task.id)!, assignerId, assignerName, { targetName });
  }

  // Check attention signal. Stale `working` availability should not suppress
  // assigned-work nudges when the target has no active in-progress item.
  const targetAgent = await findById(session, targetId);
  const targetHasActiveWork = tasks.some((t) =>
    t.status === "in-progress" && t.assigneeId === targetId
  );
  const shouldSignal = targetAgent
    ? shouldSignalAgentForWork(targetAgent, targetHasActiveWork)
    : false;
  if (shouldSignal) {
    await updateAgent(session, targetId, { attentionPending: true });
  }

  return { assigned: toAssign, shouldSignal, targetId };
}

// ─── Pick ────────────────────────────────────────────────────

/**
 * Pick a task (by ID or auto-pick).
 * Auto-pick prefers assigned-to-self items with met dependencies.
 */
export async function servicePickTask(
  session: string,
  taskId: string | undefined,
  agentId: string,
  agentName: string,
): Promise<PickResult> {
  const tasks = await readBacklog(session);
  let task: BacklogItem | undefined;
  let transition: TaskTransitionDefinition | undefined;

  if (taskId) {
    task = tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`Task ${taskId} not found.`);

    transition = prepareTransition(task, "pick", agentId);

    const unmet = unmetDependencies(task, tasks);
    if (unmet.length > 0) {
      throw new Error(`${taskId} has unfinished dependencies: ${unmet.join(", ")}. Complete those tasks first.`);
    }
  } else {
    // Auto-pick: prefer assigned-to-self with met deps, then open todo
    task = tasks.find((t) => t.status === "assigned" && t.assigneeId === agentId && unmetDependencies(t, tasks).length === 0)
      || tasks.find((t) => t.status === "todo" && unmetDependencies(t, tasks).length === 0);
    if (!task) {
      throw new Error("No tasks available to pick. All tasks are assigned, in progress, blocked, done, or waiting on dependencies.");
    }
    transition = prepareTransition(task, "pick", agentId);
  }

  // Claim the task
  applyTransitionTarget(task, transition!);
  task.assignee = agentName;
  task.assigneeId = agentId;
  task.blockedReason = undefined;
  task.updatedAt = new Date().toISOString();
  await writeBacklog(session, tasks);

  appendTransitionActivity(session, task, transition!, agentId, agentName);

  const effects = await runTransitionSideEffects(session, tasks, task, transition!, agentId, agentName);

  return { task, reserved: effects.reserved, conflicts: effects.conflicts };
}

// ─── Done ────────────────────────────────────────────────────

/**
 * Complete a task. Releases file reservations and checks for idle.
 */
export async function serviceCompleteTask(
  session: string,
  taskId: string,
  agentId: string,
  agentName: string,
  summary?: string,
): Promise<CompleteResult> {
  const tasks = await readBacklog(session);
  const task = tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found.`);
  const transition = prepareTransition(task, "done", agentId);

  applyTransitionTarget(task, transition);
  task.completedAt = new Date().toISOString();
  task.updatedAt = new Date().toISOString();
  if (summary) task.summary = summary;
  await writeBacklog(session, tasks);

  appendTransitionActivity(session, task, transition, agentId, agentName, { summary });

  const effects = await runTransitionSideEffects(session, tasks, task, transition, agentId, agentName);

  return { task, released: effects.released, nowIdle: effects.nowIdle };
}

// ─── Review ──────────────────────────────────────────────────

/**
 * Mark implementation ready for review. Releases file reservations and checks for idle.
 */
export async function serviceReviewTask(
  session: string,
  taskId: string,
  agentId: string,
  agentName: string,
  summary?: string,
): Promise<ReviewResult> {
  const tasks = await readBacklog(session);
  const task = tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found.`);
  const transition = prepareTransition(task, "review", agentId);

  applyTransitionTarget(task, transition);
  task.updatedAt = new Date().toISOString();
  if (summary) task.summary = summary;
  await writeBacklog(session, tasks);

  appendTransitionActivity(session, task, transition, agentId, agentName, { summary });

  const effects = await runTransitionSideEffects(session, tasks, task, transition, agentId, agentName);

  return { task, released: effects.released, nowIdle: effects.nowIdle };
}

// ─── Drop ────────────────────────────────────────────────────

/**
 * Drop a task back to the queue. Releases file reservations.
 */
export async function serviceDropTask(
  session: string,
  taskId: string,
  agentId: string,
  agentName: string,
): Promise<DropResult> {
  const tasks = await readBacklog(session);
  const task = tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found.`);
  const transition = prepareTransition(task, "drop", agentId);

  applyTransitionTarget(task, transition);
  task.assignee = undefined;
  task.assigneeId = undefined;
  task.blockedReason = undefined;
  task.updatedAt = new Date().toISOString();
  await writeBacklog(session, tasks);

  appendTransitionActivity(session, task, transition, agentId, agentName);

  const effects = await runTransitionSideEffects(session, tasks, task, transition, agentId, agentName);

  return { task, released: effects.released, nowIdle: effects.nowIdle };
}

// ─── Block ───────────────────────────────────────────────────

/**
 * Block a task with a reason.
 */
export async function serviceBlockTask(
  session: string,
  taskId: string,
  agentId: string,
  agentName: string,
  reason: string,
): Promise<BlockResult> {
  const tasks = await readBacklog(session);
  const task = tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found.`);
  const transition = prepareTransition(task, "block", agentId);

  applyTransitionTarget(task, transition);
  task.blockedReason = reason;
  task.updatedAt = new Date().toISOString();
  await writeBacklog(session, tasks);

  appendTransitionActivity(session, task, transition, agentId, agentName, { reason });

  return { task };
}

// ─── Show Data Assembly ──────────────────────────────────────

/**
 * Assemble all data needed to render task details.
 * Adapter calls this, then passes result to renderTaskDetails.
 */
export async function serviceGetTaskShowData(
  session: string,
  taskId: string,
): Promise<TaskShowData> {
  const allTasks = await readBacklog(session);
  const task = allTasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found.`);

  const comments = readTaskComments(session, taskId);
  const specPreview = task.specPath ? readSpecPreview(session, task.specPath, 1024) : null;

  return { task, allTasks, comments, specPreview };
}
