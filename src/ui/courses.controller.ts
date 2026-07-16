import { Controller, Get, NotFoundException, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { existsSync, readFileSync, statSync } from 'fs';
import { extname, resolve, sep } from 'path';

// Same-origin course serving (UI_REWRITE_PLAN_III P3, decision D2): the two built
// mkdocs sites mount at /courses/<course>/ so desk pages and chapters can link both
// ways without caring where the desk runs. The site/ dirs are BUILT LOCALLY and
// gitignored — when one is missing this serves an honest "not built" page with the
// build command, never a broken link maze. Netlify remains the public host.
//
// Security: course ids are allow-listed and the resolved path must stay inside the
// course's site dir (no traversal); anything else is a 404.

const COURSE_SITES: Record<string, string> = {
  'market-making': 'courses/market-making/site',
  'stat-arb': 'courses/stat-arb/site',
};

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function notBuiltPage(course: string): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>course not built</title>' +
    '<link rel="stylesheet" href="/ui/ui.css"></head><body><main class="page">' +
    `<h1 class="page-title">course site not built — ${course}</h1>` +
    '<p class="dim">The course source (markdown) is in the repo; the browsable site is built locally and git-ignored. Build it, then reload:</p>' +
    `<p><code>cd courses/${course} &amp;&amp; mkdocs build</code></p>` +
    '<p class="dim">back to <a href="/learn">/learn</a></p>' +
    '</main></body></html>'
  );
}

@Controller()
export class CoursesController {
  /** Overridable in tests (a subclass points it at a temp dir with a fake site
   *  tree) — NOT a constructor param, which Nest would try to DI-resolve. */
  protected root: string = process.cwd();

  @Get('courses/:course')
  courseRoot(@Param('course') course: string, @Req() req: Request, @Res() res: Response): void {
    if (!COURSE_SITES[course]) throw new NotFoundException(`unknown course: ${course}`);
    // Express matches this route for BOTH /courses/x and /courses/x/ (trailing slash
    // ignored) — redirecting unconditionally would loop on the slashed form (found
    // live, P3 boot check). Slashless → redirect (relative links inside the mkdocs
    // pages need the slash); slashed → serve the site index directly.
    if (!req.path.endsWith('/')) {
      res.redirect(302, `/courses/${course}/`);
      return;
    }
    this.sendFromSite(course, 'index.html', res);
  }

  @Get('courses/:course/*')
  serve(@Param('course') course: string, @Req() req: Request, @Res() res: Response): void {
    if (!COURSE_SITES[course]) throw new NotFoundException(`unknown course: ${course}`);
    let rel = ((req.params as Record<string, string>)['0'] ?? '').trim();
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    this.sendFromSite(course, rel, res);
  }

  private sendFromSite(course: string, rel: string, res: Response): void {
    const base = resolve(this.root, COURSE_SITES[course]);
    if (!existsSync(base)) {
      res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(notBuiltPage(course));
      return;
    }
    const abs = resolve(base, rel);
    // Traversal guard: the resolved path must stay inside the site dir.
    if (abs !== base && !abs.startsWith(base + sep)) throw new NotFoundException('not found');
    if (!existsSync(abs)) throw new NotFoundException(`not found: ${rel}`);
    const target = statSync(abs).isDirectory() ? resolve(abs, 'index.html') : abs;
    if (!existsSync(target)) throw new NotFoundException(`not found: ${rel}`);
    res.setHeader('Content-Type', CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(readFileSync(target));
  }
}
