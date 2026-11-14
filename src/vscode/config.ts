import * as vscode from 'vscode';
import { sanitizeConfig } from '../core/config';
import type { FileShakeConfig } from '../core/config';

const SECTION = 'fileShake';

export function readConfig(): FileShakeConfig {
  const c = vscode.workspace.getConfiguration(SECTION);
  const raw: Record<string, unknown> = {
    enable: c.get('enable'),
    enableAnimation: c.get('enableAnimation'),
    idleTimeoutMs: c.get('idleTimeoutMs'),
    windowMs: c.get('windowMs'),
    maxFiles: c.get('maxFiles'),
    excludeGlobs: c.get('excludeGlobs'),
    editedColor: c.get('colors.edited'),
    referencedColor: c.get('colors.referenced'),
    sensitivity: c.get('sensitivity'),
    showWhenIdle: c.get('showWhenIdle'),
    persistUntilNextFile: c.get('persistUntilNextFile'),
    decorateFolders: c.get('decorateFolders'),
    detectExternalEdits: c.get('detectExternalEdits'),
    maxFileSizeKb: c.get('maxFileSizeKb'),
    showStatusBar: c.get('showStatusBar'),
    viewMode: c.get('viewMode'),
    animationIntensity: c.get('animationIntensity'),
    historyPersist: c.get('history.persist'),
    historyMaxEvents: c.get('history.maxEvents'),
    historyRetentionDays: c.get('history.retentionDays'),
    gitEnabled: c.get('git.enabled'),
    dependencyIndex: c.get('dependencies.index'),
    dependencyMaxFiles: c.get('dependencies.maxFiles'),
    collisionsNotify: c.get('collisions.notify'),
    sensitiveGlobs: c.get('sensitiveGlobs'),
    aiMode: c.get('ai.mode'),
    aiProvider: c.get('ai.provider'),
    agentSignals: c.get('experimental.agentSignals'),
  };
  return sanitizeConfig(raw);
}

export function onDidChangeConfig(cb: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(SECTION)) cb();
  });
}

/** Writes `fileShake.<name>` in the scope where it is currently defined (default: user settings). Resolves false when no scope accepted it. */
export async function updateSetting(name: string, value: unknown): Promise<boolean> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const c = vscode.workspace.getConfiguration(SECTION, folder?.uri);
  const info = c.inspect<unknown>(name);
  const attempts: vscode.ConfigurationTarget[] = [];
  if (info?.workspaceFolderValue !== undefined && folder) attempts.push(vscode.ConfigurationTarget.WorkspaceFolder);
  else if (info?.workspaceValue !== undefined) attempts.push(vscode.ConfigurationTarget.Workspace);
  attempts.push(vscode.ConfigurationTarget.Global);
  for (const target of attempts) {
    try {
      await c.update(name, value, target);
      return true;
    } catch {
      // try the next, broader scope
    }
  }
  return false;
}

/** Flips `fileShake.enable` in the scope where it is currently defined (default: user settings). */
export async function toggleEnabled(): Promise<void> {
  const c = vscode.workspace.getConfiguration(SECTION, vscode.workspace.workspaceFolders?.[0]?.uri);
  await updateSetting('enable', !(c.get<boolean>('enable') ?? true));
}
