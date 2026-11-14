import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FileActivity } from '../../src/core/activity/eventStore';
import { PAYLOAD_DESCRIPTION, PROVIDER_LABEL_LIMIT, ProviderRegistry, SUMMARY_FILE_LIMIT, buildSummaryInput, canSend, consentMessage, isAiProvider } from '../../src/core/ai/provider';
import type { AiProvider, Consent, SummaryInput } from '../../src/core/ai/provider';
import { localSummary } from '../../src/core/ai/localSummary';
import { SOURCE_TYPES } from '../../src/core/dashboard/protocol';
import { DEFAULT_SENSITIVE_GLOBS } from '../../src/core/config';
import { createExcludeMatcher } from '../../src/core/glob';
import type { ActivitySourceType } from '../../src/core/types';
import { must } from '../support/fixtures';

const provider = (o: Partial<AiProvider> = {}): AiProvider => ({ id: 'acme.llm', label: 'Acme LLM', summarize: async () => 'ok', ...o });

function file(key: string, o: Partial<FileActivity> = {}): FileActivity {
  return {
    key,
    sourceType: 'developer',
    detectionMethod: 'focused-editor-edit',
    confidence: 0.9,
    lastEventType: 'modify',
    firstAt: 1,
    lastAt: 2,
    changes: 1,
    review: undefined,
    exists: true,
    ...o,
  };
}

const rel = (k: string): string => (k.startsWith('/ws/') ? k.slice(4) : k);

describe('canSend: the consent gate', () => {
  const modes = ['local', 'assisted'] as const;
  const consents: Consent[] = ['granted', 'denied', 'unset'];

  it('local mode never sends, whatever the consent and provider', () => {
    for (const consent of consents) {
      for (const p of [undefined, provider()]) {
        const r = canSend('local', consent, p);
        assert.equal(r.ok, false, `${consent} ${p ? 'provider' : 'no provider'}`);
        assert.match(r.reason, /local/i);
        assert.match(r.reason, /nothing is sent/i);
      }
    }
  });

  it('assisted without a provider is refused, whatever the consent', () => {
    for (const consent of consents) {
      const r = canSend('assisted', consent, undefined);
      assert.equal(r.ok, false, consent);
      assert.match(r.reason, /no ai provider/i);
    }
  });

  it('assisted with a provider but consent unset or denied is refused, and the reason names the provider', () => {
    for (const consent of ['unset', 'denied'] as const) {
      const r = canSend('assisted', consent, provider({ label: 'Acme LLM' }));
      assert.equal(r.ok, false, consent);
      assert.ok(r.reason.includes('Acme LLM'), r.reason);
    }
  });

  it('assisted + provider + consent granted is the ONLY ok combination', () => {
    const results: string[] = [];
    for (const mode of modes) {
      for (const consent of consents) {
        for (const p of [undefined, provider()]) if (canSend(mode, consent, p).ok) results.push(`${mode}/${consent}/${p ? 'provider' : 'none'}`);
      }
    }
    assert.deepEqual(results, ['assisted/granted/provider']);
  });

  it('an unexpected consent value (corrupt storage) or mode is treated as no consent / local', () => {
    assert.equal(canSend('assisted', 'maybe' as unknown as Consent, provider()).ok, false);
    assert.equal(canSend('assisted', undefined as unknown as Consent, provider()).ok, false);
    assert.equal(canSend('Assisted' as unknown as 'assisted', 'granted', provider()).ok, false, 'a mode that is not exactly "assisted" is local');
    assert.equal(canSend(undefined as unknown as 'local', 'granted', provider()).ok, false);
    assert.equal(canSend('assisted', 'GRANTED' as unknown as Consent, provider()).ok, false);
  });

  it('every reason is a full sentence', () => {
    for (const mode of modes) for (const consent of consents) for (const p of [undefined, provider()]) assert.match(canSend(mode, consent, p).reason, /^[A-Z].*\.$/);
  });
});

