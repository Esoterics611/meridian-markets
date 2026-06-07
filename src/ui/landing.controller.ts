import { Controller, Get, Header } from '@nestjs/common';
import { renderLandingPage } from './render/landing-view';

// The role launcher at `/` (UI_ARCHITECTURE.md §3) — replaces the old root that
// redirected to /demo. Static by construction: no engine injection, no SSE; it
// just renders the role-card index. The live numbers live behind each role link.
//
//   GET /   — the server-rendered launcher (role index)
@Controller()
export class LandingController {
  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  page(): string {
    return renderLandingPage();
  }
}
