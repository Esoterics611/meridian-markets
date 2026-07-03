import { Controller, Get, Header } from '@nestjs/common';
import { renderResearchPage } from './render/research-view';
import { loadLatestDifferentialBoard } from './research-board-loader';

// The Quant / research role page (UI_REDESIGN_PROMPT.md §2/§5). Named *Page* to avoid
// the existing ResearchController (api/stat-arb/research — the on-demand backtest
// endpoints). This page is execution-free: the findings/KEEP-CUT board, the
// funding-differential MEASUREMENT board (newest daily artifact, read at page load —
// U3.1), research-doc links, and the copy-the-runbook-command helper. No engine
// injection, no SSE — artifacts + terminal commands, not live state.
//
//   GET /research — the research desk
@Controller()
export class ResearchPageController {
  @Get('research')
  @Header('Content-Type', 'text/html; charset=utf-8')
  page(): string {
    return renderResearchPage(loadLatestDifferentialBoard());
  }
}
