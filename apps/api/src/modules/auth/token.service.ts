import { Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ERROR_CODES, ZycountError, type AccessTokenClaims } from "@zycount/shared";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PrismaService } from "../../common/prisma/prisma.service";
import type { ClientContext } from "../../common/guards/types";

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/**
 * Session tokens (docs/spec/06 — Sessions).
 *
 * Access tokens are short-lived JWTs. Refresh tokens are opaque, rotated on
 * every use, and stored only as SHA-256 hashes — a database leak cannot be
 * replayed into a session. Presenting an already-rotated token revokes its
 * whole family, which is how token theft surfaces.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  private hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  private accessTtlSeconds(): number {
    const raw = process.env.JWT_ACCESS_TTL ?? "15m";
    const match = /^(\d+)([smhd])$/.exec(raw);
    if (!match) return 900;
    const value = Number(match[1]);
    const unit = match[2];
    return value * ({ s: 1, m: 60, h: 3600, d: 86400 }[unit] ?? 60);
  }

  private refreshTtlMs(): number {
    const raw = process.env.JWT_REFRESH_TTL ?? "7d";
    const match = /^(\d+)([smhd])$/.exec(raw);
    if (!match) return 7 * 86_400_000;
    const value = Number(match[1]);
    const unit = match[2];
    return value * ({ s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 60_000);
  }

  signAccessToken(claims: AccessTokenClaims): string {
    return this.jwt.sign(claims, {
      secret: process.env.JWT_ACCESS_SECRET,
      expiresIn: this.accessTtlSeconds(),
    });
  }

  /** Short-lived token that carries a login through the MFA challenge only. */
  signMfaChallenge(userId: string): string {
    return this.jwt.sign(
      { sub: userId, purpose: "mfa" },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: 300 },
    );
  }

  verifyMfaChallenge(token: string): string {
    try {
      const claims = this.jwt.verify<{ sub: string; purpose: string }>(token, {
        secret: process.env.JWT_ACCESS_SECRET,
      });
      if (claims.purpose !== "mfa") throw new Error("wrong purpose");
      return claims.sub;
    } catch {
      throw new ZycountError(
        ERROR_CODES.AUTH_TOKEN_INVALID,
        "That verification step has expired. Sign in again.",
      );
    }
  }

  async issueRefreshToken(
    userId: string,
    client: ClientContext,
    family?: string,
  ): Promise<string> {
    const token = randomBytes(48).toString("base64url");

    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: this.hash(token),
        family: family ?? randomUUID(),
        userAgent: client.userAgent,
        ipAddress: client.ipAddress,
        expiresAt: new Date(Date.now() + this.refreshTtlMs()),
      },
    });

    return token;
  }

  /**
   * Exchange a refresh token for a new pair. Reuse of an already-rotated token
   * means the token leaked, so the entire family is revoked immediately.
   */
  async rotateRefreshToken(
    rawToken: string,
    client: ClientContext,
  ): Promise<{ userId: string; refreshToken: string }> {
    const tokenHash = this.hash(rawToken);
    const existing = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });

    if (!existing) {
      throw new ZycountError(
        ERROR_CODES.AUTH_TOKEN_INVALID,
        "Your session has ended. Sign in again to continue.",
      );
    }

    if (!existing.revokedAt && existing.expiresAt.getTime() <= Date.now()) {
      throw new ZycountError(
        ERROR_CODES.AUTH_TOKEN_EXPIRED,
        "Your session has expired. Sign in again to continue.",
      );
    }

    // Claim the token atomically before issuing its successor. Of two requests
    // racing with the same token only one can flip revokedAt from null; the
    // other is treated exactly like a replay, so a stolen token used in
    // parallel with the real one still ends the family.
    const claimed = existing.revokedAt
      ? { count: 0 }
      : await this.prisma.refreshToken.updateMany({
          where: { id: existing.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });

    if (claimed.count === 0) {
      await this.revokeFamily(existing.family);
      throw new ZycountError(
        ERROR_CODES.AUTH_REFRESH_REUSED,
        "For your security we ended every session on this account. Sign in again.",
      );
    }

    const refreshToken = await this.issueRefreshToken(existing.userId, client, existing.family);

    return { userId: existing.userId, refreshToken };
  }

  async revoke(rawToken: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: this.hash(rawToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeFamily(family: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { family, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  get refreshCookieOptions() {
    const isProduction = process.env.NODE_ENV === "production";
    return {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax" as const,
      path: "/api/auth",
      maxAge: this.refreshTtlMs(),
    };
  }

  get accessTokenTtl(): number {
    return this.accessTtlSeconds();
  }
}
