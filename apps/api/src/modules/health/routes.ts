import { Router } from 'express';
import type { Pool } from '../../db/client.js';

const DB_CHECK_TIMEOUT_MS = 2000;

async function checkDatabase(pool: Pool): Promise<boolean> {
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), DB_CHECK_TIMEOUT_MS).unref()),
    ]);
    return true;
  } catch {
    return false;
  }
}

/** PostGIS must be enabled for matching; report it without failing the whole health check. */
async function checkSpatial(pool: Pool): Promise<boolean> {
  try {
    await pool.query('SELECT PostGIS_Version()');
    return true;
  } catch {
    return false;
  }
}

export function createHealthRouter(pool: Pool) {
  const router = Router();

  router.get('/', async (req, res) => {
    const databaseUp = await checkDatabase(pool);
    const realtimeUp = req.app.locals.realtimeUp === true;
    const spatialUp = databaseUp && (await checkSpatial(pool));
    const meta = { requestId: req.requestId };
    if (!databaseUp) {
      res.status(503).json({
        success: false,
        code: 'DATABASE_UNAVAILABLE',
        message: 'The database is not reachable.',
        details: { api: 'up', database: 'down' },
        meta,
      });
      return;
    }
    res.json({
      success: true,
      data: { api: 'up', database: 'up', spatial: spatialUp ? 'up' : 'unavailable', realtime: realtimeUp ? 'up' : 'not_started' },
      meta,
    });
  });

  return router;
}
