import { Controller, Get, Header, NotFoundException, Param } from '@nestjs/common';
import { renderExplainFragment, renderLearnPage } from './render/learn-view';

// The academy hub (UI_REWRITE_PLAN_III P3): a static page (no live data, no
// execution surface — same class as /research) plus the explain-drawer fragment
// endpoint every <explain-tip> fetches. Dependency-free ⇒ declared in UiModule.
//
//   GET /learn              — the hub (courses · learning path · tours · glossary)
//   GET /learn/explain/:id  — one term's server-rendered drawer fragment (404 = honest)

@Controller()
export class LearnController {
  @Get('learn')
  @Header('Content-Type', 'text/html; charset=utf-8')
  page(): string {
    return renderLearnPage();
  }

  @Get('learn/explain/:id')
  @Header('Content-Type', 'text/html; charset=utf-8')
  explain(@Param('id') id: string): string {
    const fragment = renderExplainFragment(id);
    if (!fragment) throw new NotFoundException(`no explain entry: ${id}`);
    return fragment.value;
  }
}
