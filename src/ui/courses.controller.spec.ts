import { NotFoundException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CoursesController } from './courses.controller';

/** The root is a protected field (not a ctor param — Nest would DI it); tests
 *  subclass to point it at the throwaway tree. */
class TestCoursesController extends CoursesController {
  constructor(root: string) {
    super();
    this.root = root;
  }
}

// Same-origin course serving (P3 D2). The site/ dirs are gitignored, so the specs
// build a throwaway root: serving, traversal, the honest not-built page, and 404s
// are all asserted against a controlled tree, never the developer's local build.

function resStub() {
  const headers: Record<string, string> = {};
  let body: unknown = '';
  let status = 200;
  let redirectedTo = '';
  const res = {
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
    status: (s: number) => {
      status = s;
      return res;
    },
    send: (b: unknown) => {
      body = b;
    },
    redirect: (s: number, url: string) => {
      status = s;
      redirectedTo = url;
    },
  } as unknown as Response & { redirect: (s: number, url: string) => void };
  return { res, headers, body: () => String(body), statusOf: () => status, redirect: () => redirectedTo };
}

const reqWith = (rest: string) => ({ params: { '0': rest } }) as unknown as Request;

describe('CoursesController', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'meridian-courses-'));
    mkdirSync(join(root, 'courses/market-making/site/assets'), { recursive: true });
    writeFileSync(join(root, 'courses/market-making/site/index.html'), '<h1>MM course</h1>');
    writeFileSync(join(root, 'courses/market-making/site/02-microstructure.html'), '<h1>Microstructure</h1>');
    writeFileSync(join(root, 'courses/market-making/site/assets/style.css'), 'body{}');
    // stat-arb deliberately NOT built → the honest page
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('serves a chapter + nested assets with correct content types', () => {
    const c = new TestCoursesController(root);
    const a = resStub();
    c.serve('market-making', reqWith('02-microstructure.html'), a.res);
    expect(a.headers['Content-Type']).toContain('text/html');
    expect(a.body()).toContain('Microstructure');
    const b = resStub();
    c.serve('market-making', reqWith('assets/style.css'), b.res);
    expect(b.headers['Content-Type']).toContain('text/css');
  });

  it('serves index.html for the site root and redirects ONLY the slashless URL (no self-redirect loop)', () => {
    const c = new TestCoursesController(root);
    const a = resStub();
    c.serve('market-making', reqWith(''), a.res);
    expect(a.body()).toContain('MM course');
    // slashless → 302 to the slashed form (mkdocs relative links need it)
    const b = resStub();
    c.courseRoot('market-making', { path: '/courses/market-making' } as unknown as Request, b.res);
    expect(b.redirect()).toBe('/courses/market-making/');
    // slashed → Express matches this SAME route (trailing slash ignored); it must
    // serve the index, not redirect to itself forever (found live, P3 boot check).
    const d = resStub();
    c.courseRoot('market-making', { path: '/courses/market-making/' } as unknown as Request, d.res);
    expect(d.redirect()).toBe('');
    expect(d.body()).toContain('MM course');
  });

  it('renders the honest not-built page when the site dir is missing', () => {
    const c = new TestCoursesController(root);
    const a = resStub();
    c.serve('stat-arb', reqWith('index.html'), a.res);
    expect(a.body()).toContain('course site not built');
    expect(a.body()).toContain('mkdocs build');
  });

  it('blocks traversal and unknown courses (allow-list + inside-the-site-dir guard)', () => {
    const c = new TestCoursesController(root);
    expect(() => c.serve('market-making', reqWith('../../../CLAUDE.md'), resStub().res)).toThrow(NotFoundException);
    expect(() => c.serve('nope', reqWith('index.html'), resStub().res)).toThrow(NotFoundException);
    expect(() => c.courseRoot('nope', { path: '/courses/nope' } as unknown as Request, resStub().res)).toThrow(NotFoundException);
    expect(() => c.serve('market-making', reqWith('missing.html'), resStub().res)).toThrow(NotFoundException);
  });
});
