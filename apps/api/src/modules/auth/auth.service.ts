import { Injectable } from "@nestjs/common";
import { hash, verify } from "@node-rs/argon2";
import {
  ERROR_CODES,
  ZycountError,
  type AuthUser,
  type ChangePasswordInput,
  type LoginInput,
  type LoginResponse,
  type MfaVerifyInput,
} from "@zycount/shared";
import { authenticator } from "otplib";
import { randomBytes } from "node:crypto";
import { AuditService } from "../../common/audit/audit.service";
import type { ClientContext } from "../../common/guards/types";
import { PrismaService } from "../../common/prisma/prisma.service";
import { TokenService } from "./token.service";

/** Argon2id parameters (docs/spec/06 — Password hashing). */
const ARGON_OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

/** Lock an account after repeated failures, to blunt credential stuffing. */
const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MINUTES = 15;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  // ── Login ──────────────────────────────────────────────────

  async login(
    input: LoginInput,
    client: ClientContext,
  ): Promise<{ response: LoginResponse; refreshToken?: string }> {
    const user = await this.prisma.user.findUnique({
      where: { email: input.email },
      include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } },
    });

    // Always spend comparable time whether or not the account exists, so the
    // response time cannot be used to enumerate registered addresses.
    if (!user) {
      await verify(
        "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2E$8Q0yxXvLnRBxN5b7tKLpkVQF0rR1z8lQ9HcOZpJ3fVo",
        input.password,
        ARGON_OPTIONS,
      ).catch(() => false);

      await this.recordLogin(null, input.email, false, "unknown_email", client);
      throw new ZycountError(
        ERROR_CODES.AUTH_INVALID_CREDENTIALS,
        "That email address or password is not correct.",
      );
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
      await this.recordLogin(user.id, input.email, false, "locked", client);
      throw new ZycountError(
        ERROR_CODES.AUTH_ACCOUNT_LOCKED,
        `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      );
    }

    const passwordValid = await verify(user.passwordHash, input.password, ARGON_OPTIONS).catch(
      () => false,
    );

    if (!passwordValid) {
      await this.registerFailedAttempt(user.id);
      await this.recordLogin(user.id, input.email, false, "bad_password", client);
      throw new ZycountError(
        ERROR_CODES.AUTH_INVALID_CREDENTIALS,
        "That email address or password is not correct.",
      );
    }

    if (!user.isActive) {
      await this.recordLogin(user.id, input.email, false, "inactive", client);
      throw new ZycountError(
        ERROR_CODES.AUTH_ACCOUNT_INACTIVE,
        "This account has been deactivated. Contact your administrator.",
      );
    }

    // MFA-enabled accounts stop here and finish at /auth/mfa/verify. Their
    // failure count is only cleared once the second factor passes, so knowing
    // the password cannot be used to reset the lockout between code guesses.
    if (user.mfaEnabled && user.mfaSecret) {
      await this.recordLogin(user.id, input.email, true, "mfa_challenge", client);
      return {
        response: { mfaRequired: true, mfaToken: this.tokens.signMfaChallenge(user.id) },
      };
    }

    await this.clearFailedAttempts(user.id);
    return this.completeLogin(user.id, client, "password");
  }

  async verifyMfa(
    input: MfaVerifyInput,
    client: ClientContext,
  ): Promise<{ response: LoginResponse; refreshToken?: string }> {
    const userId = this.tokens.verifyMfaChallenge(input.mfaToken);
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user?.mfaSecret) {
      throw new ZycountError(ERROR_CODES.AUTH_MFA_INVALID, "Two-factor sign-in is not set up on this account.");
    }

    // Wrong codes count towards the same lockout as wrong passwords.
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
      await this.recordLogin(user.id, user.email, false, "locked", client);
      throw new ZycountError(
        ERROR_CODES.AUTH_ACCOUNT_LOCKED,
        `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      );
    }

    const code = input.code.trim();
    const isTotp = /^\d{6}$/.test(code);

    if (isTotp) {
      if (!authenticator.verify({ token: code, secret: user.mfaSecret })) {
        await this.registerFailedAttempt(user.id);
        await this.recordLogin(user.id, user.email, false, "bad_totp", client);
        throw new ZycountError(ERROR_CODES.AUTH_MFA_INVALID, "That code is not correct or has expired.");
      }
    } else {
      // Recovery codes are single-use: the matching hash is dropped on success.
      const index = await this.findRecoveryCode(user.mfaRecoveryCodes, code);
      if (index === -1) {
        await this.registerFailedAttempt(user.id);
        await this.recordLogin(user.id, user.email, false, "bad_recovery_code", client);
        throw new ZycountError(ERROR_CODES.AUTH_MFA_INVALID, "That recovery code is not valid.");
      }

      // Conditional on the list being unchanged since it was read, so the same
      // code presented twice at once is spent by exactly one of the requests.
      const remaining = user.mfaRecoveryCodes.filter((_, i) => i !== index);
      const spent = await this.prisma.user.updateMany({
        where: { id: user.id, mfaRecoveryCodes: { equals: user.mfaRecoveryCodes } },
        data: { mfaRecoveryCodes: remaining },
      });
      if (spent.count === 0) {
        await this.recordLogin(user.id, user.email, false, "recovery_code_race", client);
        throw new ZycountError(ERROR_CODES.AUTH_MFA_INVALID, "That recovery code is not valid.");
      }

      await this.audit.record({
        userId: user.id,
        action: "auth.recovery_code_used",
        entityType: "User",
        entityId: user.id,
        metadata: { remaining: remaining.length },
        client,
      });
    }

    await this.clearFailedAttempts(user.id);
    return this.completeLogin(user.id, client, isTotp ? "mfa_totp" : "mfa_recovery");
  }

  private async findRecoveryCode(hashes: string[], code: string): Promise<number> {
    for (let index = 0; index < hashes.length; index += 1) {
      const match = await verify(hashes[index], code.toUpperCase(), ARGON_OPTIONS).catch(() => false);
      if (match) return index;
    }
    return -1;
  }

  private async completeLogin(
    userId: string,
    client: ClientContext,
    method: string,
  ): Promise<{ response: LoginResponse; refreshToken: string }> {
    const authUser = await this.buildAuthUser(userId);

    const accessToken = this.tokens.signAccessToken({
      sub: authUser.id,
      email: authUser.email,
      organizationId: authUser.organizationId,
      roles: authUser.roles,
      permissions: authUser.permissions,
      companies: authUser.companies.map((company) => company.id),
    });

    const refreshToken = await this.tokens.issueRefreshToken(userId, client);

    await this.prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
    await this.recordLogin(userId, authUser.email, true, method, client);
    await this.audit.record({
      userId,
      action: "auth.login",
      entityType: "User",
      entityId: userId,
      metadata: { method },
      client,
    });

    return {
      response: { accessToken, expiresIn: this.tokens.accessTokenTtl, user: authUser },
      refreshToken,
    };
  }

  /**
   * Counts a failed password or second-factor attempt. The increment happens
   * in the database so parallel guesses cannot each read the same count and
   * slip under the lockout threshold.
   */
  private async registerFailedAttempt(userId: string): Promise<void> {
    const { failedLoginCount } = await this.prisma.user.update({
      where: { id: userId },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });
    if (failedLoginCount >= MAX_FAILED_LOGINS) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { lockedUntil: new Date(Date.now() + LOCKOUT_MINUTES * 60_000) },
      });
    }
  }

  private async clearFailedAttempts(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { failedLoginCount: 0, lockedUntil: null },
    });
  }

  private async recordLogin(
    userId: string | null,
    email: string,
    success: boolean,
    reason: string,
    client: ClientContext,
  ): Promise<void> {
    await this.prisma.loginHistory.create({
      data: {
        userId,
        email,
        success,
        reason,
        ipAddress: client.ipAddress,
        userAgent: client.userAgent,
      },
    });
  }

  // ── Session lifecycle ──────────────────────────────────────

  async refresh(
    rawToken: string | undefined,
    client: ClientContext,
  ): Promise<{ response: LoginResponse; refreshToken: string }> {
    if (!rawToken) {
      throw new ZycountError(
        ERROR_CODES.AUTH_UNAUTHENTICATED,
        "Your session has ended. Sign in again to continue.",
      );
    }

    const { userId, refreshToken } = await this.tokens.rotateRefreshToken(rawToken, client);
    const authUser = await this.buildAuthUser(userId);

    const accessToken = this.tokens.signAccessToken({
      sub: authUser.id,
      email: authUser.email,
      organizationId: authUser.organizationId,
      roles: authUser.roles,
      permissions: authUser.permissions,
      companies: authUser.companies.map((company) => company.id),
    });

    return {
      response: { accessToken, expiresIn: this.tokens.accessTokenTtl, user: authUser },
      refreshToken,
    };
  }

  async logout(rawToken: string | undefined, userId: string | null, client: ClientContext): Promise<void> {
    if (rawToken) await this.tokens.revoke(rawToken);
    if (userId) {
      await this.audit.record({
        userId,
        action: "auth.logout",
        entityType: "User",
        entityId: userId,
        client,
      });
    }
  }

  async me(userId: string): Promise<AuthUser> {
    return this.buildAuthUser(userId);
  }

  /** The single place the caller's effective permissions are computed. */
  async buildAuthUser(userId: string): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
        companies: { include: { company: true }, orderBy: { company: { name: "asc" } } },
      },
    });

    if (!user || !user.isActive) {
      throw new ZycountError(
        ERROR_CODES.AUTH_ACCOUNT_INACTIVE,
        "This account is no longer active.",
      );
    }

    const permissions = new Set<string>();
    for (const userRole of user.roles) {
      for (const rolePermission of userRole.role.permissions) {
        permissions.add(rolePermission.permission.code);
      }
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      mfaEnabled: user.mfaEnabled,
      organizationId: user.organizationId,
      roles: user.roles.map((userRole) => userRole.role.name),
      permissions: [...permissions].sort(),
      companies: user.companies.map((link) => ({
        id: link.company.id,
        name: link.company.name,
        baseCurrency: link.company.baseCurrency,
        isDefault: link.isDefault,
      })),
    };
  }

  // ── Credentials & MFA enrolment ────────────────────────────

  async changePassword(
    userId: string,
    input: ChangePasswordInput,
    client: ClientContext,
  ): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const valid = await verify(user.passwordHash, input.currentPassword, ARGON_OPTIONS).catch(
      () => false,
    );

    if (!valid) {
      throw new ZycountError(
        ERROR_CODES.AUTH_INVALID_CREDENTIALS,
        "Your current password is not correct.",
        { fields: { currentPassword: "That password is not correct." } },
      );
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await hash(input.newPassword, ARGON_OPTIONS) },
    });

    // A password change ends every other session on the account.
    await this.tokens.revokeAllForUser(userId);
    await this.audit.record({
      userId,
      action: "auth.password_changed",
      entityType: "User",
      entityId: userId,
      client,
    });
  }

  async beginMfaEnrolment(userId: string): Promise<{ secret: string; otpauthUrl: string }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const secret = authenticator.generateSecret();

    // Held unconfirmed until a valid code proves the authenticator works.
    await this.prisma.user.update({ where: { id: userId }, data: { mfaSecret: secret } });

    return {
      secret,
      otpauthUrl: authenticator.keyuri(user.email, "Zycount", secret),
    };
  }

  async confirmMfaEnrolment(
    userId: string,
    code: string,
    client: ClientContext,
  ): Promise<{ recoveryCodes: string[] }> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    if (!user.mfaSecret) {
      throw new ZycountError(
        ERROR_CODES.AUTH_MFA_INVALID,
        "Start the two-factor setup again — no pending enrolment was found.",
      );
    }

    if (!authenticator.verify({ token: code, secret: user.mfaSecret })) {
      throw new ZycountError(ERROR_CODES.AUTH_MFA_INVALID, "That code is not correct. Try the next one.");
    }

    // Shown once, stored only as hashes.
    const recoveryCodes = Array.from({ length: 10 }, () =>
      randomBytes(5).toString("hex").toUpperCase(),
    );
    const hashed = await Promise.all(recoveryCodes.map((value) => hash(value, ARGON_OPTIONS)));

    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaEnabled: true, mfaRecoveryCodes: hashed },
    });

    await this.audit.record({
      userId,
      action: "auth.mfa_enabled",
      entityType: "User",
      entityId: userId,
      client,
    });

    return { recoveryCodes };
  }

  async disableMfa(userId: string, password: string, client: ClientContext): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const valid = await verify(user.passwordHash, password, ARGON_OPTIONS).catch(() => false);

    if (!valid) {
      throw new ZycountError(
        ERROR_CODES.AUTH_INVALID_CREDENTIALS,
        "Your password is not correct.",
        { fields: { password: "That password is not correct." } },
      );
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaEnabled: false, mfaSecret: null, mfaRecoveryCodes: [] },
    });

    await this.audit.record({
      userId,
      action: "auth.mfa_disabled",
      entityType: "User",
      entityId: userId,
      client,
    });
  }

  async listSessions(userId: string) {
    const sessions = await this.prisma.refreshToken.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
      select: { id: true, userAgent: true, ipAddress: true, createdAt: true, expiresAt: true },
    });
    return sessions;
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async loginHistory(userId: string, limit = 20) {
    return this.prisma.loginHistory.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, success: true, reason: true, ipAddress: true, userAgent: true, createdAt: true },
    });
  }
}
