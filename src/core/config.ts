import { COLOR_PATTERN, K } from './constants';
import type { TrackerOptions } from './activityTracker';
import type { ViewMode } from './types';

export interface ChangescopeConfig {
  enable: boolean;
  enableAnimation: boolean;
  idleTimeoutMs: number;
  windowMs: number;
  maxFiles: number;
  excludeGlobs: string[];
  /** '' = follow the theme */
  editedColor: string;
  /** '' = follow the theme */
  referencedColor: string;
  sensitivity: number;
  showWhenIdle: boolean;
  /** keep each user's current files on screen until that user moves to a different file */
  persistUntilNextFile: boolean;
  decorateFolders: boolean;
  detectExternalEdits: boolean;
  maxFileSizeKb: number;
  showStatusBar: boolean;
  // ---- 0.3.0 ----
  /** visual mode of the dashboard; `compact` also stops shaking in the Explorer view */
  viewMode: ViewMode;
  /** multiplies shake distance and rotation (both views) */
  animationIntensity: number;
  /** keep history and sessions across restarts (workspace storage) */
  historyPersist: boolean;
  historyMaxEvents: number;
  historyRetentionDays: number;
  gitEnabled: boolean;
  dependencyIndex: DependencyIndexMode;
  dependencyMaxFiles: number;
  collisionsNotify: boolean;
  /** never read for dependency analysis, never part of an AI request */
  sensitiveGlobs: string[];
  aiMode: AiMode;
  /** id of the registered provider to use in assisted mode; '' = none */
  aiProvider: string;
  /** read the experimental agent signal file */
  agentSignals: boolean;
}

export type DependencyIndexMode = 'onDemand' | 'off';
export type AiMode = 'local' | 'assisted';

export const DEFAULT_EXCLUDE_GLOBS: readonly string[] = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/out/**',
  '**/build/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.venv/**',
  '**/__pycache__/**',
  '**/.vscode-test/**',
  '**/*.min.js',
  '**/*.map',
  '**/*.log',
  '**/*.vsix',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
];

export const DEFAULT_SENSITIVE_GLOBS: readonly string[] = [
  '**/.env*',
  '**/*.pem',
  '**/*.key',
  '**/*.pfx',
  '**/*.p12',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/secrets/**',
  '**/.npmrc',
  '**/.netrc',
];

const VIEW_MODES: readonly ViewMode[] = ['live', 'compact', 'impact'];
const INDEX_MODES: readonly DependencyIndexMode[] = ['onDemand', 'off'];
const AI_MODES: readonly AiMode[] = ['local', 'assisted'];
/** provider ids are short opaque tokens, never paths or free text */
export const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const DEFAULT_CONFIG: ChangescopeConfig = {
  enable: true,
  enableAnimation: true,
  idleTimeoutMs: 2500,
  windowMs: 3000,
  maxFiles: 40,
  excludeGlobs: [...DEFAULT_EXCLUDE_GLOBS],
  editedColor: '',
  referencedColor: '',
  sensitivity: 1,
  showWhenIdle: false,
  persistUntilNextFile: true,
  decorateFolders: true,
  detectExternalEdits: true,
  maxFileSizeKb: 512,
  showStatusBar: true,
  viewMode: 'live',
  animationIntensity: 1,
  historyPersist: true,
  historyMaxEvents: 1000,
  historyRetentionDays: 14,
  gitEnabled: true,
  dependencyIndex: 'onDemand',
  dependencyMaxFiles: 5000,
  collisionsNotify: true,
  sensitiveGlobs: [...DEFAULT_SENSITIVE_GLOBS],
  aiMode: 'local',
  aiProvider: '',
  agentSignals: false,
};

export { COLOR_PATTERN };

function num(v: unknown, def: number, min: number, max: number, integer: boolean): number {
  if (typeof v !== 'number' || Number.isNaN(v)) return def;
  const clamped = Math.min(max, Math.max(min, v));
  return integer ? Math.round(clamped) : clamped;
}

