import { Controller, Get, Header } from '@nestjs/common';
import { renderResearchPage } from './render/research-view';

// The Quant / research role page (UI_REDESIGN_PROMPT.md §2/§5). Named *Page* to avoid
// the existing ResearchController (api/stat-arb/research — the on-demand backtest
// endpoints). This page is intentionally static + execution-free: the findings/
// KEEP-CUT board + research-doc links + the copy-the-runbook-command helper. No engine
// injection, no SSE — its content is research artifacts + terminal commands, not live
// state (a live funding board / MM screener are deferred until they have an endpoint).
//
//   GET /research — the static research desk
@Controller()
export class ResearchPageController {
  @Get('research')
  @Header('Content-Type', 'text/html; charset=utf-8')
  page(): string {
    return renderResearchPage();
  }
}
