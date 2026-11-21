const { Op } = require('sequelize');
const { ROLES } = require('../config/permissions');
const AppError = require('../utils/AppError');

const NO_SITE_ASSIGNED =
  'No site has been assigned to your account yet. Ask your Admin to assign one.';

// The sites a signed-in user may work with: null for the Admin (every site), otherwise their own sites.
function allowedSiteIds(auth) {
  if (!auth || auth.role === ROLES.ADMIN) return null;
  const siteIds = Array.isArray(auth.siteIds) ? auth.siteIds : auth.siteId ? [auth.siteId] : [];
  if (siteIds.length === 0) throw AppError.forbidden(NO_SITE_ASSIGNED);
  return siteIds;
}

function isSiteRestricted(auth) {
  return allowedSiteIds(auth) !== null;
}

function includesSite(siteIds, siteId) {
  return siteId != null && siteIds.some((id) => Number(id) === Number(siteId));
}

function siteCondition(siteIds) {
  return siteIds.length === 1 ? siteIds[0] : { [Op.in]: siteIds };
}

function scopeToSite(where, auth, column = 'currentSiteId') {
  const siteIds = allowedSiteIds(auth);
  if (siteIds === null) return where;
  return { ...where, [column]: siteCondition(siteIds) };
}

function assertSiteAllowed(auth, siteId, notFoundMessage = 'Not found') {
  const siteIds = allowedSiteIds(auth);
  if (siteIds === null) return;
  if (!includesSite(siteIds, siteId)) throw AppError.notFound(notFoundMessage);
}

// An asset may be moved only to a site the user covers. A single-site user therefore cannot move it at all.
function assertSiteChangeAllowed(auth, currentSiteId, siteInput) {
  const siteIds = allowedSiteIds(auth);
  if (siteIds === null) return;
  if (!('currentSiteId' in siteInput)) return;
  if (Number(siteInput.currentSiteId) === Number(currentSiteId)) {
    delete siteInput.currentSiteId;
    return;
  }
  if (!includesSite(siteIds, siteInput.currentSiteId)) {
    throw AppError.forbidden(
      siteIds.length > 1 ? 'You can only move an asset between your own sites' : 'Only an Admin can move an asset to a different site'
    );
  }
}

function assertEitherSiteAllowed(auth, siteIdA, siteIdB, notFoundMessage = 'Not found') {
  const siteIds = allowedSiteIds(auth);
  if (siteIds === null) return;
  if (includesSite(siteIds, siteIdA) || includesSite(siteIds, siteIdB)) return;
  throw AppError.notFound(notFoundMessage);
}

// The site a new record belongs to. Null means the user may pick any site, so the caller reads it from the request.
// A user with one site always gets it. A user with several must name one of theirs.
function ownSiteFor(auth, requestedSiteId) {
  const siteIds = allowedSiteIds(auth);
  if (siteIds === null) return null;

  if (siteIds.length === 1) return Number(siteIds[0]);

  const requested = requestedSiteId === undefined || requestedSiteId === null || requestedSiteId === '' ? null : Number(requestedSiteId);
  if (requested === null) throw AppError.badRequest('Choose which of your sites this is for');
  if (!Number.isInteger(requested) || !includesSite(siteIds, requested)) {
    throw AppError.forbidden('You can only record work for your own sites');
  }
  return requested;
}

// The sites a list or report covers: the one asked for, or all the user's sites. Null means every site.
function siteFilterIds(auth, requestedSiteId) {
  const siteIds = allowedSiteIds(auth);
  const requested = requestedSiteId === undefined || requestedSiteId === null || requestedSiteId === '' ? null : Number(requestedSiteId);
  if (requested !== null && (!Number.isInteger(requested) || requested < 1)) {
    throw AppError.badRequest('Site must be a valid site');
  }
  if (siteIds === null) return requested === null ? null : [requested];
  if (requested === null) return siteIds.map(Number);
  if (!includesSite(siteIds, requested)) throw AppError.notFound('Site not found');
  return [requested];
}

// For raw SQL: " AND column IN (:siteIds)" when the report is limited to some sites, else nothing.
function siteSqlClause(siteIds, replacementName = 'siteIds') {
  return (column) => (siteIds ? ` AND ${column} IN (:${replacementName})` : '');
}

module.exports = {
  allowedSiteIds,
  isSiteRestricted,
  includesSite,
  siteCondition,
  scopeToSite,
  assertSiteAllowed,
  assertSiteChangeAllowed,
  assertEitherSiteAllowed,
  ownSiteFor,
  siteFilterIds,
  siteSqlClause,
  NO_SITE_ASSIGNED,
};
