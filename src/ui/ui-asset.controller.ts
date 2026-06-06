import { Controller, Get, Header, NotFoundException, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { existsSync, readFileSync } from 'fs';
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
};

const CONTENT_TYPES: Record<string, string> = {
  'ui.css': 'text/css; charset=utf-8',
  'desk-feed.js': 'application/javascript; charset=utf-8',
  'desk-action.js': 'application/javascript; charset=utf-8',
};

function locate(file: string): string {
  const candidates = [
    resolve(process.cwd(), 'dist', 'ui', 'public', file),
    resolve(process.cwd(), 'src', 'ui', 'public', file),
    join(__dirname, 'public', file),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[1];
}

@Controller('ui')
export class UiAssetController {
  private readonly cache = new Map<string, string>();

  @Get(':file')
  serve(@Param('file') file: string, @Res() res: Response): void {
    const rel = ASSET_FILES[file];
    if (!rel) throw new NotFoundException(`unknown ui asset: ${file}`);
    let body = this.cache.get(rel);
    if (body === undefined) {
      body = readFileSync(locate(rel), 'utf8');
      this.cache.set(rel, body);
    }
    res.setHeader('Content-Type', CONTENT_TYPES[rel]);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(body);
  }
}
