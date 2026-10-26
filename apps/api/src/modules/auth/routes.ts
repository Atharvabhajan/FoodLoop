import { Router, type CookieOptions, type NextFunction, type RequestHandler, type Request, type Response } from 'express';
import type { Config } from '../../config.js';
import { AppError, errors } from '../../http/errors.js';
import { ok, parseBody } from '../../http/respond.js';
import { accountUpdateSchema, loginSchema, registerSchema } from './schemas.js';
import type { AuthService, SessionTokens } from './service.js';
import { verifyAccessToken } from './tokens.js';

export const ACCESS_COOKIE = 'fl_access';
export const REFRESH_COOKIE = 'fl_refresh';
const REFRESH_PATH = '/api/v1/auth';

export function createAuthenticate(service: AuthService, config: Config) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const token = req.cookies?.[ACCESS_COOKIE];
    if (typeof token !== 'string') return next(errors.unauthenticated());
    const claims = verifyAccessToken(token, config.JWT_ACCESS_SECRET);
    if (!claims) return next(new AppError(401, 'TOKEN_EXPIRED', 'Your session has expired. Sign in again.'));
    // Checked against the database on every request so logout / suspension take effect immediately.
    const live = await service.findLiveSession(claims.sid, claims.sub);
    if (!live) return next(new AppError(401, 'SESSION_REVOKED', 'Your session is no longer valid. Sign in again.'));
    req.auth = {
      sessionId: live.sessionId,
      user: {
        id: live.id,
        name: live.name,
        email: live.email,
        phone: live.phone,
        platformRole: live.platformRole,
      },
    };
    next();
  };
}

export function createAuthRouter(service: AuthService, config: Config, authenticate: ReturnType<typeof createAuthenticate>, limiter: RequestHandler) {
  const router = Router();

  const base: CookieOptions = {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'lax',
  };
  const setCookies = (res: Response, t: SessionTokens) => {
    res.cookie(ACCESS_COOKIE, t.accessToken, { ...base, path: '/', maxAge: config.ACCESS_TOKEN_TTL_MINUTES * 60_000 });
    res.cookie(REFRESH_COOKIE, t.refreshToken, {
      ...base,
      path: REFRESH_PATH,
      maxAge: config.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
    });
  };
  const clearCookies = (res: Response) => {
    res.clearCookie(ACCESS_COOKIE, { ...base, path: '/' });
    res.clearCookie(REFRESH_COOKIE, { ...base, path: REFRESH_PATH });
  };

  router.post('/register', limiter, async (req, res) => {
    const input = parseBody(registerSchema, req.body);
    const { tokens, identity } = await service.register(input, req.get('user-agent'));
    setCookies(res, tokens);
    ok(req, res, { user: identity }, 201);
  });

  router.post('/login', limiter, async (req, res) => {
    const input = parseBody(loginSchema, req.body);
    const { tokens, identity } = await service.login(input, req.get('user-agent'));
    setCookies(res, tokens);
    ok(req, res, { user: identity });
  });

  router.post('/refresh', limiter, async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (typeof token !== 'string') throw new AppError(401, 'SESSION_EXPIRED', 'Your session has expired. Sign in again.');
    try {
      setCookies(res, await service.refresh(token, req.get('user-agent')));
    } catch (err) {
      clearCookies(res);
      throw err;
    }
    ok(req, res, { refreshed: true });
  });

  router.post('/logout', async (req, res) => {
    const refresh = req.cookies?.[REFRESH_COOKIE];
    if (typeof refresh === 'string') await service.revokeByRefreshToken(refresh);
    const access = req.cookies?.[ACCESS_COOKIE];
    if (typeof access === 'string') {
      // An expired access token still identifies the session that should be revoked.
      const claims = verifyAccessToken(access, config.JWT_ACCESS_SECRET, { ignoreExpiration: true });
      if (claims) await service.revokeSession(claims.sid);
    }
    clearCookies(res);
    ok(req, res, { loggedOut: true });
  });

  router.get('/me', authenticate, async (req, res) => {
    const identity = await service.loadIdentity(req.auth!.user.id);
    if (!identity) throw errors.unauthenticated();
    ok(req, res, { user: identity });
  });

  router.patch('/me', authenticate, async (req, res) => {
    const input = parseBody(accountUpdateSchema, req.body);
    const identity = await service.updateAccount(req.auth!.user.id, input);
    if (!identity) throw errors.unauthenticated();
    ok(req, res, { user: identity });
  });

  return router;
}
