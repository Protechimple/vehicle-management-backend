const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const env = require('../config/env');
const { sequelize, Tenant, User, PasswordResetToken } = require('../models');
const AppError = require('../utils/AppError');
const { requireText, requireEmail, requirePassword } = require('../utils/validation');
const { recordAudit } = require('./audit.service');
const { loadAccess, publicAccess } = require('./access.service');

const INVALID_CREDENTIALS = 'Invalid email or password';

const ABSENT_ACCOUNT_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), env.bcryptSaltRounds);

function issueToken(user, { issuedAt } = {}) {
  const payload = issuedAt ? { sub: String(user.id), iat: issuedAt } : { sub: String(user.id) };
  return jwt.sign(payload, env.jwt.secret, {
    expiresIn: env.jwt.expiresIn,
  });
}

// Tokens carry their issue time in whole seconds, but a revoke is stored to the millisecond. A sign-in in the same
// second as a revoke would look older than it and be refused, so its issue time is rounded up past the revoke.
function tokenOptionsAfterRevoke(revokedAt, now = Date.now()) {
  if (!revokedAt) return undefined;
  const revokedSecond = Math.ceil(revokedAt.getTime() / 1000);
  return revokedSecond > Math.floor(now / 1000) ? { issuedAt: revokedSecond } : undefined;
}

async function buildSession(user, tenant, tokenOptions) {
  const access = publicAccess(await loadAccess(user));
  return {
    token: issueToken(user, tokenOptions),
    user: { ...user.toPublicJSON(), ...access, siteId: access.siteIds?.length === 1 ? access.siteIds[0] : null },
    organization: {
      tenantId: tenant.tenantId,
      organizationName: tenant.organizationName,
    },
  };
}

async function logIn({ email, password }) {
  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const suppliedPassword = typeof password === 'string' ? password : '';

  if (!cleanEmail || !suppliedPassword) {
    throw AppError.badRequest('Email and password are required');
  }

  const user = await User.scope('withPassword').findOne({
    where: { email: cleanEmail },
    include: [{ model: Tenant, as: 'tenant' }],
  });

  const passwordMatches = await bcrypt.compare(
    suppliedPassword,
    user?.passwordHash ?? ABSENT_ACCOUNT_HASH
  );

  if (!user || !passwordMatches) {
    throw AppError.unauthorized(INVALID_CREDENTIALS);
  }

  if (!user.isActive) {
    throw AppError.forbidden('This account has been deactivated');
  }

  if (!user.tenant?.isActive) {
    throw AppError.forbidden('This organization is not active');
  }

  await user.update({ lastLoginAt: new Date() });

  await recordAudit({
    tenantId: user.tenantId,
    entityType: 'User',
    entityId: user.id,
    action: 'LOGIN',
    performedBy: user.id,
  });

  const safeUser = await User.findByPk(user.id);
  return buildSession(safeUser, user.tenant, tokenOptionsAfterRevoke(user.sessionsRevokedAt));
}

async function logOut({ userId, tenantId }) {
  await recordAudit({
    tenantId,
    entityType: 'User',
    entityId: userId,
    action: 'LOGOUT',
    performedBy: userId,
  });
}

async function findOwnAccount(tenantId, userId) {
  const user = await User.scope('withPassword').findOne({
    where: { id: userId, tenantId },
    include: [{ model: Tenant, as: 'tenant' }],
  });
  if (!user || !user.tenant) throw AppError.notFound('Account not found');
  return user;
}

function readCurrentPassword(value, missingMessage) {
  const password = typeof value === 'string' ? value : '';
  if (!password) throw AppError.badRequest(missingMessage);
  return password;
}

async function assertCurrentPassword(user, password) {
  if (!(await bcrypt.compare(password, user.passwordHash))) {
    throw AppError.badRequest('Current password is incorrect');
  }
}

async function updateOwnProfile({ tenantId, userId, name, email, organizationName, currentPassword }) {
  const cleanName = requireText(name, 'Name', { max: 150 });
  const cleanEmail = requireEmail(email);
  const cleanOrganizationName = requireText(organizationName, 'Organization name', { max: 150 });

  const user = await findOwnAccount(tenantId, userId);
  const { tenant } = user;
  const emailChanged = cleanEmail !== user.email;

  if (emailChanged) {
    await assertCurrentPassword(
      user,
      readCurrentPassword(currentPassword, 'Enter your current password to change your email')
    );
    if (await User.findOne({ where: { email: cleanEmail } })) {
      throw AppError.conflict('An account with this email already exists');
    }
  }

  const profileBefore = { name: user.name, email: user.email };
  const profileAfter = { name: cleanName, email: cleanEmail };
  const profileChanged = cleanName !== user.name || emailChanged;

  const organizationAfter = {};
  if (cleanOrganizationName !== tenant.organizationName) organizationAfter.organizationName = cleanOrganizationName;
  if (emailChanged && tenant.email === user.email) organizationAfter.email = cleanEmail;
  const organizationBefore = Object.fromEntries(
    Object.keys(organizationAfter).map((field) => [field, tenant[field]])
  );
  const organizationChanged = Object.keys(organizationAfter).length > 0;

  if (profileChanged || organizationChanged) {
    await sequelize.transaction(async (transaction) => {
      if (profileChanged) {
        await user.update(profileAfter, { transaction });
        await recordAudit(
          {
            tenantId,
            entityType: 'User',
            entityId: user.id,
            action: 'PROFILE_UPDATED',
            before: profileBefore,
            after: profileAfter,
            performedBy: user.id,
          },
          { transaction }
        );
      }

      if (organizationChanged) {
        await tenant.update(organizationAfter, { transaction });
        await recordAudit(
          {
            tenantId,
            entityType: 'Tenant',
            entityId: tenantId,
            action: 'ORGANIZATION_UPDATED',
            before: organizationBefore,
            after: organizationAfter,
            performedBy: user.id,
          },
          { transaction }
        );
      }
    });
  }

  const safeUser = await User.findByPk(user.id);
  return {
    user: safeUser.toPublicJSON(),
    organization: { tenantId: tenant.tenantId, organizationName: tenant.organizationName },
  };
}

async function changeOwnPassword({ tenantId, userId, currentPassword, newPassword }) {
  const suppliedPassword = readCurrentPassword(currentPassword, 'Current password is required');
  const cleanPassword = requirePassword(newPassword);

  const user = await findOwnAccount(tenantId, userId);
  await assertCurrentPassword(user, suppliedPassword);

  if (cleanPassword === suppliedPassword) {
    throw AppError.badRequest('New password must be different from your current password');
  }

  const passwordHash = await bcrypt.hash(cleanPassword, env.bcryptSaltRounds);
  const revokedAt = new Date();

  await sequelize.transaction(async (transaction) => {
    await user.update({ passwordHash, sessionsRevokedAt: revokedAt, mustChangePassword: false }, { transaction });

    await PasswordResetToken.update(
      { usedAt: new Date() },
      { where: { userId: user.id, usedAt: null }, transaction }
    );

    await recordAudit(
      {
        tenantId,
        entityType: 'User',
        entityId: user.id,
        action: 'PASSWORD_CHANGED',
        performedBy: user.id,
      },
      { transaction }
    );
  });

  const safeUser = await User.findByPk(user.id);
  return buildSession(safeUser, user.tenant, { issuedAt: Math.ceil(revokedAt.getTime() / 1000) });
}

module.exports = { logIn, logOut, updateOwnProfile, changeOwnPassword, tokenOptionsAfterRevoke };