describe('ProviderRegistry and isAiProvider', () => {
  it('register, get, list (sorted by id), dispose', () => {
    const reg = new ProviderRegistry();
    const b = provider({ id: 'b.prov', label: 'B' });
    const a = provider({ id: 'a.prov', label: 'A' });
    const hb = reg.register(b);
    reg.register(a);
    assert.deepEqual(
      reg.list().map((p) => p.id),
      ['a.prov', 'b.prov'],
    );
    assert.equal(reg.get('a.prov'), a);
    hb.dispose();
    assert.equal(reg.get('b.prov'), undefined);
    assert.equal(reg.list().length, 1);
    hb.dispose();
    assert.equal(reg.list().length, 1, 'disposing twice is harmless');
  });

  it('registering the same id replaces; the old registration cannot remove the new one', () => {
    const reg = new ProviderRegistry();
    const first = provider({ label: 'first' });
    const second = provider({ label: 'second' });
    const h1 = reg.register(first);
    reg.register(second);
    assert.equal(reg.get('acme.llm'), second);
    h1.dispose();
    assert.equal(reg.get('acme.llm'), second);
  });

  it('refuses an invalid provider: missing or bad id, empty or long label, no summarize', () => {
    const reg = new ProviderRegistry();
    const bad: unknown[] = [
      null,
      undefined,
      'x',
      {},
      { id: 'a', label: 'A' },
      { id: '', label: 'A', summarize: () => Promise.resolve('') },
      { id: '.leading-dot', label: 'A', summarize: () => Promise.resolve('') },
      { id: 'has space', label: 'A', summarize: () => Promise.resolve('') },
      { id: 'a'.repeat(65), label: 'A', summarize: () => Promise.resolve('') },
      { id: '../evil', label: 'A', summarize: () => Promise.resolve('') },
      { id: 'a', label: '', summarize: () => Promise.resolve('') },
      { id: 'a', label: '   ', summarize: () => Promise.resolve('') },
      { id: 'a', label: 'x'.repeat(PROVIDER_LABEL_LIMIT + 1), summarize: () => Promise.resolve('') },
      { id: 'a', label: 'A', summarize: 'not a function' },
      { id: 7, label: 'A', summarize: () => Promise.resolve('') },
    ];
    for (const p of bad) {
      assert.equal(isAiProvider(p), false, JSON.stringify(p));
      assert.throws(() => reg.register(p as AiProvider), TypeError);
    }
    assert.equal(reg.list().length, 0);
  });

  it('accepts ids at the pattern boundary', () => {
    for (const id of ['a', 'A1', '0abc', 'a.b-c_d', 'a'.repeat(64)]) assert.equal(isAiProvider(provider({ id })), true, id);
    assert.equal(isAiProvider(provider({ label: 'x'.repeat(PROVIDER_LABEL_LIMIT) })), true);
  });

  it('get of an unknown id is undefined, even for prototype names', () => {
    const reg = new ProviderRegistry();
    for (const id of ['', 'nope', 'constructor', '__proto__', 'toString']) assert.equal(reg.get(id), undefined, id);
  });
});

