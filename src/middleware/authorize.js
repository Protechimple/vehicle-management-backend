const AppError = require('../utils/AppError');
const { ROLES, can } = require('../config/permissions');
const authenticate = require('./authenticate');

function requireRole(...allowedRoles) {
  return (req, _res, next) => {
    if (!req.auth) return next(AppError.unauthorized());
    if (!allowedRoles.includes(req.auth.role)) return next(AppError.forbidden());
    return next();
  };
}

function requirePermission(resource, action) {
  return (req, _res, next) => {
    if (!req.auth) return next(AppError.unauthorized());
    if (!can(req.auth, resource, action)) return next(AppError.forbidden());
    return next();
  };
}

// Passes if the user may do at least one of these: [[resource, action], ...].
function requireAnyPermission(pairs) {
  return (req, _res, next) => {
    if (!req.auth) return next(AppError.unauthorized());
    if (!pairs.some(([resource, action]) => can(req.auth, resource, action))) return next(AppError.forbidden());
    return next();
  };
}

// Screens that record work against a vehicle or machine need to list the assets to pick from, even when the
// Vehicles and Machinery screens themselves are switched off for that person. The list is still limited to their sites.
const ASSET_LOOKUP = [
  ['FUEL', 'READ'],
  ['FUEL_COLLECTION', 'READ'],
  ['MAINTENANCE', 'READ'],
  ['ADBLUE', 'READ'],
  ['TYRE', 'READ'],
  ['BATTERY', 'READ'],
  ['ASSET_ISSUE', 'READ'],
  ['COMPLIANCE', 'READ'],
];

const authenticated = [authenticate];

const adminOnly = [authenticate, requireRole(ROLES.ADMIN)];

module.exports = { requireRole, requirePermission, requireAnyPermission, ASSET_LOOKUP, authenticated, adminOnly };
