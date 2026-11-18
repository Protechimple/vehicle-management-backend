const jwt = require('jsonwebtoken');
const env = require('../config/env');
const AppError = require('../utils/AppError');
const { PlatformAdmin } = require('../models');

const PLATFORM_TOKEN_TYPE = 'platform';

// Accepts only Super Admin tokens. Tenant tokens carry no `typ` and are turned away here.
async function authenticatePlatform(req, _res, next) {
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

  const adminId = Number(payload.sub);
  if (payload.typ !== PLATFORM_TOKEN_TYPE || !Number.isInteger(adminId) || adminId <= 0) {
    return next(AppError.unauthorized('Invalid or expired token'));
  }

  const admin = await PlatformAdmin.findByPk(adminId);
  if (!admin || !admin.isActive) {
    return next(AppError.unauthorized('Account is no longer active'));
  }

  if (admin.sessionsRevokedAt && !(payload.iat * 1000 >= admin.sessionsRevokedAt.getTime())) {
    return next(AppError.unauthorized('Invalid or expired token'));
  }

  req.platformAuth = { adminId: admin.id, email: admin.email, name: admin.name };

  return next();
}

module.exports = { authenticatePlatform, PLATFORM_TOKEN_TYPE };
