// Helpers of the 0.3.0 integration suites (activity history, sessions, dashboard, index, AI, agent signal).
// Same rules as helpers.ts: time is the fake clock, real asynchrony is awaited by re-reading state, no fixed sleeps.
import * as vscode from 'vscode';
import type { ChangescopeApi } from '../../../src/extension';
import type { AiProvider, AiRequest } from '../../../src/core/ai/provider';
import type { ActivityEvent, DashboardState, DevelopmentSession } from '../../../src/core/types';
import { externalWrite, keyOf, resetConfig, resetState, testing, waitUntil } from './helpers';

export const dashboardState = (api: ChangescopeApi): DashboardState => api.getDashboardState();

export const eventsFor = (api: ChangescopeApi, key: string): ActivityEvent[] => api.getActivityEvents().filter((e) => e.filePath === key);

export const lastEventFor = (api: ChangescopeApi, key: string): ActivityEvent | undefined => eventsFor(api, key).at(-1);

export const activeSession = (api: ChangescopeApi): DevelopmentSession | undefined => api.getSessions().find((s) => s.status === 'active');

/** Sends a message as the dashboard webview would. */
export const send = (api: ChangescopeApi, raw: unknown): void => testing(api).dashboardMessage(raw);

/** Runs a command and waits for its promise. */
export const run = async (id: string, ...args: unknown[]): Promise<void> => {
  await vscode.commands.executeCommand(id, ...args);
};

/**
 * Puts history, sessions, pause state and the 0.3.0 settings back to neutral. History is shared by every suite of a
 * launch (one extension instance), so each suite starts from an empty one and looks only at files of its own.
 */
export async function resetHistory(api: ChangescopeApi): Promise<void> {
  const t = testing(api);
  await run('changescope.resume');
  if (activeSession(api) !== undefined) await run('changescope.stopSession');
  t.overrideConfirm(() => Promise.resolve(true));
  try {
    await run('changescope.clearHistory');
  } finally {
    t.overrideConfirm(undefined);
  }
  await t.flushHistory();
}

/** Drops the dialog and notification overrides a test installed. (resetHistory leaves them alone: a test may call it mid-way.) */
export function resetOverrides(api: ChangescopeApi): void {
  const t = testing(api);
  t.overrideCollisionNotify(undefined);
  t.overrideConsentPrompt(undefined);
  t.overrideConfirm(undefined);
}

/** resetConfig + resetState + resetHistory + resetOverrides, in the order the suites need. */
export async function resetAll(api: ChangescopeApi): Promise<void> {
  resetOverrides(api);
  await resetConfig();
  await resetState(api);
  await resetHistory(api);
  testing(api).overrideFocus(true);
}

/** Waits until the history holds more events for `key` than `before` (a real watcher event was recorded). */
export async function waitForEvent(api: ChangescopeApi, key: string, before: number, what = 'an event'): Promise<ActivityEvent> {
  await waitUntil(api, () => api.getActivityEvents().filter((e) => e.filePath === key).reduce((n, e) => n + e.count, 0) > before, `${what} for ${key}`, 60_000);
  return lastEventFor(api, key) as ActivityEvent;
}

/** Total number of recorded occurrences for a file (coalesced events count every occurrence). */
export const occurrences = (api: ChangescopeApi, key: string): number => eventsFor(api, key).reduce((n, e) => n + e.count, 0);

/** Writes `content` from a separate process and waits until Changescope recorded the change. */
export async function externalChange(api: ChangescopeApi, file: string, content: string): Promise<ActivityEvent> {
  const key = keyOf(file);
  const before = occurrences(api, key);
  await externalWrite(file, content);
  return waitForEvent(api, key, before, 'the external change');
}

export interface MockProvider {
  provider: AiProvider;
  /** every request the provider received, as plain JSON */
  calls: AiRequest[];
  /** keys handed out through getKey (never needed by the mock) */
  setAnswer(fn: (req: AiRequest) => Promise<string>): void;
}

/** A provider that records what it is sent. */
export function mockProvider(id = 'acme.test', label = 'Acme Test'): MockProvider {
  const calls: AiRequest[] = [];
  let answer: (req: AiRequest) => Promise<string> = () => Promise.resolve('Provider summary.');
  const provider: AiProvider = {
    id,
    label,
    summarize: (req) => {
      calls.push(JSON.parse(JSON.stringify(req)) as AiRequest);
      return answer(req);
    },
  };
  return { provider, calls, setAnswer: (fn) => (answer = fn) };
}

/** Asks for a summary through the dashboard message and waits until the state carries a newer one. */
export async function summarizeNow(api: ChangescopeApi): Promise<NonNullable<DashboardState['summary']>> {
  testing(api).advance(1); // a new clock value, so a new summary is recognisable
  const before = dashboardState(api).summary?.at ?? -1;
  send(api, { type: 'summarize' });
  await waitUntil(api, () => (dashboardState(api).summary?.at ?? -1) > before, 'a new summary in the dashboard state', 30_000);
  return dashboardState(api).summary as NonNullable<DashboardState['summary']>;
}

/** All text of every document the test host holds in memory, for "no absolute path anywhere" checks. */
export function everyOpenDocumentText(): string {
  return vscode.workspace.textDocuments.map((d) => d.getText()).join('\n');
}

/** Deep search for a string inside JSON-able data. */
export function containsText(value: unknown, needle: string): boolean {
  return JSON.stringify(value).includes(JSON.stringify(needle).slice(1, -1));
}
