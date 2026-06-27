/**
 * amux — File Reservations (Phase 1: Advisory)
 *
 * Agents reserve file paths or directory prefixes to prevent conflicts.
 * Convention: trailing slash = directory prefix, no slash = exact file.
 * Overlap detection: startsWith in both directions.
 *
 * Stale reservations: held by offline agents → advisory only, anyone can claim.
 *
 * File per session:
 *   reservations.json — active reservations (keyed by path prefix)
 */

import { normalize, isAbsolute, relative } from "node:path";

import {
  sessionFile,
  readJson,
  atomicWriteJson,
  withJsonFile,
} from "./storage.ts";

// ─── Types ───────────────────────────────────────────────────

export interface Reservation {
  agent: string; // agent display name
  agentId: string; // agent UUID
  since: string; // ISO 8601
  reason?: string; // why the reservation was made
}

/** Reservations keyed by path prefix. */
export type ReservationsMap = Record<string, Reservation>;

export interface ConflictInfo {
  /** The reserved path that conflicts. */
  reservedPath: string;
  /** The reservation details. */
  reservation: Reservation;
  /** Whether the reservation is stale (held by offline agent). */
  stale: boolean;
}

// ─── Paths ───────────────────────────────────────────────────

function reservationsPath(session: string): string {
  return sessionFile(session, "reservations.json");
}

// ─── Path Helpers ────────────────────────────────────────────

/**
 * Normalize a reservation path for consistent comparison.
 * Removes leading ./ and normalizes separators, preserves trailing slash.
 */
export function normalizePath(p: string): string {
  // Normalize but preserve trailing slash convention
  const hasTrailingSlash = p.endsWith("/");
  let normalized = normalize(p);
  // Remove leading ./
  if (normalized.startsWith("./")) normalized = normalized.slice(2);
  // Restore trailing slash if it was a directory prefix
  if (hasTrailingSlash && !normalized.endsWith("/")) normalized += "/";
  return normalized;
}

/**
 * Check if two paths overlap (conflict).
 * Trailing slash = directory prefix; no trailing slash = exact file.
 * A directory "foo/" contains "foo/bar" but NOT "foobar".
 */
export function pathsOverlap(pathA: string, pathB: string): boolean {
  // Exact match
  if (pathA === pathB) return true;
  // Directory prefix matches paths inside it (boundary-aware)
  if (pathA.endsWith("/") && pathB.startsWith(pathA)) return true;
  if (pathB.endsWith("/") && pathA.startsWith(pathB)) return true;
  return false;
}

/**
 * Convert an absolute file path to a workspace-relative path.
 * Returns the path unchanged if it is already relative or outside the workspace.
 * Used by the Pi adapter to normalize write/edit paths for conflict checks.
 */
export function toWorkspaceRelative(filePath: string, cwd?: string): string {
  if (!cwd || !isAbsolute(filePath)) return filePath;
  const rel = relative(cwd, filePath);
  // If the relative path escapes the workspace, return the original
  if (rel.startsWith("..")) return filePath;
  return rel;
}

// ─── Formatting Helpers ─────────────────────────────────────

const ITEM_ID_RE = /\b(?:TASK|INIT|MS|BUG|CHORE|SPEC)-\d+\b/;

/** Extract a backlog item ID from a reservation reason, if present. */
export function reservationTaskId(reservation: Reservation): string | null {
  const match = reservation.reason?.match(ITEM_ID_RE);
  return match?.[0] ?? null;
}

