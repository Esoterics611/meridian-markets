import { ResearchPageController } from './research.controller';

describe('ResearchPageController', () => {
  it('GET /research renders the static research desk', () => {
    const c = new ResearchPageController();
    const html = c.page();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('findings — KEEP / CUT / RESERVE');
    expect(html).toContain('runbook');
    expect(html).toContain('research docs');
  });

  it('contains no execution surface — only copy-cmd, no POST endpoints', () => {
    const html = new ResearchPageController().page();
    expect(html).toContain('<copy-cmd>');
    expect(html).not.toContain('endpoint="'); // no <desk-action>/<desk-form> writes
    expect(html).not.toContain('<desk-feed'); // no live stream
  });
});
