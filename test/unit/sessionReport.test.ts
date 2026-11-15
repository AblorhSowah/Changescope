import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionReport } from '../../src/core/sessions/report';
import { formatLocalMinute, toIsoUtc } from '../../src/core/timeFormat';
import type { ActivityEvent, DevelopmentSession, FileKey } from '../../src/core/types';

const T0 = Date.UTC(2026, 10, 12, 14, 0, 0);
const MIN = 60_000;

function session(o: Partial<DevelopmentSession> = {}): DevelopmentSession {
  return {
    id: 's1',
    title: 'Refactor',
    workspaceId: 'ws-1',
    startedAt: T0,
    endedAt: T0 + 95 * MIN,
    status: 'completed',
    activityCount: 4,
    modifiedFiles: ['/ws/src/a.ts', '/ws/src/b.ts'],
    sources: { developer: 3, external: 1 },
    gitStart: { branch: 'main', commit: '0123456789abcdef' },
    gitEnd: { branch: 'feature/x', commit: 'fedcba9876543210' },
    ...o,
  };
}

function ev(filePath: string, o: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: 'e1',
    workspaceId: 'ws-1',
    sessionId: 's1',
    filePath,
    eventType: 'modify',
    sourceType: 'developer',
    detectionMethod: 'focused-editor-edit',
    confidence: 0.9,
    timestamp: T0 + MIN,
    lastTimestamp: T0 + MIN,
    count: 1,
    ...o,
  };
}

/** Workspace-relative display path, the way the host builds it. */
const display = (k: FileKey): string => (k.startsWith('/ws/') ? k.slice(4) : `(outside workspace)/${k.split('/').pop() ?? ''}`);

function noSession(e: ActivityEvent): ActivityEvent {
  delete e.sessionId;
  return e;
}

const events = (): ActivityEvent[] => [
  ev('/ws/src/a.ts', { id: 'e1', count: 2, timestamp: T0 + MIN, lastTimestamp: T0 + 2 * MIN }),
  ev('/ws/src/a.ts', { id: 'e2', count: 1, sourceType: 'external', detectionMethod: 'disk-write', timestamp: T0 + 10 * MIN, lastTimestamp: T0 + 10 * MIN }),
  ev('/ws/src/b.ts', { id: 'e3', count: 1, eventType: 'create', timestamp: T0 + 20 * MIN, lastTimestamp: T0 + 20 * MIN }),
  ev('/ws/src/other.ts', { id: 'e4', sessionId: 'another-session' }),
  noSession(ev('/ws/src/nosession.ts', { id: 'e5' })),
];

