import type { Theme } from "@mariozechner/pi-coding-agent";
import type { Component, TUI } from "@mariozechner/pi-tui";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { LoopManager, TrackedLoop } from "./loop-manager";

function formatDuration(secs: number): string {
  if (!Number.isFinite(secs) || secs <= 0) return "0s";
  const s = Math.floor(secs);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const ss = s % 60;
  const mm = m % 60;
  if (h > 0) return `${h}h${mm}m`;
  if (m > 0) return `${m}m${ss}s`;
  return `${ss}s`;
}

function tildePath(p: string | null): string {
  if (!p) return "";
  const home = process.env.HOME;
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}

function loopDisplayPath(loop: TrackedLoop): string {
  const p = loop.worktree ?? loop.directory ?? "";
  return tildePath(p);
}

export class RalphWidget implements Component {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly loopManager: LoopManager;
  private unsubscribe: (() => void) | null = null;

  constructor(tui: TUI, theme: Theme, loopManager: LoopManager) {
    this.tui = tui;
    this.theme = theme;
    this.loopManager = loopManager;

    this.unsubscribe = this.loopManager.onChange(() => {
      this.tui.requestRender();
    });
  }

  render(width: number): string[] {
    const loops = this.loopManager.getLoops();
    if (loops.length === 0) return [];

    const focused = this.loopManager.getFocused();
    if (!focused) return [];

    const idx = loops.findIndex((l) => l.id === focused.id);
    const pos = idx >= 0 ? idx + 1 : 1;

    const prefix = this.theme.fg("accent", "ralph ") + this.theme.fg("dim", "> ");
    const path = loopDisplayPath(focused) || focused.id;

    const iter = focused.maxIterations > 0 ? `[${focused.iteration}/${focused.maxIterations}]` : "";
    const hat = focused.hat ? focused.hat : "";
    const elapsed = focused.elapsedSecs > 0 ? formatDuration(focused.elapsedSecs) : "";

    const status = focused.status && focused.status !== "unknown" ? focused.status : "";
    const right = this.theme.fg("dim", ` [${pos}/${loops.length}]`);

    // Compose, then truncate to width.
    let mid = this.theme.fg("text", path);
    if (iter) mid += " " + this.theme.fg("muted", iter);
    if (hat) mid += " " + this.theme.fg("accent", hat);
    if (elapsed) mid += " " + this.theme.fg("dim", elapsed);
    if (status) mid += " " + this.theme.fg("dim", status);

    const full = prefix + mid + right;

    // Truncate while preserving the right-side loop index.
    const rightWidth = visibleWidth(right);
    const maxLeft = Math.max(0, width - rightWidth);
    const left = truncateToWidth(prefix + mid, maxLeft, "...");

    return [truncateToWidth(left + right, width, "")];
  }

  invalidate(): void {
    // Theme change will recreate the widget via setWidget factory in index.ts.
  }

  dispose?(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