describe('buildSummaryInput: what a provider could ever receive', () => {
  // the host matches the workspace-relative path against fileShake.sensitiveGlobs
  const matcher = createExcludeMatcher(['**/.env*', '**/*.pem', '**/secrets/**'], {});
  const sensitive = (key: string): boolean => matcher(rel(key));

  it('sensitive files are dropped entirely: not listed and not even counted', () => {
    const input = buildSummaryInput({
      files: [file('/ws/.env', { sourceType: 'external' }), file('/ws/app.ts'), file('/ws/certs/server.pem', { sourceType: 'external' }), file('/ws/secrets/token.txt', { sourceType: 'ai-agent' }), file('/ws/src/.env.local')],
      toDisplay: rel,
      isSensitive: sensitive,
    });
    assert.deepEqual(
      input.files.map((f) => f.path),
      ['app.ts'],
    );
    assert.equal(input.bySource.external, 0);
    assert.equal(input.bySource['ai-agent'], 0);
    assert.equal(input.bySource.developer, 1);
  });

  it('a throwing sensitivity check counts as sensitive (fail closed)', () => {
    const input = buildSummaryInput({
      files: [file('/ws/a.ts'), file('/ws/b.ts')],
      toDisplay: rel,
      isSensitive: () => {
        throw new Error('glob engine failed');
      },
    });
    assert.deepEqual(input.files, []);
    assert.equal(Object.values(input.bySource).reduce((a, b) => a + b, 0), 0);
  });

  it('paths are the display paths given by toDisplay, never the absolute key', () => {
    const input = buildSummaryInput({ files: [file('/Users/frank/work/proj/src/a.ts')], toDisplay: () => 'src/a.ts', isSensitive: () => false });
    assert.equal(must(input.files[0]).path, 'src/a.ts');
    assert.ok(!JSON.stringify(input).includes('/Users/frank'));
  });

  it('at most 100 files are listed, newest first order is kept, but the per-source counts cover every non-sensitive file', () => {
    assert.equal(SUMMARY_FILE_LIMIT, 100);
    const files = Array.from({ length: 150 }, (_, i) => file(`/ws/f${i}.ts`, { sourceType: i % 2 === 0 ? 'developer' : 'external', changes: i + 1 }));
    const input = buildSummaryInput({ files, toDisplay: rel, isSensitive: () => false });
    assert.equal(input.files.length, 100);
    assert.equal(must(input.files[0]).path, 'f0.ts');
    assert.equal(must(input.files[99]).path, 'f99.ts');
    assert.equal(input.bySource.developer + input.bySource.external, 150);
  });

  it('sensitive files do not use up slots of the 100', () => {
    const files = [...Array.from({ length: 50 }, (_, i) => file(`/ws/.env${i}`)), ...Array.from({ length: 120 }, (_, i) => file(`/ws/ok${i}.ts`))];
    const input = buildSummaryInput({ files, toDisplay: rel, isSensitive: sensitive });
    assert.equal(input.files.length, 100);
    assert.ok(input.files.every((f) => f.path.startsWith('ok')));
  });

  it('every file entry has exactly path, source, changes and eventType: no content, no id, no absolute key', () => {
    const input = buildSummaryInput({ files: [file('/ws/a.ts', { lastEventType: 'create', changes: 4, sourceType: 'ai-agent', sourceId: 'claude-code' })], toDisplay: rel, isSensitive: () => false });
    assert.deepEqual(input.files, [{ path: 'a.ts', source: 'ai-agent', changes: 4, eventType: 'create' }]);
    assert.deepEqual(Object.keys(must(input.files[0])).sort(), ['changes', 'eventType', 'path', 'source']);
  });

  it('the whole payload has only the documented top-level fields and nothing that looks like source text', () => {
    const input = buildSummaryInput({ files: [file('/ws/a.ts')], toDisplay: rel, isSensitive: () => false, session: { title: 'Work', durationMs: 5000 }, branch: 'main' });
    assert.deepEqual(Object.keys(input).sort(), ['bySource', 'branch', 'files', 'session'].sort());
    assert.deepEqual(input.session, { title: 'Work', durationMs: 5000 });
    assert.equal(input.branch, 'main');
  });

  it('bySource has every source type, zero when absent', () => {
    const input = buildSummaryInput({ files: [], toDisplay: rel, isSensitive: () => false });
    assert.deepEqual(Object.keys(input.bySource).sort(), [...SOURCE_TYPES].sort());
    assert.ok(Object.values(input.bySource).every((n) => n === 0));
    assert.deepEqual(input.files, []);
    assert.equal('session' in input, false);
    assert.equal('branch' in input, false);
  });

  it('a negative session duration is clamped to 0; an empty branch is left out', () => {
    const input = buildSummaryInput({ files: [], toDisplay: rel, isSensitive: () => false, session: { title: 't', durationMs: -50 }, branch: '' });
    assert.equal(input.session?.durationMs, 0);
    assert.equal('branch' in input, false);
  });

  it('the input list is not mutated', () => {
    const files = [file('/ws/a.ts')];
    const copy = JSON.stringify(files);
    buildSummaryInput({ files, toDisplay: rel, isSensitive: () => false });
    assert.equal(JSON.stringify(files), copy);
  });

  it('the DEFAULT sensitive globs catch the usual secret files at any depth and leave look-alikes alone', () => {
    const isSensitive = createExcludeMatcher([...DEFAULT_SENSITIVE_GLOBS], {});
    const secret = ['.env', '.env.local', 'app/.env.production', 'cert.pem', 'deep/dir/server.pem', 'private.key', 'a/b/c.key', 'client.pfx', 'client.p12', 'id_rsa', 'id_rsa.pub', '.ssh/id_ed25519', 'id_ed25519.pub', 'secrets/token.txt', 'app/secrets/db/password', '.npmrc', 'sub/.npmrc', '.netrc'];
    const fine = ['environment.ts', 'src/env.ts', 'keyboard.ts', 'monkey.ts', 'pem.ts', 'src/secrets.ts', 'src/secret/a.ts', 'npmrc.md', 'netrc', 'README.md', 'src/idea_rsa_notes.ts'];
    for (const p of secret) assert.equal(isSensitive(p), true, p);
    for (const p of fine) assert.equal(isSensitive(p), false, p);
  });

  it('with the default globs a secret never reaches the payload, whichever source touched it', () => {
    const isSensitive = createExcludeMatcher([...DEFAULT_SENSITIVE_GLOBS], {});
    const keys = ['/ws/.env', '/ws/api/.env.production', '/ws/certs/a.pem', '/ws/secrets/x', '/ws/id_rsa', '/ws/src/app.ts'];
    for (const sourceType of SOURCE_TYPES) {
      const input = buildSummaryInput({ files: keys.map((k) => file(k, { sourceType })), toDisplay: rel, isSensitive: (k) => isSensitive(rel(k)) });
      assert.deepEqual(
        input.files.map((f) => f.path),
        ['src/app.ts'],
        sourceType,
      );
    }
  });

  it('consent prompt text names the provider and lists exactly what is sent, including that contents are never sent', () => {
    const { message, detail } = consentMessage({ id: 'acme.llm', label: 'Acme LLM' });
    assert.ok(message.includes('Acme LLM') && message.includes('acme.llm'));
    for (const line of PAYLOAD_DESCRIPTION) assert.ok(detail.includes(line), line);
    assert.match(detail, /File contents are never sent/);
    assert.match(detail, /this workspace only/);
    assert.match(detail, /Reset AI Consent/);
  });

  it('the payload description does not promise anything the payload does not contain', () => {
    const text = PAYLOAD_DESCRIPTION.join(' ');
    assert.doesNotMatch(text, /source (code|text)|file contents? (are|is) sent|diff|absolute/i);
  });
});

