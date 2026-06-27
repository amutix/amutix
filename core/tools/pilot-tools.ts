/**
 * Pilot neutral tool definitions.
 *
 * The first two stateless/read-mostly tools migrated to the neutral registry
 * (SPEC-18 Slice 1): `amutix_artifacts` and `amutix_list`. They validate the
 * neutral AmutixToolDefinition shape end-to-end before larger tools migrate.
 */

import { readdirSync } from "node:fs";
import {
  type AgentInfo,
  getOnlineAgents,
  readAllRegistries,
  isEffectivelyOnline,
  formatAddress,
} from "../registry.ts";
import { readBacklog, type BacklogItem } from "../backlog.ts";
import { projectArtifactsPath } from "../project-context.ts";
import { sessionFile } from "../storage.ts";
import { renderAgentPresence } from "../renderers.ts";
import {
  type AmutixToolContext,
  type AmutixToolDefinition,
  type AmutixToolResult,
  boolProp,
  objectSchema,
  optionalBoolProp,
} from "./types.ts";

/** List non-hidden files in a directory (empty array if missing/unreadable). */
function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => !f.startsWith("."));
  } catch {
    return [];
  }
}

// ─── amutix_artifacts ──────────────────────────────────────────

/** `amutix_artifacts` params. */
export interface ArtifactsParams {
  // Stateless tool: no parameters.
}

/** Neutral amutix_artifacts tool: list project + private artifact files. */
export const artifactsTool: AmutixToolDefinition<ArtifactsParams> = {
  name: "amutix_artifacts",
  aliases: ["amux_artifacts"],
  label: "List Artifacts",
  description:
    "List shared documents at project and agent levels. " +
    "Use read/write/edit tools to work with the files directly.",
  promptSnippet: "List shared artifacts at project or agent level",
  inputSchema: objectSchema({}),
  async execute(ctx: AmutixToolContext): Promise<AmutixToolResult> {
    const sections: string[] = [];

    // Project level
    const projDir = projectArtifactsPath(ctx.session);
    const projFiles = listFiles(projDir);
    sections.push(
      `Project (${projDir}):\n` +
        (projFiles.length > 0 ? projFiles.map((f) => `  - ${f}`).join("\n") : "  (empty)"),
    );

    // Agent (private) level
    const aDir = sessionFile(ctx.session, "artifacts", "agents", ctx.agentId);
    const aFiles = listFiles(aDir);
    sections.push(
      `Private (${aDir}):\n` +
        (aFiles.length > 0 ? aFiles.map((f) => `  - ${f}`).join("\n") : "  (empty)"),
    );

    return { text: sections.join("\n\n") };
  },
};

// ─── amutix_list ───────────────────────────────────────────────

/** `amutix_list` params. */
export interface ListParams {
  allSessions?: boolean;
}

/** Neutral amutix_list tool: list online agents, optionally across sessions. */
export const listTool: AmutixToolDefinition<ListParams> = {
  name: "amutix_list",
  aliases: ["amux_list"],
  label: "List Agents",
  description:
    "List online amux agents with their session, name, role, and status. " +
    "Set allSessions=true to include agents from other sessions.",
  promptSnippet:
    "List online amux agents and their roles/status (supports cross-session discovery)",
  inputSchema: objectSchema(
    {
      allSessions: optionalBoolProp("If true, list agents from all sessions. Default: false."),
    },
  ),
  async execute(ctx: AmutixToolContext, params: ListParams): Promise<AmutixToolResult> {
    let agents: AgentInfo[];
    if (params.allSessions) {
      agents = (await readAllRegistries()).filter(isEffectivelyOnline);
    } else {
      agents = await getOnlineAgents(ctx.session);
    }

    if (agents.length === 0) {
      return { text: "No agents online.", details: { agents: [] } };
    }

    // Group by session
    const bySession = new Map<string, AgentInfo[]>();
    for (const a of agents) {
      const sess = a.session || ctx.session;
      if (!bySession.has(sess)) bySession.set(sess, []);
      bySession.get(sess)!.push(a);
    }

    const sections: string[] = [];
    const backlogBySession = new Map<string, BacklogItem[]>();
    for (const [session, sessionAgents] of bySession) {
      const isCurrent = session === ctx.session;
      const header = isCurrent ? `Session: ${session} (current)` : `Session: ${session}`;
      if (!backlogBySession.has(session)) {
        backlogBySession.set(session, await readBacklog(session));
      }
      const backlog = backlogBySession.get(session)!;
      const lines = sessionAgents.map((a) =>
        renderAgentPresence(a, backlog, {
          currentAgentId: ctx.agentId,
          address: formatAddress(session, a.name),
          includeCwd: true,
        }),
      );
      sections.push(`${header}\n${lines.join("\n")}`);
    }

    return { text: sections.join("\n\n"), details: { agents } };
  },
};

// Re-export boolProp for external consumers/tests that build schemas directly.
export { boolProp };
