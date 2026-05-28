import { Controller, Get, Header, Res } from '@nestjs/common';
import type { Response } from 'express';
import { join, resolve } from 'path';
import { existsSync, readFileSync } from 'fs';

// Serves the static dashboard at GET /demo. We resolve the HTML file at
// startup to keep the request hot-path a pure send. Two candidate paths
// are checked because `npm start` (ts-node) runs against src/ while
// `start:prod` runs against dist/ — same trick as the nest-cli asset copy.

function locateIndex(): string {
  const candidates = [
    // Production: dist/stat-arb/demo/public/index.html copied via nest-cli assets.
    resolve(process.cwd(), 'dist', 'stat-arb', 'demo', 'public', 'index.html'),
    // ts-node / development: read directly from the source tree.
    resolve(process.cwd(), 'src', 'stat-arb', 'demo', 'public', 'index.html'),
    // Fallback: resolve relative to this compiled file (works from dist).
    join(__dirname, 'public', 'index.html'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  // Best-effort: pick the source path so the error is informative.
  return candidates[1];
}

const INDEX_HTML_PATH = locateIndex();
let cachedHtml: string | null = null;

@Controller('demo')
export class DemoPageController {
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  serve(@Res() res: Response): void {
    if (cachedHtml === null) {
      cachedHtml = readFileSync(INDEX_HTML_PATH, 'utf8');
    }
    res.send(cachedHtml);
  }
}