function bool(v: unknown, def: boolean): boolean {
  return typeof v === 'boolean' ? v : def;
}

function color(v: unknown): string {
  return typeof v === 'string' && COLOR_PATTERN.test(v) ? v : '';
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], def: T): T {
  for (const a of allowed) if (a === v) return a;
  return def;
}

function strings(v: unknown, def: readonly string[]): string[] {
  return Array.isArray(v) ? v.filter((g): g is string => typeof g === 'string') : [...def];
}

/** Total: never throws; every invalid value falls back to its default or is clamped. */
export function sanitizeConfig(raw: Readonly<Record<string, unknown>>): ChangescopeConfig {
  const d = DEFAULT_CONFIG;
  try {
    const r: Readonly<Record<string, unknown>> = typeof raw === 'object' && raw !== null ? raw : {};
    const provider = r['aiProvider'];
    return {
      enable: bool(r['enable'], d.enable),
      enableAnimation: bool(r['enableAnimation'], d.enableAnimation),
      idleTimeoutMs: num(r['idleTimeoutMs'], d.idleTimeoutMs, 500, 60000, false),
      windowMs: num(r['windowMs'], d.windowMs, 500, 30000, false),
      maxFiles: num(r['maxFiles'], d.maxFiles, 5, 200, true),
      excludeGlobs: strings(r['excludeGlobs'], d.excludeGlobs),
      editedColor: color(r['editedColor']),
      referencedColor: color(r['referencedColor']),
      sensitivity: num(r['sensitivity'], d.sensitivity, 0.25, 4, false),
      showWhenIdle: bool(r['showWhenIdle'], d.showWhenIdle),
      persistUntilNextFile: bool(r['persistUntilNextFile'], d.persistUntilNextFile),
      decorateFolders: bool(r['decorateFolders'], d.decorateFolders),
      detectExternalEdits: bool(r['detectExternalEdits'], d.detectExternalEdits),
      maxFileSizeKb: num(r['maxFileSizeKb'], d.maxFileSizeKb, 16, 4096, true),
      showStatusBar: bool(r['showStatusBar'], d.showStatusBar),
      viewMode: oneOf(r['viewMode'], VIEW_MODES, d.viewMode),
      animationIntensity: num(r['animationIntensity'], d.animationIntensity, 0.25, 2, false),
      historyPersist: bool(r['historyPersist'], d.historyPersist),
      historyMaxEvents: num(r['historyMaxEvents'], d.historyMaxEvents, 100, 5000, true),
      historyRetentionDays: num(r['historyRetentionDays'], d.historyRetentionDays, 1, 90, true),
      gitEnabled: bool(r['gitEnabled'], d.gitEnabled),
      dependencyIndex: oneOf(r['dependencyIndex'], INDEX_MODES, d.dependencyIndex),
      dependencyMaxFiles: num(r['dependencyMaxFiles'], d.dependencyMaxFiles, 200, 20000, true),
      collisionsNotify: bool(r['collisionsNotify'], d.collisionsNotify),
      sensitiveGlobs: strings(r['sensitiveGlobs'], d.sensitiveGlobs),
      aiMode: oneOf(r['aiMode'], AI_MODES, d.aiMode),
      aiProvider: typeof provider === 'string' && PROVIDER_ID_PATTERN.test(provider) ? provider : '',
      agentSignals: bool(r['agentSignals'], d.agentSignals),
    };
  } catch {
    return { ...d, excludeGlobs: [...d.excludeGlobs], sensitiveGlobs: [...d.sensitiveGlobs] };
  }
}

export function toTrackerOptions(c: ChangescopeConfig): TrackerOptions {
  return {
    windowMs: c.windowMs,
    idleTimeoutMs: c.idleTimeoutMs,
    retainAfterIdleMs: K.RETAIN_AFTER_IDLE_MS,
    maxFiles: c.maxFiles,
    sensitivity: c.sensitivity,
    showWhenIdle: c.showWhenIdle,
    persist: c.persistUntilNextFile,
  };
}
