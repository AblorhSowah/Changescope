import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, must, readRepoFile } from '../support/fixtures';
import { DEFAULT_CONFIG, sanitizeConfig } from '../../src/core/config';
import type { FileShakeConfig } from '../../src/core/config';

interface Pkg {
  name: string;
  displayName: string;
  version: string;
  publisher: string;
  description: string;
  license: string;
  icon: string;
  galleryBanner: { color: string; theme: string };
  categories: string[];
  keywords: string[];
  repository: { type: string; url: string };
  engines: { vscode: string };
  main: string;
  extensionKind: string[];
  activationEvents: string[];
  capabilities: { untrustedWorkspaces: { supported: boolean | string }; virtualWorkspaces: { supported: boolean | string; description?: string } };
  contributes: {
    viewsContainers: { activitybar: Array<{ id: string; title: string; icon: string }> };
    views: { explorer: Array<{ type: string; id: string; name: string; contextualTitle?: string }>; fileShake: Array<{ type: string; id: string; name: string; contextualTitle?: string }> };
    commands: Array<{ command: string; title: string; category?: string; icon?: string }>;
    menus: { 'view/title': Array<{ command: string; when: string; group: string }>; commandPalette: Array<{ command: string; when: string }> };
    colors: Array<{ id: string; description: string; defaults: Record<string, string> }>;
    configuration: { title: string; properties: Record<string, Prop> };
  };
  scripts: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies: Record<string, string>;
}

interface Prop {
  type: string;
  default: unknown;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  enum?: string[];
  enumDescriptions?: string[];
  scope?: string;
  markdownDescription?: string;
  items?: { type: string };
}

const pkg = JSON.parse(readRepoFile('package.json')) as Pkg;
const props = pkg.contributes.configuration.properties;

