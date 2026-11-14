// QA-101: the only path form that may leave the sidebar (session reports, AI requests). Inside a folder it is relative to that
// folder; anywhere else it is "(outside workspace)/<file name>" and carries no directory at all.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FileActivity } from '../../src/core/activity/eventStore';
import { buildSummaryInput } from '../../src/core/ai/provider';
import { localSummary } from '../../src/core/ai/localSummary';
import { normalizePath, toDisplayPath, toSafeDisplayPath } from '../../src/core/pathUtils';
import { buildSessionReport } from '../../src/core/sessions/report';
import type { ActivityEvent, DevelopmentSession, WorkspaceRoot } from '../../src/core/types';
import { must } from '../support/fixtures';

const OUT = '(outside workspace)';
const one: WorkspaceRoot[] = [{ key: '/Users/frank/proj', name: 'proj' }];
const two: WorkspaceRoot[] = [
  { key: '/Users/frank/alpha', name: 'alpha' },
  { key: '/Users/frank/beta', name: 'beta' },
];

describe('toSafeDisplayPath: inside a workspace folder', () => {
  it('one folder: the path relative to it, no folder name prefix', () => {
    assert.equal(toSafeDisplayPath('/Users/frank/proj/src/a.ts', one), 'src/a.ts');
    assert.equal(toSafeDisplayPath('/Users/frank/proj/a.ts', one), 'a.ts');
    assert.equal(toSafeDisplayPath('/Users/frank/proj/src/deep/er/b.test.ts', one), 'src/deep/er/b.test.ts');
  });

  it('several folders: the folder name leads, like the sidebar', () => {
    assert.equal(toSafeDisplayPath('/Users/frank/alpha/shared.ts', two), 'alpha/shared.ts');
    assert.equal(toSafeDisplayPath('/Users/frank/beta/lib/x.ts', two), 'beta/lib/x.ts');
  });

  it('the deepest folder wins when folders are nested, and a sibling that shares a prefix is not inside', () => {
    const nested: WorkspaceRoot[] = [
      { key: '/ws', name: 'outer' },
      { key: '/ws/packages/core', name: 'core' },
    ];
    assert.equal(toSafeDisplayPath('/ws/packages/core/src/a.ts', nested), 'core/src/a.ts');
    assert.equal(toSafeDisplayPath('/ws/packages/other/a.ts', nested), 'outer/packages/other/a.ts');
    assert.equal(toSafeDisplayPath('/ws2/a.ts', nested), `${OUT}/a.ts`);
    assert.equal(toSafeDisplayPath('/Users/frank/proj2/a.ts', one), `${OUT}/a.ts`);
  });

  it('a folder name is the configured name, never the path of the folder', () => {
    const named: WorkspaceRoot[] = [
      { key: '/Users/frank/secret-client-work/api', name: 'api' },
      { key: '/Users/frank/secret-client-work/web', name: 'web' },
    ];
    const text = toSafeDisplayPath('/Users/frank/secret-client-work/api/src/a.ts', named);
    assert.equal(text, 'api/src/a.ts');
    assert.ok(!text.includes('secret-client-work') && !text.includes('Users'));
  });

  it('the filesystem root as the folder works (relative path without a leading slash)', () => {
    assert.equal(toSafeDisplayPath('/etc/hosts', [{ key: '/', name: 'root' }]), 'etc/hosts');
  });

  it('Windows keys (drive letter, normalised forward slashes) work inside a folder', () => {
    const win: WorkspaceRoot[] = [{ key: 'c:/Users/me/proj', name: 'proj' }];
    assert.equal(toSafeDisplayPath(normalizePath('C:\\Users\\me\\proj\\src\\a.ts'), win), 'src/a.ts');
    assert.equal(toSafeDisplayPath(normalizePath('c:\\Users\\me\\proj\\a.ts'), win), 'a.ts');
  });
});

