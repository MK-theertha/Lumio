import { Router, type RequestHandler } from 'express';
import { sendSuccess } from '../../shared/http.js';
import { evaluateReadiness, type HealthCheck } from './health.service.js';

export function createHealthRouter(checks: Record<string, HealthCheck>): Router {
  const router = Router();

  router.get('/live', (req, res) => {
    sendSuccess(req, res, { status: 'up' });
  });

  const readiness: RequestHandler = async (req, res) => {
    const report = await evaluateReadiness(checks);
    sendSuccess(req, res, report, report.status === 'up' ? 200 : 503);
  };

  router.get('/ready', readiness);
  router.get('/startup', readiness);
  return router;
}
