import { NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { UiAssetController } from './ui-asset.controller';

// The allow-list static server. The vendored-chart entry is the regression that
// matters: its rel is a SUBPATH ('vendor/…'), and a rel-keyed content-type lookup
// once returned undefined → a live 500 on /ui/lightweight-charts.js (P1 boot check).

function resStub() {
  const headers: Record<string, string> = {};
  let body = '';
  return {
    res: {
      setHeader: (k: string, v: string) => {
        if (v === undefined) throw new TypeError(`Invalid value "undefined" for header "${k}"`);
        headers[k] = v;
      },
      send: (b: string) => {
        body = b;
      },
    } as unknown as Response,
    headers,
    body: () => body,
  };
}

describe('UiAssetController', () => {
  const c = new UiAssetController();

  it('serves the vendored chart library with a JS content type (subpath rel — the 500 regression)', () => {
    const { res, headers, body } = resStub();
    c.serve('lightweight-charts.js', res);
    expect(headers['Content-Type']).toBe('application/javascript; charset=utf-8');
    expect(body()).toContain('TradingView Lightweight Charts');
  });

  it('serves the <mkt-chart> component', () => {
    const { res, headers, body } = resStub();
    c.serve('mkt-chart.js', res);
    expect(headers['Content-Type']).toBe('application/javascript; charset=utf-8');
    expect(body()).toContain("customElements.define('mkt-chart'");
  });

  it('every allow-listed asset resolves with a defined content type (no undefined-header 500s)', () => {
    for (const file of ['ui.css', 'desk-feed.js', 'desk-action.js', 'desk-form.js', 'copy-cmd.js', 'nav-spark.js', 'activity-tape.js', 'tox-strips.js', 'depth-ladder.js']) {
      const { res, headers, body } = resStub();
      c.serve(file, res);
      expect(headers['Content-Type']).toBeDefined();
      expect(body().length).toBeGreaterThan(0);
    }
  });

  it('rejects anything off the allow-list (path traversal stays impossible)', () => {
    const { res } = resStub();
    expect(() => c.serve('../secrets/env-secret.provider.ts', res)).toThrow(NotFoundException);
    expect(() => c.serve('vendor/lightweight-charts.standalone.production.js', res)).toThrow(NotFoundException);
  });
});