describe('toSafeDisplayPath: outside every folder, no folder, edge names', () => {
  it('outside the workspace: only "(outside workspace)/<file name>", no directory', () => {
    assert.equal(toSafeDisplayPath('/Users/frank/other/secret.ts', one), `${OUT}/secret.ts`);
    assert.equal(toSafeDisplayPath('/tmp/x/y/z/o1.ts', two), `${OUT}/o1.ts`);
    assert.equal(toSafeDisplayPath('/private/tmp/fs-aTHLaC/outside/o1.ts', one), `${OUT}/o1.ts`);
  });

  it('a window with no folder open: every file is outside', () => {
    assert.equal(toSafeDisplayPath('/Users/frank/notes/todo.md', []), `${OUT}/todo.md`);
    assert.equal(toSafeDisplayPath('/a.ts', []), `${OUT}/a.ts`);
  });

  it('the folder itself (a folder key, not a file) is not "inside" and reports only its own name', () => {
    assert.equal(toSafeDisplayPath('/Users/frank/proj', one), `${OUT}/proj`);
  });

  it('an empty name (the root, an empty key, a trailing slash only) gives just "(outside workspace)"', () => {
    assert.equal(toSafeDisplayPath('/', one), OUT);
    assert.equal(toSafeDisplayPath('', one), OUT);
    assert.equal(toSafeDisplayPath('', []), OUT);
    assert.equal(toSafeDisplayPath('c:/', []), OUT);
  });

  it('Windows keys outside the folder, UNC paths and raw backslash paths never leak their directories or a separator', () => {
    const win: WorkspaceRoot[] = [{ key: 'c:/Users/me/proj', name: 'proj' }];
    assert.equal(toSafeDisplayPath('c:/Users/me/other/secret.ts', win), `${OUT}/secret.ts`);
    assert.equal(toSafeDisplayPath('d:/data/secret.ts', win), `${OUT}/secret.ts`);
    assert.equal(toSafeDisplayPath('//server/share/dept/secret.ts', win), `${OUT}/secret.ts`);
    // a key that was never normalised (raw backslashes) is still safe: it does not match a root, and only its name is kept
    const raw = toSafeDisplayPath('C:\\Users\\me\\other\\secret.ts', win);
    assert.equal(raw, `${OUT}/secret.ts`);
    assert.ok(!raw.includes('\\') && !raw.includes('Users'));
  });

  it('hostile and unusual names pass through as text, still without any directory', () => {
    for (const name of ['<img src=x onerror=alert(1)>.ts', 'a b.ts', '日本語.ts', '👨‍👩‍👧‍👦.ts', "it's.ts", '.env', 'Makefile', 'a\u0000b.ts']) {
      assert.equal(toSafeDisplayPath(`/Users/frank/other/${name}`, one), `${OUT}/${name}`, name);
      assert.equal(toSafeDisplayPath(`/Users/frank/proj/sub/${name}`, one), `sub/${name}`, name);
    }
  });

  it('dot segments are resolved by the key normalisation, so ".." cannot climb out of the display', () => {
    assert.equal(toSafeDisplayPath(normalizePath('/Users/frank/proj/../other/x.ts'), one), `${OUT}/x.ts`);
    assert.equal(toSafeDisplayPath(normalizePath('/Users/frank/proj/src/../a.ts'), one), 'a.ts');
  });

  it('toDisplayPath (the sidebar form) is unchanged: it still shows the absolute folder of an outside file', () => {
    assert.equal(toDisplayPath('/Users/frank/other/secret.ts', one).dir, '/Users/frank/other');
  });

  it('property: 3,000 random keys and folder sets. Inside -> the exact relative path; outside -> exactly one separator, after "(outside workspace)"; never an absolute prefix', () => {
    let seed = 17;
    const rnd = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return (seed >>> 8) % n;
    };
    const segs = ['Users', 'frank', 'proj', 'src', 'a b', '日本', 'secrets', 'node_modules', 'x', 'y', '.git', 'client-name'];
    const file = ['a.ts', 'b.test.ts', '.env', 'c d.py', 'ünï.go', 'README'];
    for (let i = 0; i < 3000; i += 1) {
      const roots: WorkspaceRoot[] = [];
      for (let r = rnd(3); r > 0; r -= 1) roots.push({ key: `/${Array.from({ length: 1 + rnd(3) }, () => segs[rnd(segs.length)]).join('/')}`, name: `root${r}` });
      const dirs = Array.from({ length: rnd(5) }, () => segs[rnd(segs.length)]);
      const key = normalizePath(`/${[...dirs, file[rnd(file.length)]].join('/')}`);
      const out = toSafeDisplayPath(key, roots);
      const inside = roots.filter((r) => key.startsWith(`${r.key}/`));
      if (inside.length === 0) {
        assert.ok(out === OUT || /^\(outside workspace\)\/[^/\\]+$/.test(out), `${key} -> ${out}`);
      } else {
        assert.ok(!out.startsWith('/'), `${key} -> ${out}`);
        const best = must(inside.sort((a, b) => b.key.length - a.key.length)[0]);
        const rel = key.slice(best.key.length + 1);
        assert.equal(out, roots.length > 1 ? `${best.name}/${rel}` : rel, `${key} with ${JSON.stringify(roots)}`);
      }
    }
  });
});

