import { NotFoundException } from '@nestjs/common';
import { LearnController } from './learn.controller';

// The academy hub: static, no execution surface (same class as /research), and the
// explain-fragment endpoint every ⓘ fetches. 404s honestly on unknown ids.

describe('LearnController', () => {
  const c = new LearnController();

  it('GET /learn renders the hub: both courses, the learning path, tours, and the glossary', () => {
    const html = c.page();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('course — Market Making');
    expect(html).toContain('course — Statistical Arbitrage');
    expect(html).toContain('/courses/market-making/02-microstructure.html');
    expect(html).toContain('learning path');
    expect(html).toContain('/desk/mm?tour=1');
    expect(html).toContain('glossary');
    expect(html).toContain('adverse selection'); // a registry term rendered on-site
    // no execution surface — this page never posts anywhere
    expect(html).not.toContain('<desk-action');
    expect(html).not.toContain('<desk-form');
  });

  it('GET /learn/explain/:id serves the drawer fragment with term, intuition, and read-more', () => {
    const frag = c.explain('spread');
    expect(frag).toContain('xdrawer-term');
    expect(frag).toContain('spread');
    expect(frag).toContain('market maker');
    expect(frag).toContain('/courses/market-making/02-microstructure.html');
    expect(frag).not.toContain('<!doctype'); // a fragment, not a document
  });

  it('404s honestly on an unknown id (never fabricates an explanation)', () => {
    expect(() => c.explain('not-a-term')).toThrow(NotFoundException);
  });
});
