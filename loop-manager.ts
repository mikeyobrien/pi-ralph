import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export type LoopSource = "tool" | "discovered";

export interface TrackedLoop {
  id: string;
  pid: number | null;

  // Best-effort paths. Ralph's JSON schema has changed across versions.
  directory: string | null;
  worktree: string | null;

  status: string; // running/completed/needs-review/... plus any unknown states

  iteration: number;
  maxIterations: number;
  hat: string | null;
  elapsedSecs: number;
  backend: string | null;

  source: LoopSource;

  // Step 4/5 will populate this for tool-started loops.
  ptySession: unknown | null;

  // If a loop disappears from polling results, we keep it but mark it removed.
  removed: boolean;
  lastSeenAt: number;
}

/**
 * LoopManager is the core state holder for pi-ralph.
 *
 * Step 2 responsibilities:
 * - Poll `ralph loops list --json`
 * - Maintain a merged list of TrackedLoop objects
 * - Track a focused loop index (for widget/overlay cycling)
 */
export class LoopManager {
  private readonly pi: ExtensionAPI;

  private loops: TrackedLoop[] = [];
  private focusedIndex = 0;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;

  private changeListeners = new Set<() => void>();

  // Diagnostics
  public consecutivePollFailures = 0;
  public lastPollError: string | null = null;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private emitChange(): void {
    for (const l of this.changeListeners) l();
  }

  getLoops(options?: { includeRemoved?: boolean }): TrackedLoop[] {
    const includeRemoved = options?.includeRemoved ?? false;
    return includeRemoved ? [...this.loops] : this.loops.filter((l) => !l.removed);
  }

  getFocused(): TrackedLoop | null {
    const active = this.getLoops();
    if (active.length === 0) return null;

    // Clamp focused index against active list.
    const idx = Math.min(Math.max(this.focusedIndex, 0), active.length - 1);
    this.focusedIndex = idx;
    return active[idx] ?? null;
  }

  cycleFocus(direction: 1 | -1 = 1): TrackedLoop | null {
    const active = this.getLoops();
    if (active.length === 0) {
      this.focusedIndex = 0;
      this.emitChange();
      return null;
    }

    const n = active.length;
    this.focusedIndex = (this.focusedIndex + direction + n) % n;
    this.emitChange();
    return active[this.focusedIndex] ?? null;
  }

  async poll(signal?: AbortSignal): Promise<TrackedLoop[] | null> {
    if (this.pollInFlight) return null;
    this.pollInFlight = true;

    try {
      // Collect unique project directories from known loops.
      // `ralph loops list` must be run from a directory with ralph.yml.
      const dirs = new Set<string>();
      for (const loop of this.loops) {
        if (loop.directory) dirs.add(loop.directory);
      }
      // Fallback: try cwd if no directories known.
      if (dirs.size === 0) dirs.add(process.cwd());

      // Poll each directory and merge all results.
      let allParsed: TrackedLoop[] = [];
      let anySuccess = false;

      for (const dir of dirs) {
        const result = await this.pi.exec("ralph", ["loops", "list", "--json"], {
          timeout: 5000,
          signal,
          cwd: dir,
        });
        if (result.code === 0) {
          anySuccess = true;
          const stdout = (result.stdout ?? "").trim();
          try {
            const parsed = this.parseLoopsJson(stdout);
            // Tag discovered loops with the project directory they were found in.
            // `ralph loops list` doesn't include absolute paths, so we set directory
            // from the cwd used for polling.
            for (const loop of parsed) {
              if (!loop.directory) loop.directory = dir;
            }
            allParsed = allParsed.concat(parsed);
          } catch {
            // ignore parse errors for this directory
          }
        }
      }

      // Deduplicate by ID (same loop might appear from different dirs).
      const byId = new Map<string, TrackedLoop>();
      for (const loop of allParsed) byId.set(loop.id, loop);
      allParsed = Array.from(byId.values());

      const result = anySuccess
        ? { code: 0, stdout: "", stderr: "" }
        : { code: 1, stdout: "", stderr: "all poll attempts failed" };

      if (!anySuccess) {
        this.consecutivePollFailures++;
        this.lastPollError = "all poll attempts failed";
        return null;
      }

      this.mergePolled(allParsed);

      this.consecutivePollFailures = 0;
      this.lastPollError = null;

      return this.getLoops();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.consecutivePollFailures++;
      this.lastPollError = msg;
      return null;
    } finally {
      this.pollInFlight = false;
    }
  }

