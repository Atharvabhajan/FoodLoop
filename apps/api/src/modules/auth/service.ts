import bcrypt from 'bcryptjs';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Db } from '../../db/client.js';
import {
  organizationMembers,
  organizations,
  sessions,
  users,
  volunteerProfiles,
  type PlatformRole,
} from '../../db/schema.js';
import { AppError } from '../../http/errors.js';
import { permissionsFor } from '../../http/permissions.js';
import type { AccountUpdateInput, LoginInput, RegisterInput } from './schemas.js';
import { hashRefreshToken, newRefreshToken, signAccessToken } from './tokens.js';

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
}

export interface Identity {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  platformRole: PlatformRole;
  permissions: readonly string[];
  memberships: {
    organizationId: string;
    organizationName: string;
    organizationType: 'PROVIDER' | 'NGO';
    verificationStatus: string;
    memberRole: string;
  }[];
}

const invalidCredentials = () =>
  new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');

export function createAuthService(db: Db, config: Config) {
  // Compared against when the email is unknown so response time does not reveal which emails exist.
  const dummyHash = bcrypt.hashSync('not-a-real-password', config.BCRYPT_COST);

  async function issueSession(userId: string, userAgent: string | undefined): Promise<SessionTokens> {
    const refreshToken = newRefreshToken();
    const expiresAt = new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
    const [session] = await db
      .insert(sessions)
      .values({
        userId,
        refreshTokenHash: hashRefreshToken(refreshToken),
        userAgent: userAgent?.slice(0, 255) ?? null,
        expiresAt,
      })
      .returning({ id: sessions.id });
    const accessToken = signAccessToken(
      { sub: userId, sid: session!.id },
      config.JWT_ACCESS_SECRET,
      config.ACCESS_TOKEN_TTL_MINUTES,
    );
    return { accessToken, refreshToken };
  }

  async function loadIdentity(userId: string): Promise<Identity | null> {
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) return null;
    const rows = await db
      .select({
        organizationId: organizations.id,
        organizationName: organizations.name,
        organizationType: organizations.type,
        verificationStatus: organizations.verificationStatus,
        memberRole: organizationMembers.memberRole,
      })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .where(and(eq(organizationMembers.userId, userId), eq(organizationMembers.status, 'ACTIVE')));
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      platformRole: user.platformRole,
      permissions: permissionsFor(user.platformRole),
      memberships: rows,
    };
  }

  return {
    loadIdentity,

    /** Name and phone of the signed-in user only. */
    async updateAccount(userId: string, input: AccountUpdateInput) {
      const patch: { name?: string; phone?: string | null; updatedAt: Date } = { updatedAt: new Date() };
      if (input.name !== undefined) patch.name = input.name;
      if (input.phone !== undefined) patch.phone = input.phone;
      await db.update(users).set(patch).where(eq(users.id, userId));
      return loadIdentity(userId);
    },

    async register(input: RegisterInput, userAgent: string | undefined) {
      const passwordHash = await bcrypt.hash(input.password, config.BCRYPT_COST);
      try {
        const userId = await db.transaction(async (tx) => {
          const [user] = await tx
            .insert(users)
            .values({
              name: input.name,
              email: input.email,
              phone: input.phone ?? null,
              passwordHash,
              platformRole: input.role,
            })
            .returning({ id: users.id });
          const id = user!.id;
          if (input.role === 'provider' || input.role === 'ngo') {
            const [org] = await tx
              .insert(organizations)
              .values({
                type: input.role === 'provider' ? 'PROVIDER' : 'NGO',
                name: input.organizationName!,
              })
              .returning({ id: organizations.id });
            await tx
              .insert(organizationMembers)
              .values({ userId: id, organizationId: org!.id, memberRole: 'owner' });
          } else if (input.role === 'runner') {
            await tx.insert(volunteerProfiles).values({ userId: id });
          }
          return id;
        });
        const tokens = await issueSession(userId, userAgent);
        return { tokens, identity: (await loadIdentity(userId))! };
      } catch (err) {
        // Drizzle wraps driver errors; the Postgres SQLSTATE lives on `cause`.
        const pgCode = (err as { code?: string; cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code;
        if (pgCode === '23505') {
          throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists.', {
            fields: { email: 'An account with this email already exists.' },
          });
        }
        throw err;
      }
    },

    async login(input: LoginInput, userAgent: string | undefined) {
      const [user] = await db
        .select()
        .from(users)
        .where(sql`lower(${users.email}) = ${input.email}`)
        .limit(1);
      const matches = await bcrypt.compare(input.password, user?.passwordHash ?? dummyHash);
      if (!user || !matches) throw invalidCredentials();
      if (user.status !== 'ACTIVE') {
        throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is not active. Contact support.');
      }
      const tokens = await issueSession(user.id, userAgent);
      return { tokens, identity: (await loadIdentity(user.id))! };
    },

    /** Rotates the refresh token and issues a new access token. */
    async refresh(refreshToken: string, userAgent: string | undefined): Promise<SessionTokens> {
      const [session] = await db
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.refreshTokenHash, hashRefreshToken(refreshToken)),
            isNull(sessions.revokedAt),
            gt(sessions.expiresAt, new Date()),
          ),
        )
        .limit(1);
      if (!session) throw new AppError(401, 'SESSION_EXPIRED', 'Your session has expired. Sign in again.');
      const [user] = await db.select({ status: users.status }).from(users).where(eq(users.id, session.userId));
      if (!user || user.status !== 'ACTIVE') {
        await this.revokeSession(session.id);
        throw new AppError(401, 'SESSION_EXPIRED', 'Your session has expired. Sign in again.');
      }
      const nextRefresh = newRefreshToken();
      // Compare-and-swap on the old hash so a replayed token cannot mint two live sessions.
      const rotated = await db
        .update(sessions)
        .set({ refreshTokenHash: hashRefreshToken(nextRefresh), userAgent: userAgent?.slice(0, 255) ?? null })
        .where(and(eq(sessions.id, session.id), eq(sessions.refreshTokenHash, session.refreshTokenHash)))
        .returning({ id: sessions.id });
      if (rotated.length === 0) {
        throw new AppError(401, 'SESSION_EXPIRED', 'Your session has expired. Sign in again.');
      }
      return {
        accessToken: signAccessToken(
          { sub: session.userId, sid: session.id },
          config.JWT_ACCESS_SECRET,
          config.ACCESS_TOKEN_TTL_MINUTES,
        ),
        refreshToken: nextRefresh,
      };
    },

    async revokeSession(sessionId: string) {
      await db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
    },

    async revokeByRefreshToken(refreshToken: string) {
      await db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.refreshTokenHash, hashRefreshToken(refreshToken)), isNull(sessions.revokedAt)));
    },

    /** Resolves an access-token claim pair to a live, non-revoked session for an active user. */
    async findLiveSession(sessionId: string, userId: string) {
      const [row] = await db
        .select({
          sessionId: sessions.id,
          id: users.id,
          name: users.name,
          email: users.email,
          phone: users.phone,
          platformRole: users.platformRole,
        })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(
          and(
            eq(sessions.id, sessionId),
            eq(sessions.userId, userId),
            isNull(sessions.revokedAt),
            gt(sessions.expiresAt, new Date()),
            eq(users.status, 'ACTIVE'),
          ),
        )
        .limit(1);
      return row ?? null;
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
