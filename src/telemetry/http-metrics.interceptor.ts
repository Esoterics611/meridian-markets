import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { ITelemetry, TELEMETRY } from './telemetry.interface';
import { M } from './metric-catalog';

// HttpMetricsInterceptor — records http_requests_total{route,method,status} +
// http_request_duration_seconds{route,method} for every request. Registered as a
// global APP_INTERCEPTOR by the TelemetryModule; when telemetry is disabled it
// short-circuits to a passthrough (zero overhead). The label is the matched route
// TEMPLATE (`req.route.path`), never the raw URL, so query strings / params can't
// blow up cardinality (DC-4).
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(@Inject(TELEMETRY) private readonly telemetry: ITelemetry) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.telemetry.enabled || context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<{ method?: string; route?: { path?: string }; originalUrl?: string; url?: string }>();
    const method = (req.method ?? 'GET').toUpperCase();
    const route = req.route?.path ?? (req.originalUrl ?? req.url ?? '').split('?')[0] ?? 'unknown';
    const start = Date.now();

    const record = (status: number): void => {
      this.telemetry.counter(M.httpRequests, { route, method, status: String(status) });
      this.telemetry.histogram(M.httpDuration, (Date.now() - start) / 1000, { route, method });
    };

    return next.handle().pipe(
      tap({
        next: () => record(http.getResponse<{ statusCode?: number }>().statusCode ?? 200),
        error: (err: { status?: number }) => record(err?.status ?? 500),
      }),
    );
  }
}
