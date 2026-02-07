import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { LoopManager } from "./loop-manager";
import { RalphWidget } from "./widget";
import { registerRalphLoopTool } from "./ralph-loop-tool";
import { RalphOverlay } from "./overlay";
import { InteractiveShellOverlay } from "pi-interactive-shell/overlay-component";
import { loadConfig } from "pi-interactive-shell/config";

type RalphDetection =
  | { available: true; path: string }
  | { available: false; reason: string };

async function detectRalph(pi: ExtensionAPI, _ctx: ExtensionContext): Promise<RalphDetection> {
  // Keep this fast. We only need to know whether the CLI exists.
  const result = await pi.exec("which", ["ralph"], { timeout: 2000 });

  if (result.code === 0) {
    const path = (result.stdout ?? "").trim();
    if (path.length > 0) return { available: true, path };
    // Defensive: `which` can succeed but return empty output in some shells.
    return { available: true, path: "ralph" };
  }

  const stderr = (result.stderr ?? "").trim();
  return {
    available: false,
    reason: stderr.length > 0 ? stderr : "ralph not found in PATH",
  };
}

export default function piRalphExtension(pi: ExtensionAPI) {
  const STATE_TYPE = "pi-ralph-state";

  let ralph: RalphDetection | null = null;
  let loopManager: LoopManager | null = null;
  let widgetUnsub: (() => void) | null = null;
  let focusPersistUnsub: (() => void) | null = null;
  let widgetActive = false;
  let lastPersistedFocusId: string | null = null;

  // Step 4: tool registration (execution checks availability at runtime)
  registerRalphLoopTool(pi, {
    getLoopManager: () => loopManager,
    isRalphAvailable: () => !!ralph && ralph.available,
  });

  // Step 9: cycle focused loop from the main editor
  pi.registerShortcut("ctrl+shift+r", {
    description: "Cycle focused ralph loop",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      if (!loopManager) {
        ctx.ui.notify("pi-ralph: no LoopManager (is ralph installed?)", "warning");
        return;
      }
      const next = loopManager.cycleFocus(1);
      if (!next) ctx.ui.notify("pi-ralph: no loops", "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ralph = await detectRalph(pi, ctx);

    if (ralph.available) {
      // Initialize core state even in print mode so the ralph_loop tool can work.
      if (!loopManager) loopManager = new LoopManager(pi);

      // Restore focused loop (best effort) from session branch.
      let restoredFocusId: string | null = null;
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type === "custom" && entry.customType === STATE_TYPE) {
          const id = (entry.data as any)?.focusedId;
          if (typeof id === "string" && id.length > 0) restoredFocusId = id;
        }
      }
      lastPersistedFocusId = restoredFocusId;

      // Prime state quickly so widget/overlay have something to show.
      await loopManager.poll();
      if (restoredFocusId) loopManager.setFocusById(restoredFocusId);

      // Only start timers and UI-driven state in interactive mode.
      if (ctx.hasUI) {
        // UX: keep loop status responsive for the TUI.
        loopManager.startPolling(10000);

        // Step 3: widget below editor
        const ensureWidget = () => {
          if (!loopManager || !ctx.hasUI) return;
          const loops = loopManager.getLoops();
          if (loops.length === 0) {
            if (widgetActive) {
              ctx.ui.setWidget("pi-ralph", undefined);
              widgetActive = false;
            }
            return;
          }

          if (!widgetActive) {
            ctx.ui.setWidget(
              "pi-ralph",
              (tui, theme) => new RalphWidget(tui, theme, loopManager!),
              { placement: "belowEditor" },
            );
            widgetActive = true;
          }
        };

        ensureWidget();
        widgetUnsub = loopManager.onChange(() => ensureWidget());

        // Persist focus changes without spamming (polling doesn't change focused id)
        focusPersistUnsub = loopManager.onChange(() => {
          if (!loopManager) return;
          const id = loopManager.getFocused()?.id ?? null;
          if (id && id !== lastPersistedFocusId) {
            pi.appendEntry(STATE_TYPE, { focusedId: id });
            lastPersistedFocusId = id;
          }
        });

        ctx.ui.notify(`pi-ralph loaded (ralph: ${ralph.path})`, "info");
      }
    } else {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `pi-ralph disabled: ${ralph.reason}. Install ralph and ensure it's on PATH.`,
          "warning",
        );
      }
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    widgetUnsub?.();
    widgetUnsub = null;
    focusPersistUnsub?.();
    focusPersistUnsub = null;

    if (ctx.hasUI) {
      ctx.ui.setWidget("pi-ralph", undefined);
      widgetActive = false;
    }

    loopManager?.stopPolling();
    loopManager = null;
  });

  pi.registerCommand("ralph", {
    description: "Open the ralph loop manager (pi-ralph)",
    handler: async (_args, ctx) => {
      // If /ralph is run before session_start finishes for some reason, detect on demand.
      if (!ralph) ralph = await detectRalph(pi, ctx);

      if (!ctx.hasUI) return;

      if (!ralph.available) {
        ctx.ui.notify(
          `ralph not found: ${ralph.reason}. pi-ralph can't start until ralph is installed.`,
          "error",
        );
        return;
      }

      // Ensure LoopManager exists (interactive mode only)
      if (!loopManager) {
        loopManager = new LoopManager(pi);
        // UX: keep loop status responsive for the TUI.
        loopManager.startPolling(10000);
      }

      const focused = loopManager.getFocused();
      const activeCount = loopManager.getLoops().length;

      if (!focused) {
        ctx.ui.notify(`pi-ralph: no loops detected (${activeCount} total)`, "info");
        return;
      }

      await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        const onAttach = (cwd: string) => {
          const shell = process.env.SHELL || "bash";
          const config = loadConfig(ctx.cwd);
          void ctx.ui.custom<void>((t2, theme2, _kb2, done2) => {
            // Ignore the interactive-shell result; returning closes the overlay.
            return new InteractiveShellOverlay(
              t2,
              theme2,
              { command: shell, cwd, reason: `attach: ${cwd}` },
              config,
              () => done2(undefined),
            );
          }, {
            overlay: true,
            overlayOptions: { width: "60%", maxHeight: "60%", anchor: "center", margin: 1 },
          });
        };

        return new RalphOverlay({ tui, theme, pi, loopManager: loopManager!, done, onAttach });
      }, {
        overlay: true,
        overlayOptions: {
          width: "60%",
          maxHeight: "60%",
          anchor: "center",
          margin: 1,
        },
      });
    },
  });
}