describe('package.json: identity and platform fields', () => {
  it('identity', () => {
    assert.equal(pkg.name, 'file-shake');
    assert.equal(pkg.displayName, 'File Shake');
    assert.equal(pkg.version, '0.3.0');
    assert.equal(pkg.publisher, 'file-shake');
    assert.equal(pkg.license, 'MIT');
    assert.ok(pkg.description.length > 20);
    assert.match(pkg.repository.url, /^https:\/\/github\.com\//);
  });

  it('engines.vscode is ^1.85.0 and @types/vscode is pinned to exactly that API level', () => {
    assert.equal(pkg.engines.vscode, '^1.85.0');
    assert.equal(pkg.devDependencies['@types/vscode'], '1.85.0');
    assert.equal(pkg.devDependencies['@types/node'], '18.19.130', 'Node 18 typings: keeps newer Node APIs out of the extension host code');
  });

  it('entry point, activation and remote behaviour', () => {
    assert.equal(pkg.main, './dist/extension.js');
    assert.deepEqual(pkg.activationEvents, ['onStartupFinished']);
    assert.deepEqual(pkg.extensionKind, ['workspace']);
    assert.equal(pkg.capabilities.untrustedWorkspaces.supported, true);
    assert.equal(pkg.capabilities.virtualWorkspaces.supported, 'limited');
    assert.ok((pkg.capabilities.virtualWorkspaces.description ?? '').length > 10);
  });

  it('marketplace presentation fields', () => {
    assert.equal(pkg.icon, 'media/icon.png');
    assert.deepEqual(pkg.galleryBanner, { color: '#0d1117', theme: 'dark' });
    assert.deepEqual(pkg.categories, ['Visualization', 'Other']);
    for (const k of ['files', 'activity', 'explorer', 'imports', 'claude', 'ai', 'live', 'dashboard', 'git', 'dependencies', 'impact', 'sessions']) assert.ok(pkg.keywords.includes(k), k);
  });

  it('no runtime `dependencies` (everything is bundled; the .vsix ships without node_modules)', () => {
    assert.ok(pkg.dependencies === undefined || Object.keys(pkg.dependencies).length === 0);
  });
});

describe('package.json: pinned toolchain (DESIGN 3)', () => {
  const pinned: Record<string, string> = {
    typescript: '6.0.3',
    '@types/vscode': '1.85.0',
    '@types/node': '18.19.130',
    esbuild: '0.28.2',
    '@vscode/vsce': '4.1.0',
    '@vscode/test-electron': '3.1.0',
    mocha: '10.8.2',
    '@types/mocha': '10.0.10',
    tsx: '4.23.15',
    jsdom: '30.1.3',
    '@types/jsdom': '30.0.0',
    eslint: '10.14.0',
    '@eslint/js': '10.0.1',
    'typescript-eslint': '8.72.1',
    globals: '17.13.0',
    picomatch: '4.0.7',
    '@types/picomatch': '4.0.3',
    'jsonc-parser': '3.3.1',
  };
  for (const [name, version] of Object.entries(pinned)) {
    it(`${name} is pinned to exactly ${version}`, () => assert.equal(pkg.devDependencies[name], version));
  }

  it('every devDependency is an exact version (no ^, ~, ranges, tags)', () => {
    for (const [name, v] of Object.entries(pkg.devDependencies)) assert.match(v, /^\d+\.\d+\.\d+$/, `${name}@${v}`);
  });

  it('the dependency set contains nothing outside the design (no vitest / vite / test-cli / glob / minimatch)', () => {
    for (const banned of ['vitest', 'vite', '@vscode/test-cli', 'glob', 'minimatch', 'jest', 'webpack', 'rollup']) {
      assert.equal(pkg.devDependencies[banned], undefined, banned);
    }
  });
});

describe('package.json: scripts (DESIGN 13)', () => {
  const expected: Record<string, string> = {
    build: 'node esbuild.mjs',
    'build:prod': 'node esbuild.mjs --production',
    watch: 'node esbuild.mjs --watch',
    'build:test': 'node esbuild.mjs --tests',
    typecheck: 'tsc -p tsconfig.json --noEmit && tsc -p src/webview/tsconfig.json --noEmit && tsc -p src/dashboard/tsconfig.json --noEmit && tsc -p test/tsconfig.json --noEmit',
    lint: 'eslint . && npm run typecheck',
    'test:unit': 'node --import tsx --test "test/unit/**/*.test.ts" "test/webview/**/*.test.ts"',
    'test:integration': 'npm run build && npm run build:test && node --import tsx test/integration/runTest.ts',
    test: 'npm run test:unit && npm run test:integration',
    'vscode:prepublish': 'node esbuild.mjs --production',
    package: 'vsce package --no-dependencies',
  };
  for (const [name, cmd] of Object.entries(expected)) {
    it(`npm run ${name}`, () => assert.equal(pkg.scripts[name], cmd));
  }
});

describe('package.json: contributes.views / commands / menus', () => {
  it('one webview view in the Explorer sidebar with id fileShake.view (unchanged since 0.2.0)', () => {
    assert.equal(pkg.contributes.views.explorer.length, 1);
    const v = must(pkg.contributes.views.explorer[0]);
    assert.equal(v.type, 'webview');
    assert.equal(v.id, 'fileShake.view');
    assert.equal(v.name, 'File Shake');
  });

  it('0.3.0: an Activity Bar container "fileShake" with a monochrome icon, holding the webview view fileShake.dashboard', () => {
    assert.deepEqual(pkg.contributes.viewsContainers.activitybar, [{ id: 'fileShake', title: 'File Shake', icon: 'media/activity.svg' }]);
    assert.equal(pkg.contributes.views.fileShake.length, 1);
    const v = must(pkg.contributes.views.fileShake[0]);
    assert.equal(v.type, 'webview');
    assert.equal(v.id, 'fileShake.dashboard');
    assert.equal(v.name, 'Activity');
    const svg = readRepoFile('media/activity.svg');
    assert.match(svg, /currentColor/, 'the Activity Bar icon takes its colour from the theme');
    assert.doesNotMatch(svg, /#[0-9a-fA-F]{3,8}\b|rgb\(|<script|<image|href=|on[a-z]+=/i, 'no literal colour, script, image or handler');
  });

  const COMMANDS_0_2 = ['fileShake.clear', 'fileShake.focusView', 'fileShake.showDebugInfo', 'fileShake.toggle'];
  const COMMANDS_0_3 = [
    'fileShake.openDashboard',
    'fileShake.openDashboardPanel',
    'fileShake.setViewMode',
    'fileShake.pause',
    'fileShake.resume',
    'fileShake.startSession',
    'fileShake.stopSession',
    'fileShake.renameSession',
    'fileShake.exportSessionReport',
    'fileShake.markAllReviewed',
    'fileShake.clearHistory',
    'fileShake.rebuildDependencyIndex',
    'fileShake.copyAgentHook',
    'fileShake.ai.setKey',
    'fileShake.ai.clearKey',
    'fileShake.ai.resetConsent',
  ];

  it('the four 0.2.0 commands are all still there, unrenamed (no command is removed in 0.3.0)', () => {
    const cmds = pkg.contributes.commands.map((c) => c.command);
    for (const id of COMMANDS_0_2) assert.ok(cmds.includes(id), id);
  });

  it('exactly the twenty documented commands (4 from 0.2.0 + the 16 of DESIGN-0.3.0 section 12), all in the File Shake category with a title', () => {
    const cmds = pkg.contributes.commands.map((c) => c.command).sort();
    assert.deepEqual(cmds, [...COMMANDS_0_2, ...COMMANDS_0_3].sort());
    assert.equal(new Set(cmds).size, 20, 'no duplicate');
    for (const c of pkg.contributes.commands) {
      assert.equal(c.category, 'File Shake');
      assert.ok(c.title.length > 0);
    }
  });

  it('the commands that appear as buttons in a view title carry a codicon', () => {
    const icon = (id: string): string | undefined => pkg.contributes.commands.find((c) => c.command === id)?.icon;
    for (const id of ['fileShake.pause', 'fileShake.resume', 'fileShake.markAllReviewed', 'fileShake.openDashboardPanel']) assert.match(icon(id) ?? '', /^\$\([a-z-]+\)$/, id);
  });

  it('view title menus: the Explorer view keeps clear + toggle; the dashboard view gets pause/resume, mark all reviewed and open in editor', () => {
    const items = pkg.contributes.menus['view/title'];
    const explorer = items.filter((i) => i.when === 'view == fileShake.view').map((i) => i.command).sort();
    assert.deepEqual(explorer, ['fileShake.clear', 'fileShake.toggle']);
    const dash = items.filter((i) => i.when.includes('view == fileShake.dashboard'));
    assert.deepEqual(dash.map((i) => i.command).sort(), ['fileShake.markAllReviewed', 'fileShake.openDashboardPanel', 'fileShake.pause', 'fileShake.resume']);
    assert.equal(items.length, 6, 'nothing else is in a view title menu');
    const whenOf = (id: string): string => must(items.find((i) => i.command === id)).when;
    assert.equal(whenOf('fileShake.pause'), 'view == fileShake.dashboard && !fileShake.paused');
    assert.equal(whenOf('fileShake.resume'), 'view == fileShake.dashboard && fileShake.paused');
    for (const i of items) assert.match(i.group, /^navigation(@\d+)?$/);
  });

  it('the command palette only offers the one of pause / resume that makes sense, from the fileShake.paused context key', () => {
    assert.deepEqual(pkg.contributes.menus.commandPalette, [
      { command: 'fileShake.pause', when: '!fileShake.paused' },
      { command: 'fileShake.resume', when: 'fileShake.paused' },
    ]);
  });

  it('no activation event is needed for contributed commands or the views (>= 1.74)', () => {
    assert.ok(!pkg.activationEvents.some((e) => e.startsWith('onCommand') || e.startsWith('onView')));
  });
});

describe('package.json: contributed theme colours', () => {
  const byId = (id: string) => must(pkg.contributes.colors.find((c) => c.id === id), id);

  it('edited and referenced colours with the documented per-theme defaults', () => {
    assert.deepEqual(byId('fileShake.editedForeground').defaults, { dark: '#3fb950', light: '#1a7f37', highContrast: '#3fb950', highContrastLight: '#116329' });
    assert.deepEqual(byId('fileShake.referencedForeground').defaults, { dark: '#e3b341', light: '#9a6700', highContrast: '#e3b341', highContrastLight: '#7d4e00' });
    assert.equal(pkg.contributes.colors.length, 2);
  });

  it('colour ids contain exactly one dot, so the webview variable --vscode-<id with first . replaced> is unambiguous', () => {
    for (const c of pkg.contributes.colors) {
      assert.equal(c.id.split('.').length, 2, c.id);
      assert.ok(c.description.length > 10);
    }
  });

  it('brief hex defaults for dark: green #3fb950, yellow #e3b341', () => {
    assert.equal(byId('fileShake.editedForeground').defaults['dark'], '#3fb950');
    assert.equal(byId('fileShake.referencedForeground').defaults['dark'], '#e3b341');
  });

  it('the DecorationSpec colour ids in core are the contributed ids', () => {
    const ids = pkg.contributes.colors.map((c) => c.id).sort();
    assert.deepEqual(ids, ['fileShake.editedForeground', 'fileShake.referencedForeground']);
  });
});

describe('package.json: configuration matches core/config defaults and ranges', () => {
  const keyOf: Record<string, keyof FileShakeConfig> = {
    'fileShake.enable': 'enable',
    'fileShake.enableAnimation': 'enableAnimation',
    'fileShake.idleTimeoutMs': 'idleTimeoutMs',
    'fileShake.windowMs': 'windowMs',
    'fileShake.maxFiles': 'maxFiles',
    'fileShake.excludeGlobs': 'excludeGlobs',
    'fileShake.colors.edited': 'editedColor',
    'fileShake.colors.referenced': 'referencedColor',
    'fileShake.sensitivity': 'sensitivity',
    'fileShake.showWhenIdle': 'showWhenIdle',
    'fileShake.persistUntilNextFile': 'persistUntilNextFile',
    'fileShake.decorateFolders': 'decorateFolders',
    'fileShake.detectExternalEdits': 'detectExternalEdits',
    'fileShake.maxFileSizeKb': 'maxFileSizeKb',
    'fileShake.showStatusBar': 'showStatusBar',
    'fileShake.viewMode': 'viewMode',
    'fileShake.animationIntensity': 'animationIntensity',
    'fileShake.history.persist': 'historyPersist',
    'fileShake.history.maxEvents': 'historyMaxEvents',
    'fileShake.history.retentionDays': 'historyRetentionDays',
    'fileShake.git.enabled': 'gitEnabled',
    'fileShake.dependencies.index': 'dependencyIndex',
    'fileShake.dependencies.maxFiles': 'dependencyMaxFiles',
    'fileShake.collisions.notify': 'collisionsNotify',
    'fileShake.sensitiveGlobs': 'sensitiveGlobs',
    'fileShake.ai.mode': 'aiMode',
    'fileShake.ai.provider': 'aiProvider',
    'fileShake.experimental.agentSignals': 'agentSignals',
  };

  it('exactly the documented 28 settings (the 15 of 0.2.0 and the 13 of DESIGN-0.3.0 section 12)', () => {
    assert.equal(Object.keys(keyOf).length, 28);
    assert.deepEqual(Object.keys(props).sort(), Object.keys(keyOf).sort());
  });

  for (const [setting, key] of Object.entries(keyOf)) {
    it(`${setting}: default equals DEFAULT_CONFIG.${key}`, () => {
      const p = must(props[setting], setting);
      assert.deepEqual(p.default, DEFAULT_CONFIG[key]);
      assert.equal(p.scope, 'window');
      assert.ok((p.markdownDescription ?? '').length > 20, 'has a markdownDescription');
    });
  }

  const numeric: Array<[string, 'number' | 'integer', number, number]> = [
    ['fileShake.idleTimeoutMs', 'number', 500, 60000],
    ['fileShake.windowMs', 'number', 500, 30000],
    ['fileShake.maxFiles', 'integer', 5, 200],
    ['fileShake.sensitivity', 'number', 0.25, 4],
    ['fileShake.maxFileSizeKb', 'integer', 16, 4096],
    ['fileShake.animationIntensity', 'number', 0.25, 2],
    ['fileShake.history.maxEvents', 'integer', 100, 5000],
    ['fileShake.history.retentionDays', 'integer', 1, 90],
    ['fileShake.dependencies.maxFiles', 'integer', 200, 20000],
  ];
  for (const [setting, type, min, max] of numeric) {
    it(`${setting}: ${type} in [${min}, ${max}], the same clamp range sanitizeConfig applies`, () => {
      const p = must(props[setting]);
      assert.equal(p.type, type);
      assert.equal(p.minimum, min);
      assert.equal(p.maximum, max);
      const key = must(keyOf[setting]);
      assert.equal(sanitizeConfig({ [key]: min - 1 })[key], min);
      assert.equal(sanitizeConfig({ [key]: max + 1 })[key], max);
    });
  }

  it('boolean settings are booleans', () => {
    for (const s of ['enable', 'enableAnimation', 'showWhenIdle', 'persistUntilNextFile', 'decorateFolders', 'detectExternalEdits', 'showStatusBar', 'history.persist', 'git.enabled', 'collisions.notify', 'experimental.agentSignals']) {
      assert.equal(must(props[`fileShake.${s}`]).type, 'boolean', s);
    }
  });

  it('enum settings list exactly the values core/config accepts, and describe each of them', () => {
    const enums: Array<[string, keyof FileShakeConfig, string[]]> = [
      ['fileShake.viewMode', 'viewMode', ['live', 'compact', 'impact']],
      ['fileShake.dependencies.index', 'dependencyIndex', ['onDemand', 'off']],
      ['fileShake.ai.mode', 'aiMode', ['local', 'assisted']],
    ];
    for (const [setting, key, values] of enums) {
      const p = must(props[setting], setting);
      assert.equal(p.type, 'string');
      assert.deepEqual(p.enum, values, setting);
      assert.equal(p.enumDescriptions?.length, values.length, `${setting}: one description per value`);
      for (const v of values) assert.equal(sanitizeConfig({ [key]: v })[key], v, `${setting} = ${v}`);
      assert.equal(sanitizeConfig({ [key]: 'bogus' })[key], DEFAULT_CONFIG[key]);
    }
  });

  it('fileShake.sensitiveGlobs: an array of strings whose default is the ten globs of DESIGN-0.3.0 section 12', () => {
    const p = must(props['fileShake.sensitiveGlobs']);
    assert.equal(p.type, 'array');
    assert.deepEqual(p.items, { type: 'string' });
    assert.deepEqual(p.default, ['**/.env*', '**/*.pem', '**/*.key', '**/*.pfx', '**/*.p12', '**/id_rsa*', '**/id_ed25519*', '**/secrets/**', '**/.npmrc', '**/.netrc']);
  });

  it('fileShake.ai.provider: the manifest pattern is the same rule as core/config (empty or a short opaque id)', () => {
    const p = must(props['fileShake.ai.provider']);
    assert.equal(p.type, 'string');
    assert.equal(p.default, '');
    const re = new RegExp(must(p.pattern));
    for (const ok of ['', 'a', 'acme.llm', 'A1_b-c', 'a'.repeat(64)]) {
      assert.ok(re.test(ok), `accepts ${JSON.stringify(ok)}`);
      assert.equal(sanitizeConfig({ aiProvider: ok }).aiProvider, ok);
    }
    for (const bad of [' a', 'a b', '.a', '../x', 'a/b', 'a'.repeat(65)]) {
      assert.ok(!re.test(bad), `rejects ${JSON.stringify(bad)}`);
      assert.equal(sanitizeConfig({ aiProvider: bad }).aiProvider, '');
    }
  });

  it('privacy defaults: AI is local, the agent signal file is off, history is kept per workspace only', () => {
    assert.equal(must(props['fileShake.ai.mode']).default, 'local');
    assert.equal(must(props['fileShake.experimental.agentSignals']).default, false);
    for (const p of Object.values(props)) assert.equal(p.scope, 'window', 'no setting can be set per machine or per resource by accident');
  });

  it('excludeGlobs is an array of strings', () => {
    const p = must(props['fileShake.excludeGlobs']);
    assert.equal(p.type, 'array');
    assert.deepEqual(p.items, { type: 'string' });
  });

  it('colour settings: strings with the same pattern core/config enforces, and they say "webview only"', () => {
    for (const s of ['fileShake.colors.edited', 'fileShake.colors.referenced']) {
      const p = must(props[s]);
      assert.equal(p.type, 'string');
      assert.equal(p.default, '');
      const re = new RegExp(must(p.pattern));
      for (const ok of ['', '#fff', '#3fb950', '#3fb95080']) assert.ok(re.test(ok), `${s} accepts ${ok}`);
      for (const bad of ['red', '#ff', '#fffff', '#gggggg', '3fb950']) assert.ok(!re.test(bad), `${s} rejects ${bad}`);
      const md = must(p.markdownDescription);
      assert.match(md, /webview/i);
      assert.ok(md.includes('workbench.colorCustomizations'), 'points users to the real way to recolour Explorer decorations');
      assert.ok(md.includes('fileShake.editedForeground') && md.includes('fileShake.referencedForeground'));
    }
  });
});

describe('repository files required for a Marketplace-ready package', () => {
  const must_exist = (f: string): string => {
    const p = join(REPO_ROOT, f);
    assert.ok(existsSync(p), `${f} is missing`);
    return p;
  };

  it('LICENSE is MIT with the documented copyright line', () => {
    const t = readFileSync(must_exist('LICENSE'), 'utf8');
    assert.match(t, /MIT License/);
    assert.match(t, /Copyright \(c\) 2026 File Shake contributors/);
    assert.match(t, /Permission is hereby granted, free of charge/);
  });

  it('CHANGELOG.md exists, mentions 0.3.0 first, and keeps the history', () => {
    const log = readFileSync(must_exist('CHANGELOG.md'), 'utf8');
    assert.match(log, /^## 0\.3\.0$/m);
    assert.match(log, /^## 0\.2\.0$/m, 'the history is kept');
    assert.match(log, /^## 0\.1\.0$/m, 'the history is kept');
    assert.ok(log.indexOf('## 0.3.0') < log.indexOf('## 0.2.0') && log.indexOf('## 0.2.0') < log.indexOf('## 0.1.0'), 'newest first');
  });

  it('.vscodeignore excludes everything and un-ignores exactly the shipped files', () => {
    const lines = readFileSync(must_exist('.vscodeignore'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    assert.equal(lines[0], '**');
    assert.deepEqual(
      lines.slice(1).sort(),
      ['!LICENSE', '!CHANGELOG.md', '!README.md', '!dist/extension.js', '!dist/webview.js', '!dist/dashboard.js', '!media/*', '!package.json'].sort(),
    );
    // `!media/*` and not `!media/**`: with vsce an ignore line cannot override a matching `!` line, so `!media/**`
    // would ship media/screenshots/ (recorded in the Dashboard Builder's Deviations)
    assert.ok(!lines.includes('!media/**'));
    assert.ok(!lines.some((l) => l.includes('screenshots')));
  });

  it('icon.png is a 128x128 RGBA PNG (checked from the file header)', () => {
    const buf = readFileSync(must_exist('media/icon.png'));
    assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature');
    assert.equal(buf.subarray(12, 16).toString('ascii'), 'IHDR');
    assert.equal(buf.readUInt32BE(16), 128, 'width');
    assert.equal(buf.readUInt32BE(20), 128, 'height');
    assert.equal(buf[24], 8, 'bit depth');
    assert.equal(buf[25], 6, 'colour type 6 = RGBA');
    assert.ok(buf.length < 40_000, `icon is ${buf.length} bytes`);
  });

  it('media/webview.css, media/dashboard.css and media/activity.svg exist; scripts/make-icon.mjs exists', () => {
    must_exist('media/webview.css');
    must_exist('media/dashboard.css');
    must_exist('media/activity.svg');
    must_exist('scripts/make-icon.mjs');
  });

  it('esbuild.mjs enforces mainFields [module, main] for the extension bundle (jsonc-parser UMD trap)', () => {
    const src = readRepoFile('esbuild.mjs');
    assert.match(src, /mainFields:\s*\[\s*'module'\s*,\s*'main'\s*\]/);
    assert.match(src, /external:\s*\[\s*'vscode'\s*\]/);
  });

  it('README states the platform limits honestly (DESIGN 2 items 1-6) and how detection works (DESIGN 9)', () => {
    const readme = readFileSync(must_exist('README.md'), 'utf8');
    const lower = readme.toLowerCase();
    // 1: native rows cannot shake
    assert.ok(/cannot (animate|shake)|can't (animate|shake)|no (api|way) to (animate|shake)|does not (allow|support) (animation|animating)/.test(lower), 'says the Explorer rows cannot shake');
    assert.ok(lower.includes('explorer'), 'mentions the Explorer');
    // 2: native badges are 1-2 characters
    assert.ok(/badge/.test(lower) && /(2|two)[ -]char/.test(lower), 'explains the 2 character native badge limit');
    // 3: colour customisation
    assert.ok(readme.includes('workbench.colorCustomizations'), 'documents workbench.colorCustomizations');
    assert.ok(/webview.{0,40}only|only.{0,40}webview/.test(lower), 'colour settings affect the webview only');
    // 4: no writer identity
    assert.ok(/external/.test(lower) && /(cannot|can't|not able|unable|no way).{0,80}(identify|tell|name|distinguish)|does not (know|identify)/.test(lower), 'external cannot name the writer');
    assert.ok(!/detects? claude\b/.test(lower) || /not.{0,40}claude/.test(lower), 'does not claim to detect Claude specifically');
    // 5: heuristic references
    assert.ok(/heuristic|regex|not (an )?ast|best[- ]effort/.test(lower), 'reference detection is described as heuristic');
    // 6: yellow only while a source is active
    assert.ok(/yellow/.test(lower) && /(while|when).{0,60}(typing|editing|active)/.test(lower), 'yellow appears only while editing');
    // section 9 reliability: false positives of "you"
    assert.ok(/(copilot|inline completion|snippet|workspaceedit)/.test(lower), 'lists the cases that look like typing');
    assert.ok(/prefers-reduced-motion|reduced motion/.test(lower), 'documents reduced motion');
    assert.ok(/fileShake\.enableAnimation/.test(readme));
    assert.ok(/MIT/.test(readme));
  });

  it('README documents every command and every setting', () => {
    const readme = readFileSync(must_exist('README.md'), 'utf8');
    for (const c of pkg.contributes.commands) assert.ok(readme.includes(c.command) || readme.includes(c.title), `README mentions ${c.command}`);
    for (const s of Object.keys(props)) assert.ok(readme.includes(s), `README mentions ${s}`);
  });

  it('repository hygiene: no node_modules / dist / .vsix under version-controlled test fixtures', () => {
    assert.ok(!existsSync(join(REPO_ROOT, 'test', 'fixtures', 'node_modules')));
    const gi = readFileSync(must_exist('.gitignore'), 'utf8');
    for (const k of ['node_modules', 'dist', 'out', '.vscode-test', '*.vsix']) assert.ok(gi.includes(k), `.gitignore lists ${k}`);
    assert.ok(statSync(join(REPO_ROOT, 'package.json')).size > 1000);
  });
});
