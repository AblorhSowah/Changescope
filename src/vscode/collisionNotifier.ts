import * as vscode from 'vscode';
import { COLLISION_ACTIONS, collisionMessage, shouldNotify } from '../core/activity/collision';
import type { RawEvent } from '../core/activity/attribution';
import type { FileShakeConfig } from '../core/config';
import { basename } from '../core/pathUtils';
import type { Clock, FileKey } from '../core/types';
import { fileKeyFromUri, uriFromKey } from './uriKey';

/** Shows a warning and resolves to the chosen action label (or undefined when dismissed). Replaceable in tests. */
export type NotifyFn = (message: string, actions: readonly string[]) => Thenable<string | undefined>;

export interface CollisionNotifierDeps {
  clock: Clock;
  getConfig(): FileShakeConfig;
  log(msg: string): void;
}

const MAX_TRACKED = 200;

/**
 * Warns when something changes a file on disk while its document has unsaved edits. File Shake never
 * writes to or reloads the document: VS Code keeps the unsaved buffer, and the user decides.
 */
export class CollisionNotifier implements vscode.Disposable {
  private readonly lastAt = new Map<FileKey, number>();
  private notify: NotifyFn = (message, actions) => vscode.window.showWarningMessage(message, ...actions);
  private shown = 0;
  private lastMessage: string | undefined;
  private disposed = false;

  constructor(private readonly deps: CollisionNotifierDeps) {}

  /** Test seam: replaces the call that shows the warning. `undefined` restores the real one. */
  overrideNotify(fn: NotifyFn | undefined): void {
    this.notify = fn ?? ((message, actions) => vscode.window.showWarningMessage(message, ...actions));
  }

  stats(): { shown: number; last: string | undefined } {
    return { shown: this.shown, last: this.lastMessage };
  }

  onEvent(e: RawEvent): void {
    if (this.disposed || e.decision !== 'external' || e.origin !== 'watcher' || e.eventType === 'delete') return;
    const key = e.key;
    const doc = vscode.workspace.textDocuments.find((d) => d.isDirty && fileKeyFromUri(d.uri) === key);
    if (doc === undefined) return;
    const now = this.deps.clock.now();
    if (!shouldNotify(this.lastAt.get(key), now, this.deps.getConfig().collisionsNotify)) return;
    this.lastAt.delete(key);
    this.lastAt.set(key, now);
    while (this.lastAt.size > MAX_TRACKED) {
      const oldest = this.lastAt.keys().next();
      if (oldest.done) break;
      this.lastAt.delete(oldest.value);
    }
    const message = collisionMessage(basename(key));
    this.shown += 1;
    this.lastMessage = message;
    Promise.resolve(this.notify(message, [COLLISION_ACTIONS.COMPARE, COLLISION_ACTIONS.DISMISS])).then(
      (choice) => {
        if (choice === COLLISION_ACTIONS.COMPARE) void this.compare(key);
      },
      (err: unknown) => this.deps.log(`collision notification failed: ${String(err)}`),
    );
  }

  private async compare(key: FileKey): Promise<void> {
    try {
      await vscode.window.showTextDocument(uriFromKey(key), { preview: false });
      await vscode.commands.executeCommand('workbench.files.action.compareWithSaved');
    } catch (err) {
      this.deps.log(`compare with saved failed for ${key}: ${String(err)}`);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.lastAt.clear();
  }
}
