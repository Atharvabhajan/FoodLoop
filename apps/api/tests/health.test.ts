import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import { setup, testConfig } from './helpers.js';

const ctx = setup();
afterAll(() => ctx.pool.end());

describe('GET /api/v1/health', () => {
  it('reports API and database as up', async () => {
    const res = await request(ctx.app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { api: 'up', database: 'up' } });
  });

  it('reports a database failure clearly without leaking connection details', async () => {
    const config = testConfig();
    // Port 1 is never a PostgreSQL server, so the connection is refused.
    const dead = createDb('postgres://leaky_user:leaky_secret_pw@127.0.0.1:1/nodb');
    const app = createApp({ config, db: dead.db, pool: dead.pool });
    const res = await request(app).get('/api/v1/health');
    await dead.pool.end();

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      success: false,
      code: 'DATABASE_UNAVAILABLE',
      details: { api: 'up', database: 'down' },
    });
    const raw = JSON.stringify(res.body);
    for (const secret of ['leaky_user', 'leaky_secret_pw', '127.0.0.1', 'ECONNREFUSED', 'nodb']) {
      expect(raw).not.toContain(secret);
    }
  });
});
