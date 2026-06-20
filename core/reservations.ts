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

import { normalize } from "node:path";

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
 * Either one is a prefix of the other.
 */
export function pathsOverlap(pathA: string, pathB: string): boolean {
  return pathA.startsWith(pathB) || pathB.startsWith(pathA);
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
          const reasonStr = reservation.reason ? ` (${reservation.reason})` : "";
          throw new Error(
            `Conflict: "${existingPath}" is reserved by ${reservation.agent}${reasonStr}. ` +
              `Use amux_send('${reservation.agent}', ...) to coordinate.`
          );
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