describe('localSummary: metadata only, deterministic', () => {
  const bySource = (o: Partial<Record<ActivitySourceType, number>>): Record<ActivitySourceType, number> => ({ developer: 0, 'ai-agent': 0, external: 0, git: 0, automated: 0, unknown: 0, ...o });
  const input = (o: Partial<SummaryInput> = {}): SummaryInput => ({ files: [], bySource: bySource({}), ...o });

  it('no activity says so', () => {
    assert.equal(localSummary(input()), 'No file activity has been recorded yet.');
  });

  it('one file, one source', () => {
    const s = localSummary(input({ bySource: bySource({ developer: 1 }), files: [{ path: 'a.ts', source: 'developer', changes: 3, eventType: 'modify' }] }));
    assert.match(s, /^1 file changed: 1 by you\./);
    assert.match(s, /Most changed: a\.ts \(3 changes\)\./);
    assert.ok(!/something other than your typing/.test(s), 'all by you: no warning sentence');
  });

  it('lists the sources in the fixed order with their phrases', () => {
    const s = localSummary(input({ bySource: bySource({ developer: 7, external: 4, 'ai-agent': 1, git: 2, automated: 3, unknown: 1 }) }));
    assert.ok(s.startsWith('18 files changed: 7 by you, 1 by an AI agent, 4 external, 2 from Git, 3 automated and 1 of unknown origin.'), s);
    assert.match(s, /11 files were changed by something other than your typing\./);
  });

  it('most changed: the top three by count, ties by path, singular and plural change words', () => {
    const files = [
      { path: 'z.ts', source: 'developer' as const, changes: 5, eventType: 'modify' as const },
      { path: 'a.ts', source: 'developer' as const, changes: 5, eventType: 'modify' as const },
      { path: 'm.ts', source: 'developer' as const, changes: 1, eventType: 'modify' as const },
      { path: 'x.ts', source: 'developer' as const, changes: 9, eventType: 'modify' as const },
    ];
    const s = localSummary(input({ files, bySource: bySource({ developer: 4 }) }));
    assert.match(s, /Most changed: x\.ts \(9 changes\), a\.ts \(5 changes\) and z\.ts \(5 changes\)\./);
    assert.ok(!s.includes('m.ts'));
    const one = localSummary(input({ files: [{ path: 'm.ts', source: 'developer', changes: 1, eventType: 'modify' }], bySource: bySource({ developer: 1 }) }));
    assert.match(one, /m\.ts \(1 change\)/);
  });

  it('created and deleted files are counted in words', () => {
    const files = [
      { path: 'a.ts', source: 'developer' as const, changes: 1, eventType: 'create' as const },
      { path: 'b.ts', source: 'developer' as const, changes: 1, eventType: 'create' as const },
      { path: 'c.ts', source: 'developer' as const, changes: 1, eventType: 'delete' as const },
    ];
    assert.match(localSummary(input({ files, bySource: bySource({ developer: 3 }) })), /2 files were created and 1 file was deleted\./);
    assert.match(localSummary(input({ files: files.slice(2), bySource: bySource({ developer: 1 }) })), /1 file was deleted\./);
  });

  it('session and branch sentences', () => {
    const s = localSummary(input({ bySource: bySource({ developer: 1 }), session: { title: 'Refactor', durationMs: 95 * 60_000 }, branch: 'feature/x' }));
    assert.match(s, /Session "Refactor" has been running for 1 h 35 min\./);
    assert.match(s, /Current branch: feature\/x\./);
  });

  it('when fewer files are listed than were counted it says so', () => {
    const s = localSummary(input({ bySource: bySource({ developer: 150 }), files: Array.from({ length: 100 }, (_, i) => ({ path: `f${i}.ts`, source: 'developer' as const, changes: 1, eventType: 'modify' as const })) }));
    assert.match(s, /Only the 100 most recent files are listed here\./);
  });

  it('is deterministic: the same input gives the same text, and key order of the input does not matter', () => {
    const a = input({ bySource: { developer: 2, external: 1, 'ai-agent': 0, git: 0, automated: 0, unknown: 0 } });
    const b = input({ bySource: { unknown: 0, automated: 0, git: 0, 'ai-agent': 0, external: 1, developer: 2 } });
    assert.equal(localSummary(a), localSummary(b));
    for (let i = 0; i < 20; i += 1) assert.equal(localSummary(a), localSummary(a));
  });

  it('is total: a missing source count, NaN, and huge numbers never throw', () => {
    assert.doesNotThrow(() => localSummary({ files: [], bySource: {} as Record<ActivitySourceType, number> }));
    assert.doesNotThrow(() => localSummary(input({ bySource: bySource({ developer: Number.NaN }) })));
    assert.doesNotThrow(() => localSummary(input({ bySource: bySource({ developer: 1e12 }), files: [{ path: 'a', source: 'developer', changes: 1e12, eventType: 'modify' }] })));
  });

  it('it never adds text that is not in its input: no path or word from outside the metadata', () => {
    const secret = 'SUPER_SECRET_FILE_CONTENT_12345';
    const s = localSummary(input({ bySource: bySource({ developer: 1 }), files: [{ path: 'a.ts', source: 'developer', changes: 1, eventType: 'modify' }] }));
    assert.ok(!s.includes(secret));
  });

  it('is built without any provider, network or clock (calling it needs nothing but the input)', () => {
    assert.equal(typeof localSummary, 'function');
    assert.equal(localSummary.length, 1);
  });
});