describe('QA-101 end to end in the core: no text that leaves the sidebar contains a directory of an outside or folder-less file', () => {
  const T0 = Date.UTC(2026, 10, 12, 14, 0, 0);
  const abs = ['/Users/frank/other/secret.ts', '/home/dev/client/notes.md', 'c:/Users/frank/Desktop/todo.txt', '//server/share/dept/plan.ts', '/private/tmp/fs-x/outside/o1.ts'];
  const insideKey = '/Users/frank/proj/src/ok.ts';

  const sessionFor = (keys: string[]): { session: DevelopmentSession; events: ActivityEvent[] } => ({
    session: { id: 's1', title: 'Work', workspaceId: 'w', startedAt: T0, endedAt: T0 + 60_000, status: 'completed', activityCount: keys.length, modifiedFiles: keys, sources: { developer: keys.length } },
    events: keys.map((k, i): ActivityEvent => ({ id: `e${i}`, workspaceId: 'w', sessionId: 's1', filePath: k, eventType: 'modify', sourceType: i % 2 === 0 ? 'developer' : 'external', detectionMethod: 'focused-editor-edit', confidence: 0.9, timestamp: T0 + i, lastTimestamp: T0 + i, count: 1 })),
  });

  /** Every string of a parsed JSON value that is a "path" field. */
  const jsonPaths = (json: string): string[] => (JSON.parse(json) as { files: Array<{ path: string }> }).files.map((f) => f.path);

  for (const [label, roots] of [['no folder open', [] as WorkspaceRoot[]], ['one folder', one], ['two folders', two]] as const) {
    it(`${label}: Markdown and JSON session reports show "(outside workspace)/<name>" for outside files and nothing else before the name`, () => {
      const keys = [...abs, insideKey];
      const { session, events } = sessionFor(keys);
      const display = (k: string): string => toSafeDisplayPath(k, roots);
      const json = buildSessionReport(session, events, display, 'json');
      const md = buildSessionReport(session, events, display, 'markdown');
      const inRoot = (k: string): boolean => roots.some((r) => k.startsWith(`${r.key}/`));
      for (const p of jsonPaths(json)) {
        const source = keys.find((k) => display(k) === p);
        assert.ok(source !== undefined, p);
        if (!inRoot(source as string)) assert.match(p, /^\(outside workspace\)\/[^/\\]+$/, p);
        else assert.ok(!p.startsWith('/') && !/^[a-z]:/i.test(p), p);
      }
      for (const text of [json, md]) {
        for (const leak of ['/Users/frank/other', '/home/dev', 'client', 'Desktop', 'server/share', 'dept', '/private/tmp', 'fs-x', 'c:/Users']) {
          assert.ok(!text.includes(leak), `${label}: the report contains "${leak}"`);
        }
        for (const name of ['secret.ts', 'notes.md', 'todo.txt', 'plan.ts', 'o1.ts']) assert.ok(text.includes(name), `${name} is still listed`);
      }
      // every Markdown table row of the file list starts with a path cell of the safe form
      const rows = md.split('\n').filter((l) => l.startsWith('| ') && /\.(ts|md|txt)\b/.test(l.split('|')[1] ?? ''));
      assert.ok(rows.length >= keys.length);
      for (const row of rows) {
        const cell = (row.split('|')[1] ?? '').trim().replace(/\\([\\`*_[\]<>|#])/g, '$1');
        assert.ok(/^\(outside workspace\)\/[^/\\]+$/.test(cell) || /^[^/\\:][^\\]*$/.test(cell), `path cell: ${cell}`);
      }
    });

    it(`${label}: the AI SummaryInput and the local summary built from the same files carry no directory of an outside file`, () => {
      const files: FileActivity[] = [...abs, insideKey].map((key, i) => ({ key, sourceType: 'developer', detectionMethod: 'focused-editor-edit', confidence: 0.9, lastEventType: 'modify', firstAt: T0, lastAt: T0 + i, changes: i + 1, review: undefined, exists: true }));
      const input = buildSummaryInput({ files, toDisplay: (k) => toSafeDisplayPath(k, roots), isSensitive: () => false, session: { title: 'Work', durationMs: 1000 }, branch: 'main' });
      const inRoot = (k: string): boolean => roots.some((r) => k.startsWith(`${r.key}/`));
      for (const f of input.files) {
        const source = files.find((x) => toSafeDisplayPath(x.key, roots) === f.path);
        assert.ok(source, f.path);
        if (!inRoot(source.key)) assert.match(f.path, /^\(outside workspace\)\/[^/\\]+$/, f.path);
        else assert.ok(!f.path.startsWith('/'), f.path);
      }
      const wire = JSON.stringify(input) + localSummary(input);
      for (const leak of ['/Users/frank/other', '/home/dev', 'client', 'Desktop', 'server/share', 'dept', '/private/tmp', 'fs-x', 'c:/Users']) assert.ok(!wire.includes(leak), `${label}: "${leak}"`);
      // the only strings of the input that contain a slash are display paths and the session title / branch given by the caller
      const slashStrings: string[] = [];
      const walk = (v: unknown): void => {
        if (typeof v === 'string' && /[/\\]/.test(v)) slashStrings.push(v);
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v !== null && typeof v === 'object') Object.values(v).forEach(walk);
      };
      walk(input);
      for (const s of slashStrings) assert.ok(input.files.some((f) => f.path === s), `unexpected string with a separator: ${s}`);
    });
  }

  it('the old display function WOULD have leaked (so the tests above can fail): toDisplayPath keeps the directory of an outside file', () => {
    const leaky = (k: string): string => {
      const d = toDisplayPath(k, one);
      return d.dir === '' ? d.name : `${d.dir}/${d.name}`;
    };
    assert.ok(leaky('/Users/frank/other/secret.ts').includes('/Users/frank/other'));
    const { session, events } = sessionFor(['/Users/frank/other/secret.ts']);
    assert.ok(buildSessionReport(session, events, leaky, 'json').includes('/Users/frank/other'));
  });
});