/** Format reservation age relative to now. */
export function formatReservationAge(since: string): string {
  const ms = Date.now() - new Date(since).getTime();
  if (ms < 0) return "just now";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/** Format the stable core portion of a reservation conflict. */
export function formatReservationConflict(
  reservedPath: string,
  reservation: Reservation,
  stale = false,
): string {
  const age = formatReservationAge(reservation.since);
  const reasonStr = reservation.reason ? ` (${reservation.reason})` : "";
  const staleNote = stale ? " [agent offline -- stale reservation]" : "";
  return `"${reservedPath}" is reserved by ${reservation.agent}${reasonStr} for ${age}${staleNote}.`;
}

// ─── Reservations ────────────────────────────────────────────

/** Read all reservations for a session. */
export async function getReservations(session: string): Promise<ReservationsMap> {
  return readJson<ReservationsMap>(reservationsPath(session), {});
}

/** Write reservations for a session. */
async function writeReservations(session: string, data: ReservationsMap): Promise<void> {
  await atomicWriteJson(reservationsPath(session), data);
}

/**
 * Reserve one or more paths for an agent.
 *
 * Rejects if any requested path overlaps with an existing reservation
 * from a different agent (unless that reservation is stale).
 * Conflict check and write happen under the same lock.
 *
 * @returns List of paths successfully reserved.
 * @throws Error if any path conflicts with a live reservation from another agent.
 */
export async function reserve(
  session: string,
  paths: string[],
  agentId: string,
  agentName: string,
  reason?: string,
  onlineAgentIds?: string[]
): Promise<string[]> {
  const normalizedPaths = paths.map(normalizePath);
  const now = new Date().toISOString();

  await withJsonFile<ReservationsMap>(reservationsPath(session), {}, (reservations) => {
    // Check for conflicts with other agents
    for (const requestedPath of normalizedPaths) {
      for (const [existingPath, reservation] of Object.entries(reservations)) {
        if (reservation.agentId === agentId) continue; // no self-conflict
        if (!pathsOverlap(requestedPath, existingPath)) continue;

        // Check if the conflicting reservation is stale (agent offline)
        const isStale = onlineAgentIds
          ? !onlineAgentIds.includes(reservation.agentId)
          : false;

        if (!isStale) {
          const taskId = reservationTaskId(reservation);
          const guidance = taskId
            ? `Use amutix_task comment on ${taskId} to coordinate.`
            : `Use amutix_send('${reservation.agent}', ...) only for exceptional coordination.`;
          throw new Error(`Conflict: ${formatReservationConflict(existingPath, reservation)} ${guidance}`);
        }
      }
    }

    // All clear — add reservations
    for (const requestedPath of normalizedPaths) {
      reservations[requestedPath] = {
        agent: agentName,
        agentId,
        since: now,
        reason,
      };
    }
    return reservations;
  });

  return normalizedPaths;
}

/**
 * Release one or more reservations held by this agent.
 *
 * @returns List of paths actually released.
 */
export async function release(
  session: string,
  paths: string[],
  agentId: string
): Promise<string[]> {
  const normalizedPaths = paths.map(normalizePath);
  const released: string[] = [];

  await withJsonFile<ReservationsMap>(reservationsPath(session), {}, (reservations) => {
    for (const requestedPath of normalizedPaths) {
      const reservation = reservations[requestedPath];
      if (reservation && reservation.agentId === agentId) {
        delete reservations[requestedPath];
        released.push(requestedPath);
      }
    }
    return reservations;
  });

  return released;
}

/**
 * Check if a file path conflicts with any reservation from another agent.
 *
 * @returns ConflictInfo if a conflict exists, null otherwise.
 */
export async function checkConflict(
  session: string,
  filePath: string,
  agentId: string,
  onlineAgentIds?: string[]
): Promise<ConflictInfo | null> {
  const reservations = await getReservations(session);
  const normalizedFile = normalizePath(filePath);

  for (const [reservedPath, reservation] of Object.entries(reservations)) {
    if (reservation.agentId === agentId) continue; // own reservation
    if (!pathsOverlap(normalizedFile, reservedPath)) continue;

    const stale = onlineAgentIds
      ? !onlineAgentIds.includes(reservation.agentId)
      : false;

    return { reservedPath, reservation, stale };
  }

  return null;
}

/**
 * Remove reservations held by agents that are no longer online.
 *
 * @returns Number of stale reservations removed.
 */
export async function clearStaleReservations(
  session: string,
  onlineAgentIds: string[]
): Promise<number> {
  const onlineSet = new Set(onlineAgentIds);
  let removed = 0;

  await withJsonFile<ReservationsMap>(reservationsPath(session), {}, (reservations) => {
    for (const [path, reservation] of Object.entries(reservations)) {
      if (!onlineSet.has(reservation.agentId)) {
        delete reservations[path];
        removed++;
      }
    }
    return reservations;
  });

  return removed;
}
