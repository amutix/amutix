/**
 * Neutral project artifact management tools.
 *
 * Migrates `amutix_project` and `amutix_wow` out of the Pi adapter while keeping
 * slash commands in Pi. These tools manage project-scoped prompt artifacts:
 * CONTEXT.md and WOW.md.
 */

import {
  projectContextPath,
  readProjectContext,
  writeProjectContext,
  appendProjectContext,
  clearProjectContext,
} from "../project-context.ts";
import {
  readWaysOfWorking,
  writeWaysOfWorking,
  appendWaysOfWorking,
  clearWaysOfWorking,
  wowPath,
} from "../ways-of-working.ts";
import {
  type AmutixToolContext,
  type AmutixToolDefinition,
  type AmutixToolResult,
  enumProp,
  objectSchema,
  optionalStringProp,
} from "./types.ts";

const ARTIFACT_ACTIONS = ["show", "set", "append", "clear", "path"] as const;
type ArtifactAction = typeof ARTIFACT_ACTIONS[number];

interface ManagedArtifactParams {
  action: ArtifactAction;
  content?: string;
}

interface ManagedArtifactToolConfig {
  emptyText: string;
  showHeader: string;
  setText: string;
  appendText: string;
  clearText: string;
  read(session: string, maxLength?: number): string | null;
  write(session: string, content: string): string;
  append(session: string, content: string): string;
  clear(session: string): string;
  path(session: string): string;
}

async function executeManagedArtifactTool(
  ctx: AmutixToolContext,
  params: ManagedArtifactParams,
  config: ManagedArtifactToolConfig,
): Promise<AmutixToolResult> {
  switch (params.action) {
    case "show": {
      const content = config.read(ctx.session);
      const path = config.path(ctx.session);
      if (!content) return { text: config.emptyText, details: { path, content: null } };
      return { text: `${config.showHeader} (${path}):\n\n${content}`, details: { path, content } };
    }
    case "set": {
      const text = params.content?.trim();
      if (!text) throw new Error("content is required for action=set");
      const path = config.write(ctx.session, text);
      return { text: config.setText, details: { path, content: text } };
    }
    case "append": {
      const text = params.content?.trim();
      if (!text) throw new Error("content is required for action=append");
      const path = config.append(ctx.session, text);
      const content = config.read(ctx.session, 0);
      return { text: config.appendText, details: { path, content } };
    }
    case "clear": {
      const path = config.clear(ctx.session);
      return { text: config.clearText, details: { path, content: "" } };
    }
    case "path": {
      const path = config.path(ctx.session);
      return { text: path, details: { path } };
    }
    default:
      throw new Error(`Unknown action: ${params.action}`);
  }
}

function managedArtifactSchema(contentDescription: string) {
  return objectSchema(
    {
      action: enumProp(ARTIFACT_ACTIONS, "Action to perform"),
      content: optionalStringProp(contentDescription),
    },
    ["action"],
  );
}

// ─── amutix_project ────────────────────────────────────────────

export const projectTool: AmutixToolDefinition<ManagedArtifactParams> = {
  name: "amutix_project",
  aliases: ["amux_project"],
  label: "Project Vision/Context",
  description:
    "Manage the current project's vision/context alignment artifact. " +
    "Actions: show, set, append, clear, path. Stored as artifacts/project/CONTEXT.md " +
    "and injected into future agent prompts.",
  promptSnippet: "Manage project vision/context (show, set, append, clear, path)",
  promptGuidelines: [
    "Use amutix_project to set a project vision/context during setup before assigning work.",
    "Prefer amutix_project over directly editing CONTEXT.md; the file is an implementation detail.",
    "Keep project context concise: goal, constraints, working principles, and north star.",
  ],
  inputSchema: managedArtifactSchema("Project vision/context text (required for set and append)"),
  execute(ctx, params) {
    return executeManagedArtifactTool(ctx, params, {
      emptyText: "No project vision/context set. Use amutix_project action=set to create one.",
      showHeader: "Project vision/context",
      setText: "Project vision/context set. Changes affect future agent prompts.",
      appendText: "Appended to project vision/context. Changes affect future agent prompts.",
      clearText: "Project vision/context cleared. Changes affect future agent prompts.",
      read: readProjectContext,
      write: writeProjectContext,
      append: appendProjectContext,
      clear: clearProjectContext,
      path: projectContextPath,
    });
  },
};

// ─── amutix_wow ────────────────────────────────────────────────

export const wowTool: AmutixToolDefinition<ManagedArtifactParams> = {
  name: "amutix_wow",
  aliases: ["amux_wow"],
  label: "Ways of Working",
  description:
    "Manage the team's Ways of Working artifact. " +
    "Actions: show, set, append, clear, path. Stored as artifacts/project/WOW.md " +
    "and injected into future agent prompts after common principles.",
  promptSnippet: "Manage team Ways of Working (show, set, append, clear, path)",
  promptGuidelines: [
    "Use amutix_wow to define team collaboration norms (review policy, communication, definition of done).",
    "WoW extends the built-in common principles with project-specific norms.",
    "Keep WoW concise — it is prompt-injected into every agent turn.",
  ],
  inputSchema: managedArtifactSchema("WoW text (required for set and append)"),
  execute(ctx, params) {
    return executeManagedArtifactTool(ctx, params, {
      emptyText: "No Ways of Working set. Use amutix_wow action=set to create one.",
      showHeader: "Ways of Working",
      setText: "Ways of Working set. Changes affect future agent prompts.",
      appendText: "Appended to Ways of Working. Changes affect future agent prompts.",
      clearText: "Ways of Working cleared. Changes affect future agent prompts.",
      read: readWaysOfWorking,
      write: writeWaysOfWorking,
      append: appendWaysOfWorking,
      clear: clearWaysOfWorking,
      path: wowPath,
    });
  },
};
