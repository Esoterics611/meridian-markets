import { renderLandingPage, LAUNCHER_ENTRIES } from './landing-view';

// Render → assert HTML. The launcher is static, so the test pins its contract:
// a card per role page, live ones link, the unbuilt one (pm) is a disabled card,
// and nothing here executes anything (no action endpoints, no SSE feed).
describe('renderLandingPage', () => {
  const html = renderLandingPage();

  it('is a full HTML document on the launcher route', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>Meridian · launcher</title>');
    expect(html).toContain('Meridian — paper desk');
  });

  it('renders a live card linking to every shipped role page', () => {
    for (const e of LAUNCHER_ENTRIES.filter((x) => x.live)) {
      expect(html).toContain(`href="${e.href}"`);
      expect(html).toContain(e.label);
    }
  });

  it('renders the unbuilt pm page as a disabled "soon" card, not a link', () => {
    const pm = LAUNCHER_ENTRIES.find((x) => x.href === '/pm')!;
    expect(pm.live).toBe(false);
    expect(html).toContain('launch-card--soon');
    // the pm entry must NOT appear as an anchor href (no dead link)
    expect(html).not.toContain('href="/pm"');
  });

  it('carries the paper-only honesty badge and claims no business state', () => {
    expect(html).toContain('badge--paper');
    expect(html).toContain('holds no business state');
  });

  it('has no execution surface — it is a pure index (no action endpoints, no live feed)', () => {
    // the shared shell still loads the component scripts; what the launcher must NOT
    // have is an instantiated <desk-feed> element or an SSE /stream connection.
    expect(html).not.toContain('endpoint="');
    expect(html).not.toContain('<desk-feed');
    expect(html).not.toContain('/stream');
  });
});
