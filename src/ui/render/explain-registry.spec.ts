import { existsSync } from 'fs';
import { resolve } from 'path';
import { EXPLAIN_GROUPS, EXPLAIN_REGISTRY, explainEntry } from './explain-registry';

// The registry is a stable teaching surface (TEACHING_SURFACE.md): every entry must
// be complete, every course "read more" must map to a TRACKED markdown chapter (the
// built site/ is gitignored — the .md source is the existence proof), and every
// internal link must be a real route. A dead ⓘ cannot ship.

const INTERNAL_ROUTES = ['/desk/mm', '/desk/carry', '/desk/statarb', '/desk/markout', '/desk/toxicity', '/markets', '/risk', '/exec', '/learn'];

describe('EXPLAIN_REGISTRY', () => {
  const entries = Object.entries(EXPLAIN_REGISTRY);

  it('has a usable population (the pages reference these ids)', () => {
    expect(entries.length).toBeGreaterThanOrEqual(20);
  });

  it('every entry is complete: term, a real one-liner, a known group', () => {
    for (const [id, e] of entries) {
      expect(id).toMatch(/^[a-z0-9-]+$/);
      expect(e.term.length).toBeGreaterThan(1);
      expect(e.oneLiner.length).toBeGreaterThanOrEqual(60); // a sentence, not a stub
      expect(e.oneLiner.length).toBeLessThanOrEqual(420); // an intuition, not an essay
      expect(EXPLAIN_GROUPS).toContain(e.group);
    }
  });

  it('every course "read more" maps to a tracked markdown chapter (site/ is gitignored)', () => {
    for (const [id, e] of entries) {
      if (!e.more || !e.more.href.startsWith('/courses/')) continue;
      const m = e.more.href.match(/^\/courses\/([a-z-]+)\/([a-z0-9-]+)\.html$/);
      expect(m).not.toBeNull();
      const mdPath = resolve(process.cwd(), 'courses', m![1], 'docs', `${m![2]}.md`);
      expect({ id, mdPath, exists: existsSync(mdPath) }).toEqual({ id, mdPath, exists: true });
    }
  });

  it('every internal "read more" is a real route', () => {
    for (const [, e] of entries) {
      if (!e.more || e.more.href.startsWith('/courses/')) continue;
      expect(INTERNAL_ROUTES).toContain(e.more.href);
    }
  });

  it('explainEntry() resolves known ids and refuses unknown ones', () => {
    expect(explainEntry('spread')?.term).toBe('spread');
    expect(explainEntry('nope')).toBeUndefined();
  });
});
