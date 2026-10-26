import type { PlatformRole } from '../db/schema.js';

export interface AuthContext {
  sessionId: string;
  user: {
    id: string;
    name: string;
    email: string;
    phone: string | null;
    platformRole: PlatformRole;
  };
}

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      auth?: AuthContext;
    }
  }
}
