const jwt = require('jsonwebtoken');
const env = require('../config/env');
const AppError = require('../utils/AppError');
const { User, Tenant } = require('../models');
const { loadAccess } = require('../services/access.service');

const PASSWORD_CHANGE_REQUIRED = 'PASSWORD_CHANGE_REQUIRED';

// While a temporary password is in use, only what the change-password screen needs is reachable.
const ALLOWED_DURING_PASSWORD_CHANGE = new Set([
  'PUT /api/users/me/password',
  'POST /api/auth/logout',
  'GET /api/auth/me',
  'GET /api/branding',
  'GET /api/branding/logo',
]);

function requestKey(req) {
  const path = req.originalUrl.split('?')[0].replace(/\/+$/, '');
  return `${req.method} ${path}`;
}

async function authenticate(req, _res, next) {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(AppError.unauthorized());
  }

  let payload;
  try {
    payload = jwt.verify(token, env.jwt.secret);
  } catch {
    return next(AppError.unauthorized('Invalid or expired token'));
  }

  // Super Admin tokens are for /api/platform only and never reach tenant data.
  if (payload.typ !== undefined) {
    return next(AppError.unauthorized('Invalid or expired token'));
  }

  const userId = Number(payload.sub);
  if (!Number.isInteger(userId) || userId <= 0) {
    return next(AppError.unauthorized('Invalid or expired token'));
  }

  const user = await User.findByPk(userId, {
    include: [{ model: Tenant, as: 'tenant' }],
  });

  if (!user || !user.isActive) {
    return next(AppError.unauthorized('Account is no longer active'));
  }

  if (!user.tenant || !user.tenant.isActive) {
    return next(AppError.unauthorized('Organization is no longer active'));
  }

  if (user.sessionsRevokedAt && !(payload.iat * 1000 >= user.sessionsRevokedAt.getTime())) {
    return next(AppError.unauthorized('Invalid or expired token'));
  }

  // Worked out on every request, so a change the Admin makes to someone's sites or access applies at once.
  const { siteIds, permissions } = await loadAccess(user);

  req.auth = {
    userId: user.id,
    tenantId: user.tenantId,
    role: user.role,
    // siteId is the one site of a single-site user. siteIds is every site the user covers; null for the Admin.
    siteId: siteIds && siteIds.length === 1 ? siteIds[0] : null,
    siteIds,
    permissions,
    managerId: user.managerId ?? null,
    email: user.email,
    name: user.name,
    organizationName: user.tenant.organizationName,
    mustChangePassword: Boolean(user.mustChangePassword),
  };

  if (req.auth.mustChangePassword && !ALLOWED_DURING_PASSWORD_CHANGE.has(requestKey(req))) {
    return next(AppError.forbidden('Change your temporary password to continue', PASSWORD_CHANGE_REQUIRED));
  }

  return next();
}

module.exports = authenticate;