  startPolling(intervalMs = 5000): void {
    if (this.pollTimer) return;

    // Fire once immediately.
    void this.poll();

    this.pollTimer = setInterval(() => {
      void this.poll();
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Add or update a loop that was started by the tool.
   * Polling may later fill in additional fields.
   */
  upsertToolLoop(loop: {
    id: string;
    pid: number;
    directory: string;
    worktree?: string | null;
    command?: string;
    ptySession: unknown;
  }): void {
    const now = Date.now();
    const existingIdx = this.loops.findIndex((l) => l.id === loop.id);

    const next: TrackedLoop = {
      id: loop.id,
      pid: loop.pid,
      directory: loop.directory,
      worktree: loop.worktree ?? null,
      status: "running",
      iteration: 0,
      maxIterations: 0,
      hat: null,
      elapsedSecs: 0,
      backend: null,
      source: "tool",
      ptySession: loop.ptySession,
      removed: false,
      lastSeenAt: now,
    };

    if (existingIdx >= 0) {
      this.loops[existingIdx] = {
        ...this.loops[existingIdx]!,
        ...next,
        source: "tool",
        ptySession: loop.ptySession,
        removed: false,
        lastSeenAt: now,
      };
    } else {
      this.loops.push(next);
      // If this is the first active loop, focus it.
      if (this.getLoops().length === 1) this.focusedIndex = 0;
    }

    this.emitChange();
  }

  setFocusById(id: string): void {
    const active = this.getLoops();
    const idx = active.findIndex((l) => l.id === id);
    if (idx >= 0) {
      this.focusedIndex = idx;
      this.emitChange();
    }
  }

  /**
   * Merge the latest polled loops into state.
   *
   * - Adds new loops
   * - Updates existing loops
   * - Marks missing loops as removed
   */
  mergePolled(polled: TrackedLoop[]): void {
    const now = Date.now();
    const byId = new Map<string, TrackedLoop>(this.loops.map((l) => [l.id, l]));
    const seen = new Set<string>();

    for (const next of polled) {
      seen.add(next.id);
      let existing = byId.get(next.id);

      // When polling returns "(primary)", try to match it to a tool-started primary
      // loop in the same directory. The tool assigns IDs like "primary-20260207-..."
      // from .ralph/current-loop-id, but `ralph loops list` uses "(primary)".
      if (!existing && next.id === "(primary)") {
        for (const [existId, existLoop] of byId) {
          if (
            existLoop.source === "tool" &&
            existId.startsWith("primary-") &&
            existLoop.directory === next.directory
          ) {
            // Found the match. Replace the tool-assigned ID with "(primary)"
            // so that ralph CLI commands (stop, merge, etc.) use the right ID.
            byId.delete(existId);
            existing = existLoop;
            break;
          }
        }
      }

      if (!existing) {
        byId.set(next.id, {
          ...next,
          removed: false,
          lastSeenAt: now,
        });
        continue;
      }

      // Preserve fields that polling can't reconstruct yet (ptySession, source when tool-started).
      // Don't overwrite a known directory with display-only values like "(in-place)".
      const directory = (next.directory && !next.directory.startsWith("("))
        ? next.directory
        : existing.directory;
      const worktree = next.worktree ?? existing.worktree;

      byId.set(next.id, {
        ...existing,
        ...next,
        directory,
        worktree,
        source: existing.source,
        ptySession: existing.ptySession,
        removed: false,
        lastSeenAt: now,
      });
    }

    // Mark missing loops as removed — but never mark tool-sourced loops as removed
    // based on polling alone. Tool loops track liveness via their PTY session, not
    // via `ralph loops list` which may not include them (e.g. primary loops).
    for (const loop of byId.values()) {
      if (!seen.has(loop.id) && loop.source !== "tool") {
        loop.removed = true;
      }
    }

    // Keep stable ordering: existing order first, then new ones.
    const prevOrder = this.loops.map((l) => l.id);
    const nextIds = Array.from(byId.keys());

    const orderedIds: string[] = [];
    for (const id of prevOrder) if (byId.has(id)) orderedIds.push(id);
    for (const id of nextIds) if (!orderedIds.includes(id)) orderedIds.push(id);

    this.loops = orderedIds.map((id) => byId.get(id)!).filter(Boolean);

    // Clamp focus to active loops.
    const active = this.getLoops();
    if (active.length === 0) this.focusedIndex = 0;
    else this.focusedIndex = Math.min(this.focusedIndex, active.length - 1);

    this.emitChange();
  }

  private parseLoopsJson(stdout: string): TrackedLoop[] {
    if (!stdout) return [];

    let data: unknown;
    try {
      data = JSON.parse(stdout);
    } catch {
      throw new Error("Failed to parse JSON from `ralph loops list --json`");
    }

    if (!Array.isArray(data)) {
      throw new Error("Unexpected JSON shape from `ralph loops list --json` (expected array)");
    }

    const now = Date.now();

    return data
      .map((raw: any): TrackedLoop | null => {
        const id: string | undefined =
          typeof raw?.loop_id === "string" ? raw.loop_id : typeof raw?.id === "string" ? raw.id : undefined;
        if (!id) return null;

        const status: string =
          typeof raw?.state === "string"
            ? raw.state
            : typeof raw?.status === "string"
              ? raw.status
              : "unknown";

        const pid: number | null = typeof raw?.pid === "number" ? raw.pid : null;

        const worktree: string | null = typeof raw?.worktree === "string" ? raw.worktree : null;

        // Ralph 2.4.4 emits `location` in JSON list output. It might be a worktree name or a path.
        const location: string | null = typeof raw?.location === "string" ? raw.location : null;

        // Best effort: directory is either `directory`, `path`, `workspace`, or `worktree_path`.
        // Exclude display-only values like "(in-place)" or bare location names like "chipper-crane".
        const isAbsPath = (s: string | null) => s != null && s.length > 0 && s.startsWith("/");
        const workspace: string | null = typeof raw?.workspace === "string" ? raw.workspace : null;
        const worktreePath: string | null = typeof raw?.worktree_path === "string" ? raw.worktree_path : null;
        const directory: string | null =
          typeof raw?.directory === "string" && isAbsPath(raw.directory)
            ? raw.directory
            : typeof raw?.path === "string" && isAbsPath(raw.path)
              ? raw.path
              : isAbsPath(workspace)
                ? workspace
                : isAbsPath(worktreePath)
                  ? worktreePath
                  : null;

        const iteration: number = typeof raw?.iteration === "number" ? raw.iteration : 0;
        const maxIterations: number =
          typeof raw?.max_iterations === "number"
            ? raw.max_iterations
            : typeof raw?.maxIterations === "number"
              ? raw.maxIterations
              : 0;

        const elapsedSecs: number =
          typeof raw?.elapsed_secs === "number"
            ? raw.elapsed_secs
            : typeof raw?.elapsedSecs === "number"
              ? raw.elapsedSecs
              : 0;

        const hat: string | null = typeof raw?.hat === "string" ? raw.hat : null;
        const backend: string | null = typeof raw?.backend === "string" ? raw.backend : null;

        return {
          id,
          pid,
          directory,
          worktree,
          status,
          iteration,
          maxIterations,
          hat,
          elapsedSecs,
          backend,
          source: "discovered",
          ptySession: null,
          removed: false,
          lastSeenAt: now,
        };
      })
      .filter((x): x is TrackedLoop => x !== null);
  }
}
