import type { Server as HttpServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import { createAuthService } from './modules/auth/service.js';
import { verifyAccessToken } from './modules/auth/tokens.js';

/**
 * Authenticated real-time notifications. Single-node by design: rooms live in this process, so a second API instance
 * would not deliver nudges to sockets connected to the first (the UI's REST polling still converges).
 * A socket is accepted only with a valid, non-revoked session
 * cookie, and joins exactly one room: its own user. Events carry only an id ("rescue X changed"); the
 * client re-fetches the data over the authorized REST API, so nothing about another organization can
 * travel over a socket. REST polling in the UI remains the fallback when a socket is unavailable.
 */
export const MAX_SOCKETS_PER_USER = 10;
export const ADMIN_ROOM = 'role:admin';

export function attachRealtime(server: HttpServer, db: Db, config: Config) {
  const auth = createAuthService(db, config);
  // addTrailingSlash: false matches the web app's proxy, which normalizes "/socket.io/" to "/socket.io".
  // Clients never send anything we read, so the buffer stays tiny; connect handshakes must finish quickly.
  const io = new SocketServer(server, {
    addTrailingSlash: false,
    cors: { origin: config.corsOrigins, credentials: true },
    maxHttpBufferSize: 10_000,
    connectTimeout: 10_000,
  });

  io.use(async (socket, next) => {
    try {
      const header = socket.handshake.headers.cookie ?? '';
      const token = header
        .split(';')
        .map((c) => c.trim())
        .find((c) => c.startsWith('fl_access='))
        ?.slice('fl_access='.length);
      const claims = token ? verifyAccessToken(decodeURIComponent(token), config.JWT_ACCESS_SECRET) : null;
      const live = claims ? await auth.findLiveSession(claims.sid, claims.sub) : null;
      if (!live) return next(new Error('unauthorized'));
      // One person on a few tabs and devices is normal; hundreds of sockets is not.
      if ((io.sockets.adapter.rooms.get(`user:${live.id}`)?.size ?? 0) >= MAX_SOCKETS_PER_USER) return next(new Error('too many connections'));
      socket.data.userId = live.id;
      socket.data.role = live.platformRole;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    void socket.join(`user:${socket.data.userId as string}`);
    // Admins also follow the whole platform (the operations board). The room is decided by the server-side role, never by the client.
    if (socket.data.role === 'admin') void socket.join(ADMIN_ROOM);
    socket.emit('foundation.ready', { message: 'Connected.' });
  });

  return {
    io,
    rescueChanged(userIds: string[], rescueId: string) {
      for (const u of new Set(userIds)) io.to(`user:${u}`).emit('rescue.updated', { rescueId });
      // Every rescue change also nudges admins (the board), once, even if they are already in the audience. Ids only.
      io.to(ADMIN_ROOM).except([...new Set(userIds)].map((u) => `user:${u}`)).emit('rescue.updated', { rescueId });
    },
    /** A listing was published, cancelled or otherwise changed: admins refresh the unaccepted-supply view. Id only. */
    listingChanged(listingId: string, userIds: string[] = []) {
      io.to(ADMIN_ROOM).emit('listing.updated', { listingId });
      // Users an escalation wave has just notified are nudged to refetch their notifications (the id only, nothing else).
      for (const u of new Set(userIds)) io.to(`user:${u}`).emit('listing.updated', { listingId });
    },
  };
}
