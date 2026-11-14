import * as vscode from 'vscode';
import { ProviderRegistry, canSend, consentMessage } from '../core/ai/provider';
import type { AiProvider, AiRequest, Consent, SummaryInput } from '../core/ai/provider';
import { localSummary } from '../core/ai/localSummary';
import type { FileShakeConfig } from '../core/config';
import type { Clock, DashSummary, Scheduler } from '../core/types';
import type { MementoLike } from './storage';

const CONSENT_KEY = 'fileShake.ai.consent';
const KEY_PREFIX = 'fileShake.ai.key.';
/** A provider that does not answer in this time is abandoned and the local summary is used. */
export const PROVIDER_TIMEOUT_MS = 30_000;
const MAX_SUMMARY_CHARS = 4000;

export const ALLOW = 'Allow';
export const DENY = "Don't Allow";

/** Asks the user once; replaceable in tests. */
export type ConsentPrompt = (message: string, detail: string) => Thenable<string | undefined>;

export interface AiServiceDeps {
  clock: Clock;
  scheduler: Scheduler;
  getConfig(): FileShakeConfig;
  secrets: vscode.SecretStorage;
  memento: MementoLike;
  log(msg: string): void;
}

export interface ProviderHandle {
  dispose(): void;
  /** the key the user stored for this provider with "File Shake: Set AI Provider Key"; the only way a provider gets it */
  getKey(): Promise<string | undefined>;
}

/**
 * Provider registry, consent and credentials. No network provider ships with File Shake: assisted mode
 * only does something when another extension registers a provider, and then only after the user agreed.
 * Keys and request payloads are never logged.
 */
export class AiService implements vscode.Disposable {
  private readonly registry = new ProviderRegistry();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange: vscode.Event<void> = this.emitter.event;
  private prompt: ConsentPrompt = (message, detail) => vscode.window.showWarningMessage(message, { modal: true, detail }, ALLOW, DENY);
  revision = 0;

  constructor(private readonly deps: AiServiceDeps) {}

  /** Test seam: replaces the consent dialog. `undefined` restores the real one. */
  overridePrompt(fn: ConsentPrompt | undefined): void {
    this.prompt = fn ?? ((message, detail) => vscode.window.showWarningMessage(message, { modal: true, detail }, ALLOW, DENY));
  }

  register(provider: AiProvider): ProviderHandle {
    const inner = this.registry.register(provider);
    this.touch();
    return {
      dispose: () => {
        inner.dispose();
        this.touch();
      },
      getKey: () => this.getKey(provider.id),
    };
  }

  providers(): AiProvider[] {
    return this.registry.list();
  }

  /** The provider chosen by `fileShake.ai.provider`, when assisted mode is on and it is registered. */
  activeProvider(): AiProvider | undefined {
    const cfg = this.deps.getConfig();
    return cfg.aiMode === 'assisted' && cfg.aiProvider !== '' ? this.registry.get(cfg.aiProvider) : undefined;
  }

  // ---- consent -----------------------------------------------------------------

  consent(providerId: string): Consent {
    const stored = this.storedConsent();
    const v = stored[providerId];
    return v === 'granted' || v === 'denied' ? v : 'unset';
  }

  async resetConsent(): Promise<void> {
    await this.deps.memento.update(CONSENT_KEY, undefined);
    this.touch();
  }

  private storedConsent(): Record<string, unknown> {
    const raw = this.deps.memento.get<unknown>(CONSENT_KEY);
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? { ...raw } : {};
  }

  private async askConsent(provider: AiProvider): Promise<Consent> {
    const { message, detail } = consentMessage(provider);
    const choice = await this.prompt(message, detail);
    if (choice !== ALLOW && choice !== DENY) return 'unset'; // dismissed: ask again next time
    const stored = this.storedConsent();
    stored[provider.id] = choice === ALLOW ? 'granted' : 'denied';
    await this.deps.memento.update(CONSENT_KEY, stored);
    this.touch();
    return choice === ALLOW ? 'granted' : 'denied';
  }

  // ---- credentials -------------------------------------------------------------

  async setKey(providerId: string): Promise<boolean> {
    const value = await vscode.window.showInputBox({
      title: `API key for ${providerId}`,
      prompt: 'Stored in VS Code secret storage on this machine. It is only handed to that provider.',
      password: true,
      ignoreFocusOut: true,
    });
    if (value === undefined || value === '') return false;
    await this.deps.secrets.store(KEY_PREFIX + providerId, value);
    return true;
  }

  async clearKey(providerId: string): Promise<void> {
    await this.deps.secrets.delete(KEY_PREFIX + providerId);
  }

  private async getKey(providerId: string): Promise<string | undefined> {
    try {
      return await this.deps.secrets.get(KEY_PREFIX + providerId);
    } catch {
      return undefined;
    }
  }

  // ---- summaries ---------------------------------------------------------------

  /**
   * A summary of `input`. Local mode (and every fallback) is built on this machine from metadata. In assisted
   * mode the registered provider is asked, but only with consent; any error or timeout falls back to local.
   */
  async summarize(kind: AiRequest['kind'], input: SummaryInput): Promise<DashSummary> {
    const local = (): DashSummary => ({ text: localSummary(input), provider: 'local', at: this.deps.clock.now() });
    const cfg = this.deps.getConfig();
    const provider = cfg.aiMode === 'assisted' && cfg.aiProvider !== '' ? this.registry.get(cfg.aiProvider) : undefined;
    let consent = provider === undefined ? 'unset' : this.consent(provider.id);
    if (provider !== undefined && consent === 'unset') consent = await this.askConsent(provider);
    const gate = canSend(cfg.aiMode, consent, provider);
    if (!gate.ok || provider === undefined) return local();

    const token = { isCancellationRequested: false };
    let timer: { cancel(): void } | undefined;
    try {
      const request: AiRequest = { kind, metadata: input, includesSource: false };
      const timeout = new Promise<undefined>((resolve) => {
        timer = this.deps.scheduler.setTimeout(() => {
          token.isCancellationRequested = true;
          resolve(undefined);
        }, PROVIDER_TIMEOUT_MS);
      });
      const answer: unknown = await Promise.race([provider.summarize(request, token), timeout]);
      if (typeof answer !== 'string' || answer.trim() === '') {
        this.deps.log(`AI provider ${provider.id} gave no usable summary; the local summary is used.`);
        return local();
      }
      return { text: answer.trim().slice(0, MAX_SUMMARY_CHARS), provider: provider.id, at: this.deps.clock.now() };
    } catch (err) {
      // the error text may quote the request: log that it failed, not why
      this.deps.log(`AI provider ${provider.id} failed (${err instanceof Error ? err.name : 'error'}); the local summary is used.`);
      return local();
    } finally {
      timer?.cancel();
    }
  }

  dispose(): void {
    this.emitter.dispose();
  }

  private touch(): void {
    this.revision += 1;
    this.emitter.fire();
  }
}
