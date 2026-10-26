import type { FastifyInstance } from 'fastify';
import { limiter } from './auth/routes.ts';

/**
 * CSP violation reports (docs/decisions/phase-16-polish.md, decisions 6 to 9). The browser posts
 * without a session, so the route has no auth; a global rate limit keeps the log bounded. A report
 * is attacker-controlled data: only the directive, the blocked origin and the document path are
 * logged, never the body, a sample or a query string.
 */
export const CSP_REPORT_PATH = '/api/csp-report';
const MAX_BODY = 16 * 1024;
const MAX_PER_REQUEST = 10;

type Warn = (msg: string, data: object) => void;
type Violation = { directive?: unknown; blocked?: unknown; document?: unknown };

const directive = (x: unknown) =>
  typeof x === 'string' && /^[a-z-]{1,40}$/.test(x) ? x : undefined;

/** The origin of a URL, its scheme for `data:` or `blob:`, or a short keyword (`inline`, `eval`). */
function blockedOrigin(x: unknown): string | undefined {
  if (typeof x !== 'string' || !x) return undefined;
  try {
    const u = new URL(x);
    return u.origin !== 'null' ? u.origin : u.protocol;
  } catch {
    return /^[a-z-]{1,32}$/.test(x) ? x : 'other';
  }
}

const pathOf = (x: unknown) => {
  if (typeof x !== 'string') return undefined;
  try {
    return new URL(x).pathname.slice(0, 200);
  } catch {
    return undefined;
  }
};

/** The violations of an `application/csp-report` object or an `application/reports+json` array. */
function violations(body: unknown): Violation[] {
  if (Array.isArray(body))
    return body
      .filter((r) => r?.type === 'csp-violation' && r.body && typeof r.body === 'object')
      .map(({ body: b }) => ({
        directive: b.effectiveDirective ?? b.violatedDirective,
        blocked: b.blockedURL,
        document: b.documentURL,
      }));
  const r = (body as { 'csp-report'?: Record<string, unknown> } | null)?.['csp-report'];
  return r && typeof r === 'object'
    ? [
        {
          directive: r['effective-directive'] ?? r['violated-directive'],
          blocked: r['blocked-uri'],
          document: r['document-uri'],
        },
      ]
    : [];
}

export function cspReportRoutes(app: FastifyInstance, warn: Warn) {
  const limit = limiter(app, 30);
  return app.register(async (scope) => {
    scope.addContentTypeParser(
      ['application/csp-report', 'application/reports+json'],
      { parseAs: 'string', bodyLimit: MAX_BODY },
      (_req, body, done) => {
        try {
          done(null, JSON.parse(String(body)));
        } catch {
          done(Object.assign(new Error('bad report'), { statusCode: 400 }), undefined);
        }
      },
    );
    scope.post(CSP_REPORT_PATH, { bodyLimit: MAX_BODY, logLevel: 'warn' }, async (req, reply) => {
      if (limit.blocked('csp')) return reply.code(429).send({ error: 'rate_limited' });
      limit.fail('csp');
      for (const v of violations(req.body).slice(0, MAX_PER_REQUEST))
        warn('csp violation', {
          directive: directive(v.directive),
          blocked: blockedOrigin(v.blocked),
          path: pathOf(v.document),
        });
      return reply.code(204).send();
    });
  });
}
