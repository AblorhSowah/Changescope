import * as vscode from 'vscode';
import type { ViewMode } from '../core/types';
import type { ActivityService } from './activityService';
import type { AiService } from './aiService';
import type { SignalFileAdapter } from './agentSignal';
import { updateSetting } from './config';
import type { DashboardProvider } from './dashboardProvider';
import type { DependencyIndex } from './dependencyIndex';

export interface CommandDeps {
  activity: ActivityService;
  ai: AiService;
  dashboard: DashboardProvider;
  index: DependencyIndex;
  signal: SignalFileAdapter;
  /** "are you sure" for destructive actions; replaceable in tests */
  confirm: (message: string, action: string) => Thenable<boolean>;
}

export const realConfirm = async (message: string, action: string): Promise<boolean> =>
  (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action;

const MODES: ReadonlyArray<{ label: string; mode: ViewMode; description: string }> = [
  { label: 'Live', mode: 'live', description: 'Rows shake with activity (the original experience)' },
  { label: 'Compact', mode: 'compact', description: 'Single-line rows, no shaking' },
  { label: 'Impact', mode: 'impact', description: 'Rows show an impact estimate from import edges' },
];

function plainString(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** Registers every File Shake command that is not part of the original four. */
export function registerCommands(d: CommandDeps): vscode.Disposable[] {
  const { activity, ai, dashboard, index, signal } = d;

  /** The session a command acts on: the active one, else one the user picks. */
  const pickSession = async (placeHolder: string): Promise<string | undefined> => {
    const sessions = activity.sessions.list();
    if (sessions.length === 0) {
      void vscode.window.showInformationMessage('File Shake: there are no sessions yet. Start one with "File Shake: Start Session".');
      return undefined;
    }
    const active = sessions.find((s) => s.status === 'active');
    if (active !== undefined) return active.id;
    const picked = await vscode.window.showQuickPick(
      sessions.map((s) => ({ label: s.title, description: s.status, id: s.id })),
      { placeHolder },
    );
    return picked?.id;
  };

  const pickProvider = async (placeHolder: string): Promise<string | undefined> => {
    const providers = ai.providers();
    if (providers.length === 0) {
      void vscode.window.showInformationMessage('File Shake: no AI provider is registered. Providers come from other extensions.');
      return undefined;
    }
    if (providers.length === 1 && providers[0] !== undefined) return providers[0].id;
    const picked = await vscode.window.showQuickPick(
      providers.map((p) => ({ label: p.label, description: p.id, id: p.id })),
      { placeHolder },
    );
    return picked?.id;
  };

  return [
    vscode.commands.registerCommand('fileShake.openDashboard', () => dashboard.focus()),
    vscode.commands.registerCommand('fileShake.openDashboardPanel', () => dashboard.openPanel()),
    vscode.commands.registerCommand('fileShake.setViewMode', async () => {
      const picked = await vscode.window.showQuickPick(MODES, { placeHolder: 'Choose how the File Shake dashboard looks' });
      if (picked !== undefined) await updateSetting('viewMode', picked.mode);
    }),
    vscode.commands.registerCommand('fileShake.pause', () => activity.setPaused(true)),
    vscode.commands.registerCommand('fileShake.resume', () => activity.setPaused(false)),
    vscode.commands.registerCommand('fileShake.startSession', async () => {
      const title = await vscode.window.showInputBox({
        title: 'Start a File Shake session',
        prompt: 'Session title (leave empty to use the date and time)',
        ignoreFocusOut: true,
      });
      if (title !== undefined) activity.startSession(title);
    }),
    vscode.commands.registerCommand('fileShake.stopSession', () => {
      if (activity.stopSession() === undefined) void vscode.window.showInformationMessage('File Shake: no session is running.');
    }),
    vscode.commands.registerCommand('fileShake.renameSession', async () => {
      const id = await pickSession('Which session do you want to rename?');
      const session = id === undefined ? undefined : activity.sessions.get(id);
      if (session === undefined) return;
      const title = await vscode.window.showInputBox({ title: 'Rename session', value: session.title, ignoreFocusOut: true });
      if (title !== undefined && title.trim() !== '') activity.renameSession(session.id, title);
    }),
    vscode.commands.registerCommand('fileShake.exportSessionReport', async (arg?: unknown) => {
      const id = plainString(arg) ?? (await pickSession('Which session do you want to export?'));
      const report = id === undefined ? undefined : activity.sessionReport(id, 'markdown');
      if (report === undefined) return;
      // opened as an unsaved document: nothing is written to disk by File Shake
      const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: report });
      await vscode.window.showTextDocument(doc, { preview: false });
    }),
    vscode.commands.registerCommand('fileShake.markAllReviewed', () => activity.markAllReviewed()),
    vscode.commands.registerCommand('fileShake.clearHistory', async () => {
      const yes = await d.confirm('Clear the File Shake activity history and completed sessions for this workspace?', 'Clear History');
      if (yes) await activity.clearHistory();
    }),
    vscode.commands.registerCommand('fileShake.rebuildDependencyIndex', () => index.rebuild()),
    vscode.commands.registerCommand('fileShake.copyAgentHook', async () => {
      const path = await signal.prepare();
      const hook = signal.hook();
      if (path === undefined || hook === undefined) {
        void vscode.window.showInformationMessage('File Shake: the agent signal file needs workspace storage. Open a folder first.');
        return;
      }
      await vscode.env.clipboard.writeText(hook.settings);
      void vscode.window.showInformationMessage(
        'File Shake: copied an experimental hook for Claude Code. Merge it into the "hooks" section of your own settings.json, and turn on fileShake.experimental.agentSignals. It needs jq and a POSIX shell, and only reports files the agent writes through its Edit and Write tools.',
      );
    }),
    vscode.commands.registerCommand('fileShake.ai.setKey', async () => {
      const id = await pickProvider('Which provider is the key for?');
      if (id !== undefined && (await ai.setKey(id))) void vscode.window.showInformationMessage(`File Shake: key stored for ${id}.`);
    }),
    vscode.commands.registerCommand('fileShake.ai.clearKey', async () => {
      const id = await pickProvider('Which provider key do you want to remove?');
      if (id === undefined) return;
      await ai.clearKey(id);
      void vscode.window.showInformationMessage(`File Shake: key removed for ${id}.`);
    }),
    vscode.commands.registerCommand('fileShake.ai.resetConsent', async () => {
      await ai.resetConsent();
      void vscode.window.showInformationMessage('File Shake: AI consent was reset. You will be asked again before anything is shared.');
    }),
  ];
}
