/**
 * API server — provides REST endpoints for the mirror service.
 *
 * Routes:
 *   POST /api/refresh — trigger a full re-mirror
 *   GET  /api/status  — current mirror state
 *   GET  /healthz     — liveness check
 */

import express from 'express';
import type { Mirror } from '../mirror.js';

export function createApi(mirror: Mirror): express.Router {
  const router = express.Router();

  // POST /api/refresh — trigger tree re-mirror (re-resolves ENS if applicable)
  router.post('/refresh', async (_req, res) => {
    try {
      const result = await mirror.refreshResolved();
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // GET /api/status — current mirror state
  router.get('/status', (_req, res) => {
    const state = mirror.getState();
    res.json({
      publicationUrl: process.env['PUBLICATION_URL'] || '',
      rootCid: state.rootCid,
      files: state.files,
      refreshedAt: state.refreshedAt,
      error: state.error,
    });
  });

  // GET /healthz — liveness
  router.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  return router;
}