describe('buildSessionReport: Markdown', () => {
  const md = buildSessionReport(session(), events(), display, 'markdown');

  it('has the title, status, times, duration, git at start and end, counts', () => {
    assert.match(md, /^# Changescope session report: Refactor\n/);
    assert.match(md, /- Status: completed/);
    assert.ok(md.includes(`- Started: ${formatLocalMinute(T0)} (local time)`));
    assert.ok(md.includes(`- Ended: ${formatLocalMinute(T0 + 95 * MIN)} (local time)`));
    assert.match(md, /- Duration: 1 h 35 min/);
    assert.match(md, /- Git at start: main \(0123456\)/);
    assert.match(md, /- Git at end: feature\/x \(fedcba9\)/);
    assert.match(md, /- Recorded changes: 4 in 2 files/);
  });

  it('the commit is shortened to 7 characters (a full id is not needed in a report)', () => {
    assert.ok(!md.includes('0123456789abcdef'));
  });

  it('counts per source use the labels, in the fixed source order, and omit sources with no changes', () => {
    assert.match(md, /\| Developer \| 3 \|\n\| External \| 1 \|/);
    assert.ok(!md.includes('| Git |'));
    assert.ok(!md.includes('| AI agent |'));
  });

  it('lists the session files with their source labels and change counts, sorted by path', () => {
    assert.match(md, /\| src\/a\.ts \| Developer, External \| 3 \| modified \|/);
    assert.match(md, /\| src\/b\.ts \| Developer \| 1 \| created \|/);
    assert.ok(md.indexOf('src/a.ts') < md.indexOf('src/b.ts'));
  });

  it('events of another session or of no session are not included', () => {
    assert.ok(!md.includes('other.ts'));
    assert.ok(!md.includes('nosession.ts'));
  });

  it('says what the labels mean and states the limit (no proof of authorship, no contents)', () => {
    assert.match(md, /not proof of who made it/);
    assert.match(md, /no file contents/);
  });
});

describe('buildSessionReport: JSON', () => {
  const parsed = JSON.parse(buildSessionReport(session(), events(), display, 'json')) as Record<string, unknown>;

  it('has stable fields with UTC ISO times and a duration in milliseconds', () => {
    assert.equal(parsed['title'], 'Refactor');
    assert.equal(parsed['status'], 'completed');
    assert.equal(parsed['startedAt'], toIsoUtc(T0));
    assert.equal(parsed['endedAt'], toIsoUtc(T0 + 95 * MIN));
    assert.equal(parsed['durationMs'], 95 * MIN);
    assert.deepEqual(parsed['gitStart'], { branch: 'main', commit: '0123456789abcdef' });
    assert.deepEqual(parsed['gitEnd'], { branch: 'feature/x', commit: 'fedcba9876543210' });
    assert.equal(parsed['activityCount'], 4);
    assert.deepEqual(parsed['sources'], { developer: 3, external: 1 });
  });

  it('files are display paths with their sources, change counts and last event', () => {
    assert.deepEqual(parsed['files'], [
      { path: 'src/a.ts', sources: ['developer', 'external'], changes: 3, lastEvent: 'modify' },
      { path: 'src/b.ts', sources: ['developer'], changes: 1, lastEvent: 'create' },
    ]);
  });

  it('is valid JSON that round-trips', () => {
    assert.doesNotThrow(() => JSON.parse(buildSessionReport(session(), events(), display, 'json')));
  });
});

describe('buildSessionReport: running session, missing data', () => {
  it('a session still running says so (no end time, no duration) in both formats', () => {
    const s = session({ status: 'active', endedAt: undefined, gitEnd: undefined });
    const md = buildSessionReport(s, events(), display, 'markdown');
    assert.match(md, /- Ended: still running/);
    assert.match(md, /- Duration: still running/);
    assert.match(md, /- Git at end: not recorded/);
    const json = JSON.parse(buildSessionReport(s, events(), display, 'json')) as Record<string, unknown>;
    assert.equal(json['endedAt'], null);
    assert.equal(json['durationMs'], null);
    assert.deepEqual(json['gitEnd'], { branch: null, commit: null });
  });

  it('no git context at all reads "not recorded"; branch only and commit only are handled', () => {
    const none = buildSessionReport(session({ gitStart: undefined, gitEnd: undefined }), [], display, 'markdown');
    assert.match(none, /- Git at start: not recorded/);
    assert.match(buildSessionReport(session({ gitStart: { branch: 'dev' } }), [], display, 'markdown'), /- Git at start: dev\n/);
    assert.match(buildSessionReport(session({ gitStart: { commit: 'abcdef0123' } }), [], display, 'markdown'), /- Git at start: abcdef0\n/);
    assert.match(buildSessionReport(session({ gitStart: {} }), [], display, 'markdown'), /- Git at start: not recorded/);
  });

  it('a session with no activity says so', () => {
    const empty = session({ activityCount: 0, modifiedFiles: [], sources: {} });
    const md = buildSessionReport(empty, [], display, 'markdown');
    assert.match(md, /No changes were recorded in this session\./);
    assert.match(md, /No files were changed in this session\./);
    assert.match(md, /- Recorded changes: 0 in 0 files/);
    const json = JSON.parse(buildSessionReport(empty, [], display, 'json')) as { files: unknown[]; sources: object };
    assert.deepEqual(json.files, []);
    assert.deepEqual(json.sources, {});
  });

  it('one file reads "1 file"', () => {
    const md = buildSessionReport(session({ modifiedFiles: ['/ws/a.ts'] }), [], display, 'markdown');
    assert.match(md, /in 1 file\n/);
  });

  it('a file linked to the session whose events were trimmed from the history is still listed, marked as not in the kept history', () => {
    const md = buildSessionReport(session({ modifiedFiles: ['/ws/old.ts'] }), [], display, 'markdown');
    assert.match(md, /\| old\.ts \| no longer in the kept history \| {2}\| {2}\|/);
  });

  it('an end before the start never yields a negative duration', () => {
    const s = session({ endedAt: T0 - 5000 });
    const json = JSON.parse(buildSessionReport(s, [], display, 'json')) as Record<string, unknown>;
    assert.equal(json['durationMs'], 0);
    assert.match(buildSessionReport(s, [], display, 'markdown'), /- Duration: 0 s/);
  });

  it('works with a huge number of files and events without throwing', () => {
    const files = Array.from({ length: 500 }, (_, i) => `/ws/f${i}.ts`);
    const many = files.map((f, i) => ev(f, { id: `e${i}` }));
    assert.doesNotThrow(() => buildSessionReport(session({ modifiedFiles: files }), many, display, 'markdown'));
    assert.doesNotThrow(() => buildSessionReport(session({ modifiedFiles: files }), many, display, 'json'));
  });
});

describe('buildSessionReport: no absolute paths and no file contents', () => {
  const abs = ['/Users/frank/secret-project/src/a.ts', '/home/dev/work/b.ts'];
  const roots = ['/Users/frank/secret-project/', '/home/dev/work/'];
  const toDisplay = (k: FileKey): string => {
    for (const r of roots) if (k.startsWith(r)) return k.slice(r.length);
    return k;
  };

  it('output built from display paths never contains the workspace location, in either format', () => {
    const s = session({ modifiedFiles: abs });
    const evs = abs.map((p, i) => ev(p, { id: `e${i}` }));
    for (const format of ['markdown', 'json'] as const) {
      const out = buildSessionReport(s, evs, toDisplay, format);
      assert.ok(!out.includes('/Users/frank'), `${format}: no home directory`);
      assert.ok(!out.includes('/home/dev'), `${format}: no home directory`);
      assert.ok(!out.includes('secret-project'), `${format}: no workspace folder name`);
      assert.ok(out.includes('src/a.ts') && out.includes('b.ts'));
    }
  });

  it('the workspace id (an opaque id) and event ids are not printed', () => {
    const s = session({ workspaceId: 'ws-opaque-123' });
    for (const format of ['markdown', 'json'] as const) {
      const out = buildSessionReport(s, events(), display, format);
      assert.ok(!out.includes('ws-opaque-123'), format);
    }
  });

  it('the report only contains what the model holds: paths, labels, counts, times, git names (no free-form content field exists)', () => {
    const json = JSON.parse(buildSessionReport(session(), events(), display, 'json')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(json).sort(), ['activityCount', 'durationMs', 'endedAt', 'files', 'gitEnd', 'gitStart', 'sources', 'startedAt', 'status', 'title']);
    for (const f of json['files'] as Array<Record<string, unknown>>) assert.deepEqual(Object.keys(f).sort(), ['changes', 'lastEvent', 'path', 'sources']);
  });
});

describe('buildSessionReport: hostile text cannot break out of the Markdown', () => {
  const hostile = ['<img src=x onerror=alert(1)>', '| a | b |', '`code`', '*bold*', '[x](javascript:alert(1))', '# heading', 'line\nbreak', '\r\n\r\n## injected', '_under_', 'a\\b'];

  it('titles and file names never add markup, rows, headings or HTML', () => {
    for (const bad of hostile) {
      const s = session({ title: bad, modifiedFiles: [`/ws/${bad}.ts`] });
      const md = buildSessionReport(s, [ev(`/ws/${bad}.ts`)], display, 'markdown');
      const lines = md.split('\n');
      assert.equal(lines.filter((l) => l.startsWith('# ')).length, 1, `only the title line is a heading: ${JSON.stringify(bad)}`);
      assert.equal(lines.filter((l) => /^## /.test(l)).length, 2, `only the two real sections: ${JSON.stringify(bad)}`);
      assert.ok(!/<img|<script/i.test(md.replace(/\\</g, '')), `no raw tag: ${JSON.stringify(bad)}`);
      const fileRows = lines.filter((l) => l.startsWith('| ') && l.endsWith('|')).filter((l) => !/^\| (File|Source) \|/.test(l));
      // two rows for the source counts (Developer, External) plus one row for the file
      assert.equal(fileRows.length, 3, `table rows: ${JSON.stringify(bad)} -> ${JSON.stringify(fileRows)}`);
    }
  });

  it('the JSON report keeps hostile strings as data, escaped by JSON.stringify', () => {
    const s = session({ title: '"},{"x":"y', modifiedFiles: ['/ws/"}.ts'] });
    const json = JSON.parse(buildSessionReport(s, [], display, 'json')) as { title: string; files: Array<{ path: string }> };
    assert.equal(json.title, '"},{"x":"y');
    assert.equal(json.files[0]?.path, '"}.ts');
  });
});
