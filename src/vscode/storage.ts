import type * as vscode from 'vscode';
import { STORAGE_KEY, deserialise } from '../core/storage/schema';
import type { Scheduler } from '../core/types';

/** The part of `vscode.Memento` that is used, so the adapter can be driven without a real workspace. */
export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export const SAVE_DEBOUNCE_MS = 1000;

export interface HistoryStorageDeps {
  memento: MementoLike;
  scheduler: Scheduler;
  log(msg: string): void;
}

/** Debounced writer for the persisted history (workspace Memento, key `fileShake.history`). */
export class HistoryStorage implements vscode.Disposable {
  private timer: { cancel(): void } | undefined;
  private build: (() => unknown) | undefined;
  private lastWrite: Thenable<void> | undefined;
  private disposed = false;
  writes = 0;

  constructor(private readonly deps: HistoryStorageDeps) {}

  /** Reads and validates what is stored. Never throws; invalid records are dropped. */
  load(): ReturnType<typeof deserialise> {
    try {
      return deserialise(this.deps.memento.get<unknown>(STORAGE_KEY));
    } catch (err) {
      this.deps.log(`could not read stored history: ${String(err)}`);
      return { events: [], sessions: [], recovered: 0 };
    }
  }

  /** Writes `build()` after the debounce. The value is built when it is written, so bursts cost one build. */
  schedule(build: () => unknown): void {
    if (this.disposed) return;
    this.build = build;
    if (this.timer !== undefined) return;
    this.timer = this.deps.scheduler.setTimeout(() => {
      this.timer = undefined;
      this.writeNow();
    }, SAVE_DEBOUNCE_MS);
  }

  /** Writes a pending value now and resolves when the Memento has taken it. */
  async flush(): Promise<void> {
    this.writeNow();
    await this.lastWrite;
  }

  /** Cancels a pending write and deletes the stored key. */
  async remove(): Promise<void> {
    this.timer?.cancel();
    this.timer = undefined;
    this.build = undefined;
    try {
      await this.deps.memento.update(STORAGE_KEY, undefined);
    } catch (err) {
      this.deps.log(`could not delete stored history: ${String(err)}`);
    }
  }

  /** Is there a stored copy at all? (an in-memory check of the Memento) */
  hasStored(): boolean {
    try {
      return this.deps.memento.get<unknown>(STORAGE_KEY) !== undefined;
    } catch {
      return false;
    }
  }

  get pending(): boolean {
    return this.timer !== undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.writeNow();
    this.disposed = true;
  }

  private writeNow(): void {
    this.timer?.cancel();
    this.timer = undefined;
    const build = this.build;
    this.build = undefined;
    if (build === undefined) return;
    try {
      this.writes += 1;
      this.lastWrite = Promise.resolve(this.deps.memento.update(STORAGE_KEY, build())).catch((err: unknown) => {
        this.deps.log(`could not save history: ${String(err)}`);
      });
    } catch (err) {
      this.deps.log(`could not save history: ${String(err)}`);
    }
  }
}
