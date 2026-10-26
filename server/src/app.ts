import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
import { API_PREFIX, LIMITS } from './config/constants';
import { requestContext } from './middleware/requestContext';
import { notFoundHandler, errorHandler } from './middleware/errors';
import { authRouter } from './modules/auth/auth.routes';
import { orgRouter } from './modules/organizations/org.routes';
import { clientRouter } from './modules/clients/clients.routes';
import { projectRouter } from './modules/projects/projects.routes';
import { baselineRouter } from './modules/baselines/baselines.routes';
import { requestRouter } from './modules/requests/requests.routes';
import { analysisRouter } from './modules/analysis/analysis.routes';
import { estimatesRouter } from './modules/estimates/estimates.routes';
import { changeOrdersRouter } from './modules/changeOrders/changeOrders.routes';
import { approvalsRouter, publicApprovalsRouter } from './modules/approvals/approvals.routes';
import { uploadsRouter } from './modules/uploads/uploads.routes';
import { reportsRouter } from './modules/reports/reports.routes';
import { auditRouter } from './modules/audit/audit.routes';

/**
 * Application assembly. Deliberately ordered:
 *   security headers → CORS → parsers → request context → routes → 404 → error handler.
 * The error handler is LAST so that every upstream failure (including a rejected body parser)
 * is normalised into the same JSON error envelope.
 */
export function createApp(): Express {
  const app = express();

  // Behind a proxy/load balancer this makes req.ip and secure-cookie detection truthful.
  // Set TRUST_PROXY only when the deployment actually has a trusted proxy in front.
  if (env.isProd) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // The API serves JSON and PDFs; a restrictive document policy costs nothing here.
      contentSecurityPolicy: env.isProd ? undefined : false,
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin and server-to-server requests have no Origin header.
        if (!origin) return callback(null, true);
        if (env.corsOrigins.includes(origin)) return callback(null, true);
        return callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Request-Id', 'X-Idempotency-Key'],
      exposedHeaders: ['X-Request-Id', 'X-Document-Sha256'],
      maxAge: 600,
    }),
  );

  app.use(requestContext);
  app.use(cookieParser());
  // Bodies are small by design: documents go through multipart with their own limit.
  app.use(express.json({ limit: `${LIMITS.maxJsonKb}kb` }));
  app.use(express.urlencoded({ extended: false, limit: `${LIMITS.maxJsonKb}kb` }));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'scopeshield-api',
      time: new Date().toISOString(),
      storage: env.storageDriver,
      mail: env.mailDriver,
      aiProvider: env.aiProvider,
    });
  });

  /**
   * The client approval portal is mounted OUTSIDE the session-authenticated surface: its
   * credential is the link token itself, and it must never be reachable with org cookies.
   */
  app.use(`${API_PREFIX}/public`, publicApprovalsRouter);

  app.use(`${API_PREFIX}/auth`, authRouter);
  app.use(`${API_PREFIX}/organizations`, orgRouter);
  app.use(`${API_PREFIX}/clients`, clientRouter);
  app.use(`${API_PREFIX}/projects`, projectRouter);
  app.use(`${API_PREFIX}/projects/:projectId/baselines`, baselineRouter);
  app.use(`${API_PREFIX}/requests`, requestRouter);
  app.use(API_PREFIX, analysisRouter);
  app.use(API_PREFIX, estimatesRouter);
  app.use(API_PREFIX, changeOrdersRouter);
  app.use(`${API_PREFIX}/approvals`, approvalsRouter);
  app.use(API_PREFIX, uploadsRouter);
  app.use(API_PREFIX, reportsRouter);
  app.use(API_PREFIX, auditRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
