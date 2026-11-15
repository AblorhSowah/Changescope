import * as vscode from 'vscode';
import { SIGNAL_FILE_NAME, SIGNAL_LIMITS, SignalChunker, buildAgentHook, signalPrefixKept, signalTail } from '../core/ai/agentSignal';
import type { AgentAdapter, AgentSignal } from '../core/ai/agentSignal';
import type { ChangescopeConfig } from '../core/config';

/** `reportAgentActivity` on the extension API: always listening, nothing to configure. */
export class ApiAgentAdapter implements AgentAdapter {
  readonly id = 'api';
  readonly label = 'Extension API';

  state(): 'listening' {
    return 'listening';
  }

  detail(): string {
    return 'Other extensions can report agent writes with reportAgentActivity().';
  }

  dispose(): void {
    // nothing to release
  }
}

export interface SignalFileDeps {
  /** per-workspace storage folder of the extension; undefined without a workspace */
  storageUri: vscode.Uri | undefined;
  getConfig(): ChangescopeConfig;
  onSignal(signal: AgentSignal): void;
  log(msg: string): void;
}

/**
 * Experimental: reads agent writes from a JSON Lines file that a hook configured by the user appends to.
 * Changescope only reads it (and empties it when it grows past 1 MB). Off by default.
 */
export class SignalFileAdapter implements AgentAdapter {
  readonly id = 'signal-file';
  readonly label = 'Agent signal file (experimental)';

  private watcher: vscode.FileSystemWatcher | undefined;
  private subs: vscode.Disposable[] = [];
  /** bytes of the file already consumed */
  private offset = 0;
  /** the last bytes before `offset`, and the modification time, seen at the last read: they tell an append from a replaced file */
  private tail: Uint8Array = new Uint8Array(0);
  private mtime: number | undefined;
  private readonly chunker = new SignalChunker();
  private reading = false;
  private again = false;
  private active = false;
  private lastError = '';
  private disposed = false;

  constructor(private readonly deps: SignalFileDeps) {}

  /** Absolute path the hook has to append to, or undefined when there is no workspace storage. */
  filePath(): string | undefined {
    return this.fileUri()?.fsPath;
  }

  state(): 'listening' | 'off' | 'unavailable' {
    if (!this.deps.getConfig().agentSignals) return 'off';
    if (this.deps.storageUri === undefined || this.lastError !== '') return 'unavailable';
    return this.active ? 'listening' : 'off';
  }

  detail(): string {
    if (!this.deps.getConfig().agentSignals) return 'Off. Turn on changescope.experimental.agentSignals to read the signal file.';
    if (this.deps.storageUri === undefined) return 'Unavailable: this window has no workspace storage (open a folder).';
    if (this.lastError !== '') return `Unavailable: ${this.lastError}`;
    return this.active ? 'Reading the signal file written by a hook you configured.' : 'Starting.';
  }

  /** Follows the setting: starts or stops reading. */
  async applyConfig(): Promise<void> {
    const want = this.deps.getConfig().agentSignals && this.deps.storageUri !== undefined;
    if (want && !this.active) await this.start();
    else if (!want && this.active) this.stop();
  }

  /** Makes sure the folder the hook writes into exists, and returns the file path. */
  async prepare(): Promise<string | undefined> {
    const dir = this.deps.storageUri;
    if (dir === undefined) return undefined;
    try {
      await vscode.workspace.fs.createDirectory(dir);
    } catch (err) {
      this.deps.log(`could not create the signal file folder: ${String(err)}`);
    }
    return this.filePath();
  }

  /** The hook snippet for this signal file (see `buildAgentHook`). */
  hook(): { command: string; settings: string } | undefined {
    const path = this.filePath();
    return path === undefined ? undefined : buildAgentHook(path);
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  // ----------------------------------------------------------------------------

  private fileUri(): vscode.Uri | undefined {
    const dir = this.deps.storageUri;
    return dir === undefined ? undefined : vscode.Uri.joinPath(dir, SIGNAL_FILE_NAME);
  }

  private async start(): Promise<void> {
    const uri = this.fileUri();
    const dir = this.deps.storageUri;
    if (uri === undefined || dir === undefined || this.disposed) return;
    this.lastError = '';
    this.active = true;
    try {
      await vscode.workspace.fs.createDirectory(dir);
      // what is already in the file happened before Changescope started listening
      this.forget();
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        const bytes = await vscode.workspace.fs.readFile(uri);
        this.offset = bytes.length;
        this.tail = signalTail(bytes, bytes.length);
        this.mtime = stat.mtime;
      } catch {
        // no file yet: everything that is written from now on is new
      }
      if (this.disposed || !this.active) return;
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, SIGNAL_FILE_NAME));
      this.watcher = watcher;
      this.subs.push(
        watcher,
        watcher.onDidChange(() => void this.read()),
        watcher.onDidCreate(() => void this.read()),
      );
    } catch (err) {
      this.lastError = 'the signal file folder could not be prepared.';
      this.active = false;
      this.deps.log(`signal file adapter could not start: ${String(err)}`);
    }
  }

  /** Start reading from the beginning of a file that was emptied or replaced. */
  private forget(): void {
    this.offset = 0;
    this.tail = new Uint8Array(0);
    this.mtime = undefined;
    this.chunker.reset();
  }

  private stop(): void {
    this.active = false;
    for (const s of this.subs) s.dispose();
    this.subs = [];
    this.watcher = undefined;
  }

  /** Reads what was appended since the last read. Overlapping triggers are coalesced into one more read. */
  private async read(): Promise<void> {
    if (this.reading) {
      this.again = true;
      return;
    }
    const uri = this.fileUri();
    if (uri === undefined || !this.active) return;
    this.reading = true;
    try {
      do {
        this.again = false;
        let stat: vscode.FileStat;
        try {
          stat = await vscode.workspace.fs.stat(uri);
        } catch {
          continue; // not there (yet)
        }
        if (stat.size === this.offset && stat.mtime === this.mtime) continue; // nothing was written
        const bytes = await vscode.workspace.fs.readFile(uri);
        // emptied and written again (shorter, equal or longer) rather than appended to: read it from its start
        if (bytes.length < this.offset || !signalPrefixKept(bytes, this.offset, this.tail)) this.forget();
        const parsed = this.chunker.push(bytes.subarray(this.offset));
        this.offset = bytes.length;
        this.tail = signalTail(bytes, bytes.length);
        this.mtime = stat.mtime;
        for (const signal of parsed.signals) this.deps.onSignal(signal);
        if (this.offset > SIGNAL_LIMITS.FILE) {
          // Changescope owns the size of this file: empty it once it is too big
          try {
            await vscode.workspace.fs.writeFile(uri, new Uint8Array());
            this.forget();
          } catch (err) {
            this.deps.log(`could not empty the signal file: ${String(err)}`);
          }
        }
      } while (this.again && this.active && !this.disposed);
    } catch (err) {
      this.deps.log(`signal file read failed: ${String(err)}`);
    } finally {
      this.reading = false;
    }
  }
}
