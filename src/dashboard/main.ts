import { mountDashboard } from './app';
import type { DashHostApi, DashPersisted } from './app';
import type { DashboardWebviewMessage } from '../core/dashboard/protocol';
import { parsePersisted } from './model';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const root = document.getElementById('app');

if (root) {
  const host: DashHostApi = {
    postMessage: (m: DashboardWebviewMessage) => vscode.postMessage(m),
    // whatever an older version stored is read field by field; junk falls back to the defaults
    getState: () => parsePersisted(vscode.getState()),
    setState: (s: DashPersisted) => vscode.setState(s),
  };
  const app = mountDashboard(root, host);
  window.addEventListener('message', (e: MessageEvent<unknown>) => app.handleMessage(e.data));
  window.addEventListener('error', (e: ErrorEvent) => {
    vscode.postMessage({ type: 'error', message: String(e.message) } satisfies DashboardWebviewMessage);
  });
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    vscode.postMessage({ type: 'error', message: String(e.reason) } satisfies DashboardWebviewMessage);
  });
}
