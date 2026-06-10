import { Controller, Get, Header, NotFoundException, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { existsSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';

// Serves the shared static UI assets (terminal CSS + the desk-feed Web Component)
// from src/ui/public/. Mirrors demo-page.controller's two-candidate locate trick
// so it works under both ts-node (src/) and a built dist/. An explicit ALLOW-LIST
// (not a path join on user input) keeps this from being a path-traversal surface —
// the UI exposes only the handful of files it ships.

const ASSET_FILES: Record<string, string> = {
  'ui.css': 'ui.css',
  'desk-feed.js': 'desk-feed.js',
  'desk-action.js': 'desk-action.js',
  'desk-form.js': 'desk-form.js',
  'copy-cmd.js': 'copy-cmd.js',
  'nav-spark.js': 'nav-spark.js',
  'activity-tape.js': 'activity-tape.js',
  'tox-strips.js': 'tox-strips.js',
};

const CONTENT_TYPES: Record<string, string> = {
  'ui.css': 'text/css; charset=utf-8',
  'desk-feed.js': 'application/javascript; charset=utf-8',
  'desk-action.js': 'application/javascript; charset=utf-8',
  'desk-form.js': 'application/javascript; charset=utf-8',
  'copy-cmd.js': 'application/javascript; charset=utf-8',
  'nav-spark.js': 'application/javascript; charset=utf-8',
  'activity-tape.js': 'application/javascript; charset=utf-8',
  'tox-strips.js': 'application/javascript; charset=utf-8',
};

function locate(file: string): string {
  const candidates = [
    resolve(process.cwd(), 'dist', 'ui', 'public', file),
    resolve(process.cwd(), 'src', 'ui', 'public', file),
    join(__dirname, 'public', file),
  ];
  // Of the copies that exist, serve the NEWEST: the build copies assets to dist/ once
  // at boot, so a dist-first preference shadowed fresh src/ edits with a stale copy
  // for the life of the watch (bit us live). mtime arbitration can't go stale either way.
  const existing = candidates.filter((c) => existsSync(c));
  if (existing.length === 0) return candidates[1];
  return existing.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

@Controller('ui')
export class UiAssetController {
  // No in-process cache: a static .js/.css edit doesn't trigger the TS watcher, so a
  // memo here would serve stale assets for the life of the process (bit us live —
  // the browser keeps its own 300s cache anyway; re-reading 8 small files is free).
  @Get(':file')
  serve(@Param('file') file: string, @Res() res: Response): void {
    const rel = ASSET_FILES[file];
    if (!rel) throw new NotFoundException(`unknown ui asset: ${file}`);
    const body = readFileSync(locate(rel), 'utf8');
    res.setHeader('Content-Type', CONTENT_TYPES[rel]);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(body);
  }
}
