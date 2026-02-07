import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import { PtyTerminalSession } from "pi-interactive-shell/pty-session";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { LoopManager } from "./loop-manager";

export const ralphLoopSchema = Type.Object({
  prompt: Type.String({ description: "What you want ralph to do" }),
  directory: Type.String({ description: "Project directory to run ralph in" }),
  config: Type.Optional(Type.String({ description: "ralph config source (default: ralph.yml)" })),
  maxIterations: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum iterations" })),
  backend: Type.Optional(Type.String({ description: "Backend/agent selector (passed to --agent)" })),
  customArgs: Type.Optional(Type.Array(Type.String(), { description: "Extra args passed after --" })),
});

export type RalphLoopInput = Static<typeof ralphLoopSchema>;

function shQuote(s: string): string {
  // POSIX-ish single-quote escaping.
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

function buildRalphRunCommand(params: RalphLoopInput): string {
  // TUI is enabled by default in ralph v2.4.4+; no --tui flag needed.
  const parts: string[] = ["ralph", "run", "-p", params.prompt];

  if (params.config) {
    parts.push("--config", params.config);
  }
  if (params.maxIterations) {
    parts.push("--max-iterations", String(params.maxIterations));
  }
  if (params.backend) {
    parts.push("--agent", params.backend);
  }
  if (params.customArgs && params.customArgs.length > 0) {
    parts.push("--", ...params.customArgs);
  }

  // Quote every arg except the program itself.
  const [bin, ...args] = parts;
  return `${bin} ${args.map(shQuote).join(" ")}`;
}

function extractLoopIds(jsonText: string): string[] {
  const trimmed = jsonText.trim();
  if (!trimmed) return [];
  const data = JSON.parse(trimmed);
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const item of data as any[]) {
    const id = typeof item?.id === "string" ? item.id : typeof item?.loop_id === "string" ? item.loop_id : undefined;
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * Try to discover a loop ID after spawning ralph.
 *
 * Strategy:
 * 1. Check `ralph loops list --json` for new parallel loops (worktree-based).
 * 2. Read `.ralph/current-loop-id` for the primary loop ID.
 *
 * `ralph loops list` only tracks parallel/worktree loops, not the primary loop
 * started by `ralph run`. The primary loop writes its ID to `.ralph/current-loop-id`.
 */
async function waitForNewLoopId(
  pi: ExtensionAPI,
  beforeIds: Set<string>,
  directory: string,
  beforePrimaryId: string | null,
  timeoutMs = 5000,
): Promise<string | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    // Check parallel loops first.
    const res = await pi.exec("ralph", ["loops", "list", "--json"], { timeout: 5000 });
    if (res.code === 0) {
      try {
        const afterIds = extractLoopIds(res.stdout ?? "");
        const diff = afterIds.filter((id) => !beforeIds.has(id));
        if (diff.length > 0) return diff[0]!;
      } catch {
        // ignore parse errors, retry
      }
    }

    // Check primary loop ID file.
    try {
      const idFile = join(directory, ".ralph", "current-loop-id");
      const currentId = (await readFile(idFile, "utf-8")).trim();
      if (currentId && currentId !== beforePrimaryId) return currentId;
    } catch {
      // file doesn't exist yet, retry
    }

    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

export function registerRalphLoopTool(pi: ExtensionAPI, opts: { getLoopManager: () => LoopManager | null; isRalphAvailable: () => boolean }) {
  pi.registerTool({
    name: "ralph_loop",
    label: "Ralph Loop",
    description: "Start a ralph loop in the background (ralph run).",
    parameters: ralphLoopSchema,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!opts.isRalphAvailable()) {
        return {
          content: [{ type: "text", text: "ralph not found in PATH. Install ralph to use ralph_loop." }],
          details: { error: "ralph-not-found" },
          isError: true,
        };
      }

      const loopManager = opts.getLoopManager();
      if (!loopManager) {
        return {
          content: [{ type: "text", text: "pi-ralph not initialized (LoopManager missing)." }],
          details: { error: "loop-manager-missing" },
          isError: true,
        };
      }

      // Validate directory exists/readable.
      try {
        await access(params.directory);
      } catch {
        return {
          content: [{ type: "text", text: `Directory not found or not accessible: ${params.directory}` }],
          details: { error: "invalid-directory", directory: params.directory },
          isError: true,
        };
      }

      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Cancelled" }], details: { cancelled: true } };
      }

      // Snapshot existing loop IDs so we can detect the new one.
      const before = await pi.exec("ralph", ["loops", "list", "--json"], { timeout: 5000, signal });
      const beforeIds = new Set<string>();
      if (before.code === 0) {
        try {
          for (const id of extractLoopIds(before.stdout ?? "")) beforeIds.add(id);
        } catch {
          // ignore
        }
      }

      // Read current primary loop ID before spawning.
      let beforePrimaryId: string | null = null;
      try {
        const idFile = join(params.directory, ".ralph", "current-loop-id");
        beforePrimaryId = (await readFile(idFile, "utf-8")).trim() || null;
      } catch {
        // no previous primary loop
      }

      const command = buildRalphRunCommand(params);

      // Spawn in a PTY so we can embed the native TUI later.
      const session = new PtyTerminalSession(
        {
          command,
          cwd: params.directory,
          cols: 120,
          rows: 40,
          scrollback: 5000,
          ansiReemit: true,
        },
        {
          onExit: () => {
            // LoopManager polling will pick up state change. Keep session for viewing.
            // No-op here for now.
          },
        },
      );

      // Try to discover loop ID shortly after spawn.
      const loopId = await waitForNewLoopId(pi, beforeIds, params.directory, beforePrimaryId);

      const id = loopId ?? `pid-${session.pid}`;

      loopManager.upsertToolLoop({
        id,
        pid: session.pid,
        directory: params.directory,
        ptySession: session,
      });

      if (ctx.hasUI) {
        ctx.ui.notify(`Started ralph loop ${id}`, "info");
      }

      return {
        content: [
          {
            type: "text",
            text:
              loopId
                ? `Started ralph loop ${loopId} (pid ${session.pid}) in ${params.directory}`
                : `Started ralph (pid ${session.pid}) in ${params.directory}. Loop ID not detected yet; using ${id}.`,
          },
        ],
        details: {
          loopId: id,
          pid: session.pid,
          directory: params.directory,
          command,
        },
      };
    },
  });
}
