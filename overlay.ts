import type { Theme, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Component, Focusable, TUI } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth, Key } from "@mariozechner/pi-tui";
import { PtyTerminalSession } from "pi-interactive-shell/pty-session";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { LoopManager, TrackedLoop } from "./loop-manager";

const OVERLAY_WIDTH_PERCENT = 92;
const OVERLAY_HEIGHT_PERCENT = 90;

const CHROME_TOP = 3; // border + header + border
const CHROME_BOTTOM = 3; // border + footer + border

function padRight(s: string, w: number): string {
  const vis = visibleWidth(s);
  return s + " ".repeat(Math.max(0, w - vis));
}

function tildePath(p: string | null): string {
  if (!p) return "";
  const home = process.env.HOME;
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}

function loopHeader(loop: TrackedLoop): string {
  const p = loop.worktree ?? loop.directory ?? loop.id;
  return tildePath(p);
}

/**
 * `ralph loops list --json` can report the in-place loop with an ID like `(primary)`,
 * which is not a valid CLI argument for commands like `loops history`, `loops diff`,
 * or `loops logs`.
 *
 * Best-effort: resolve the actual primary loop ID from `.ralph/current-loop-id`.
 */
function resolveLoopIdForCli(loop: TrackedLoop): string | null {
  if (loop.id !== "(primary)") return loop.id;

  const dir = loop.directory ?? loop.worktree;
  if (!dir) return null;

  try {
    const idFile = join(dir, ".ralph", "current-loop-id");
    const id = readFileSync(idFile, "utf-8").trim();
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

type ViewMode = "pty" | "history" | "diff";

export class RalphOverlay implements Component, Focusable {
  focused = false;

  private tui: TUI;
  private theme: Theme;
  private pi: ExtensionAPI;
  private loopManager: LoopManager;
  private done: (result: void) => void;
  private onAttach: (cwd: string) => void;

  private unsubscribe: (() => void) | null = null;

  private activeLoopId: string | null = null;
  private session: PtyTerminalSession | null = null;
  private sessionEphemeral = false; // true for log-follow sessions

  private view: ViewMode = "pty";
  private textViewTitle: string | null = null;
  private textViewLines: string[] = [];
  private textScroll = 0;
  private textLoading = false;

  private confirm: null | { action: string; command: string[]; label: string } = null;
  private footerMessage: string | null = null;

  private lastWidth = 0;
  private lastRows = 0;

  constructor(opts: {
    tui: TUI;
    theme: Theme;
    pi: ExtensionAPI;
    loopManager: LoopManager;
    done: (result: void) => void;
    onAttach: (cwd: string) => void;
  }) {
    this.tui = opts.tui;
    this.theme = opts.theme;
    this.pi = opts.pi;
    this.loopManager = opts.loopManager;
    this.done = opts.done;
    this.onAttach = opts.onAttach;

    this.unsubscribe = this.loopManager.onChange(() => {
      this.ensureFocusedSession();
      this.tui.requestRender();
    });

    this.ensureFocusedSession();
  }

  private overlayColsRows(): { cols: number; rows: number; termRows: number; innerWidth: number } {
    const overlayWidth = Math.floor((this.tui.terminal.columns * OVERLAY_WIDTH_PERCENT) / 100);
    const overlayHeight = Math.floor((this.tui.terminal.rows * OVERLAY_HEIGHT_PERCENT) / 100);
    const innerWidth = Math.max(20, overlayWidth - 4);
    const termRows = Math.max(3, overlayHeight - (CHROME_TOP + CHROME_BOTTOM));
    return { cols: innerWidth, rows: overlayHeight, termRows, innerWidth };
  }

  private disposeSessionIfEphemeral(): void {
    if (this.session && this.sessionEphemeral) {
      this.session.dispose();
    }
    this.session = null;
    this.sessionEphemeral = false;
  }

  private ensureFocusedSession(): void {
    const focused = this.loopManager.getFocused();
    if (!focused) {
      this.activeLoopId = null;
      this.disposeSessionIfEphemeral();
      return;
    }

    if (this.activeLoopId === focused.id) return;

    // Switching loops: drop ephemeral log-follow session.
    this.disposeSessionIfEphemeral();
    this.activeLoopId = focused.id;

    const { cols, termRows } = this.overlayColsRows();

    if (focused.source === "tool" && focused.ptySession) {
      this.footerMessage = null;
      this.session = focused.ptySession as PtyTerminalSession;
      this.sessionEphemeral = false;
      this.session.resize(cols, termRows);
      return;
    }

    // Discovered loop: follow logs.
    const loopId = resolveLoopIdForCli(focused);
    if (!loopId) {
      this.footerMessage = "Unable to resolve primary loop id (.ralph/current-loop-id missing)";
      this.session = null;
      this.sessionEphemeral = false;
      return;
    }

    this.footerMessage = null;
    const cmd = `ralph loops logs ${loopId} --follow`;
    const cwd = focused.directory ?? process.env.HOME ?? process.cwd();
    this.session = new PtyTerminalSession(
      {
        command: cmd,
        cwd,
        cols,
        rows: termRows,
        scrollback: 5000,
        ansiReemit: true,
      },
      {
        onData: () => this.tui.requestRender(),
        onExit: () => this.tui.requestRender(),
      },
    );
    this.sessionEphemeral = true;
  }

  private async runTextView(title: string, command: string[]): Promise<void> {
    this.view = title === "History" ? "history" : "diff";
    this.textViewTitle = title;
    this.textLoading = true;
    this.textViewLines = [];
    this.textScroll = 0;
    this.footerMessage = null;
    this.tui.requestRender();

    const focused = this.loopManager.getFocused();
    const cwd = focused?.directory ?? process.env.HOME ?? process.cwd();
    const res = await this.pi.exec("ralph", command, { timeout: 15000, cwd });
    const out = (res.stdout ?? "").replace(/\r\n/g, "\n");
    const err = (res.stderr ?? "").replace(/\r\n/g, "\n");

    if (res.code !== 0) {
      this.textViewLines = [`[error] ralph ${command.join(" ")}`, err || `exit code ${res.code}`];
    } else {
      const text = out.length > 0 ? out : "(no output)";
      this.textViewLines = text.split("\n");
    }

    this.textLoading = false;
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    // Escape behavior:
    // - If confirming: cancel confirmation
    // - If in a subview: return to PTY view
    // - Otherwise: close overlay
    if (matchesKey(data, Key.escape)) {
      if (this.confirm) {
        this.confirm = null;
        this.footerMessage = "Cancelled";
        this.tui.requestRender();
        return;
      }
      if (this.view !== "pty") {
        this.view = "pty";
        this.textScroll = 0;
        this.tui.requestRender();
        return;
      }
      this.close();
      return;
    }

    // Confirmation mode
    if (this.confirm) {
      if (data === "y" || data === "Y") {
        const { command, label } = this.confirm;
        this.confirm = null;
        void this.runAction(label, command);
        return;
      }
      if (data === "n" || data === "N") {
        this.confirm = null;
        this.footerMessage = "Cancelled";
        this.tui.requestRender();
        return;
      }
      return;
    }

    // View switching
    if (this.view !== "pty") {
      if (data === "q") {
        this.view = "pty";
        this.textScroll = 0;
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.up) || data === "k") {
        this.textScroll = Math.max(0, this.textScroll - 1);
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.down) || data === "j") {
        this.textScroll = Math.min(Math.max(0, this.textViewLines.length - 1), this.textScroll + 1);
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, "shift+up")) {
        this.textScroll = Math.max(0, this.textScroll - 10);
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, "shift+down")) {
        this.textScroll = Math.min(Math.max(0, this.textViewLines.length - 1), this.textScroll + 10);
        this.tui.requestRender();
        return;
      }
      return;
    }

    // Loop switching
    if (matchesKey(data, Key.left)) {
      this.loopManager.cycleFocus(-1);
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.loopManager.cycleFocus(1);
      return;
    }

    // Scroll
    if (matchesKey(data, "shift+up")) {
      this.session?.scrollUp(Math.max(1, (this.session.rows ?? 10) - 2));
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "shift+down")) {
      this.session?.scrollDown(Math.max(1, (this.session.rows ?? 10) - 2));
      this.tui.requestRender();
      return;
    }

    // Actions
    const focused = this.loopManager.getFocused();
    if (!focused) return;

    // "(primary)" is a display ID from `ralph loops list`, not a valid CLI argument.
    const isPrimary = focused.id === "(primary)";
    const resolvedId = resolveLoopIdForCli(focused);

    const primaryIdMissingMsg = "Unable to resolve primary loop id (.ralph/current-loop-id missing)";
    const cliId = resolvedId;

    if (data === "s") {
      // `ralph loops stop` can omit LOOP_ID to stop the active primary loop.
      const cmd = isPrimary ? ["loops", "stop"] : ["loops", "stop", cliId ?? focused.id];
      this.confirm = { action: "stop", label: "Stop", command: cmd };
      this.footerMessage = null;
      this.tui.requestRender();
      return;
    }
    if (data === "m") {
      // Merge doesn't apply to primary (in-place) loops.
      if (isPrimary) {
        this.footerMessage = "Merge not available for primary loop";
        this.tui.requestRender();
        return;
      }
      void this.runAction("Merge", ["loops", "merge", cliId ?? focused.id]);
      return;
    }
    if (data === "d") {
      if (isPrimary) {
        this.footerMessage = "Discard not available for primary loop (use stop)";
        this.tui.requestRender();
        return;
      }
      this.confirm = {
        action: "discard",
        label: "Discard",
        command: ["loops", "discard", "--yes", cliId ?? focused.id],
      };
      this.footerMessage = null;
      this.tui.requestRender();
      return;
    }
    if (data === "r") {
      if (!cliId) {
        this.footerMessage = primaryIdMissingMsg;
        this.tui.requestRender();
        return;
      }
      void this.runAction("Retry", ["loops", "retry", cliId]);
      return;
    }
    if (data === "H") {
      if (!cliId) {
        this.footerMessage = primaryIdMissingMsg;
        this.tui.requestRender();
        return;
      }
      void this.runTextView("History", ["loops", "history", cliId]);
      return;
    }
    if (data === "D") {
      if (!cliId) {
        this.footerMessage = primaryIdMissingMsg;
        this.tui.requestRender();
        return;
      }
      void this.runTextView("Diff", ["loops", "diff", cliId]);
      return;
    }
    if (data === "a") {
      const cwd = focused.worktree ?? focused.directory;
      if (cwd) {
        this.close();
        queueMicrotask(() => this.onAttach(cwd));
      } else {
        this.footerMessage = "No directory/worktree available to attach";
        this.tui.requestRender();
      }
      return;
    }

    // Default: send input to PTY (tool-started loop TUI)
    this.session?.write(data);
  }

  private async runAction(label: string, command: string[]): Promise<void> {
    this.footerMessage = `${label}...`;
    this.tui.requestRender();

    const focused = this.loopManager.getFocused();
    const cwd = focused?.directory ?? process.env.HOME ?? process.cwd();
    const res = await this.pi.exec("ralph", command, { timeout: 20000, cwd });
    if (res.code === 0) {
      this.footerMessage = `${label} OK`;
    } else {
      const err = (res.stderr ?? "").trim();
      const out = (res.stdout ?? "").trim();
      const detail = err || out || `exit code ${res.code}`;
      this.footerMessage = `${label} failed: ${detail.slice(0, 80)}`;
    }

    await this.loopManager.poll();
    this.tui.requestRender();
  }

  private close(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.disposeSessionIfEphemeral();
    this.done(undefined);
  }

  render(width: number): string[] {
    const th = this.theme;
    const border = (s: string) => th.fg("border", s);
    const accent = (s: string) => th.fg("accent", s);
    const dim = (s: string) => th.fg("dim", s);
    const warn = (s: string) => th.fg("warning", s);

    const innerWidth = width - 4;
    const row = (content: string) => border("│ ") + padRight(content, innerWidth) + border(" │");

    const lines: string[] = [];

    lines.push(border("╭" + "─".repeat(width - 2) + "╮"));

    const focused = this.loopManager.getFocused();
    const headerText = focused ? loopHeader(focused) : "No loops";
    const header = truncateToWidth(headerText, innerWidth, "...");
    const right = focused ? dim(`[${this.loopIndex()}]`) : "";
    const rightW = visibleWidth(right);
    const left = truncateToWidth(accent(header), Math.max(0, innerWidth - rightW - 1), "...");
    const headerLine = left + " ".repeat(Math.max(1, innerWidth - visibleWidth(left) - rightW)) + right;
    lines.push(row(headerLine));

    // Second header line: view + hints
    let hint = "←→ loop  s stop  m merge  d discard  r retry  a attach  H history  D diff  Esc close";
    if (this.view !== "pty") hint = `${this.textViewTitle ?? "View"} (q back, ↑↓ scroll)`;
    if (this.confirm) hint = warn(`Confirm ${this.confirm.action}? (y/n)`);
    lines.push(row(dim(truncateToWidth(hint, innerWidth, "..."))));

    lines.push(border("├" + "─".repeat(width - 2) + "┤"));

    const { cols, termRows } = this.overlayColsRows();
    if (cols !== this.lastWidth || termRows !== this.lastRows) {
      this.lastWidth = cols;
      this.lastRows = termRows;
      this.session?.resize(cols, termRows);
    }

    // Content
    if (this.view === "pty") {
      const viewport = this.session?.getViewportLines({ ansi: true }) ?? [];
      for (let i = 0; i < termRows; i++) {
        const line = viewport[i] ?? "";
        lines.push(row(truncateToWidth(line, innerWidth, "")));
      }
    } else {
      // Text views
      if (this.textLoading) {
        for (let i = 0; i < termRows; i++) {
          lines.push(row(dim(i === 0 ? "Loading..." : "")));
        }
      } else {
        const start = this.textScroll;
        const slice = this.textViewLines.slice(start, start + termRows);
        for (let i = 0; i < termRows; i++) {
          const line = slice[i] ?? "";
          lines.push(row(truncateToWidth(line, innerWidth, "")));
        }
      }
    }

    lines.push(border("├" + "─".repeat(width - 2) + "┤"));

    // Footer
    if (this.footerMessage) {
      lines.push(row(dim(truncateToWidth(this.footerMessage, innerWidth, "..."))));
    } else if (this.session?.isScrolledUp()) {
      lines.push(row(dim("Scrolled up (Shift+Down to follow)")));
    } else {
      lines.push(row(dim("")));
    }

    lines.push(border("╰" + "─".repeat(width - 2) + "╯"));

    return lines;
  }

  private loopIndex(): string {
    const loops = this.loopManager.getLoops();
    const focused = this.loopManager.getFocused();
    if (!focused || loops.length === 0) return "0/0";
    const idx = loops.findIndex((l) => l.id === focused.id);
    const pos = idx >= 0 ? idx + 1 : 1;
    return `${pos}/${loops.length}`;
  }

  invalidate(): void {
    this.lastWidth = 0;
    this.lastRows = 0;
  }

  dispose?(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.disposeSessionIfEphemeral();
  }
}
