const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Op, fn, col } = require('sequelize');

const env = require('../config/env');
const { ROLES } = require('../config/permissions');
const { sequelize, PlatformAdmin, Tenant, User, Site, Vehicle, Machinery, PasswordResetToken } = require('../models');
const { PLATFORM_TOKEN_TYPE } = require('../middleware/authenticatePlatform');
const AppError = require('../utils/AppError');
const { requirePassword } = require('../utils/validation');
const { parseListQuery, parseEnumFilter, containsPattern } = require('../utils/queryOptions');
const { buildListResponse } = require('../utils/listResponse');
const { recordAudit } = require('./audit.service');
const { createTenantWithAdmin, readOrganizationInput, platformActor } = require('./tenant.service');
const { tenantActivitySummary, lastActivityByTenant, lastPasswordChangeByUser } = require('./platformActivity.service');
const { tokenOptionsAfterRevoke } = require('./auth.service');

const INVALID_CREDENTIALS = 'Invalid email or password';
const ABSENT_ACCOUNT_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), env.bcryptSaltRounds);

const TENANT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SETTABLE_TENANT_STATUSES = ['active', 'suspended'];
const SORTABLE_FIELDS = ['organizationName', 'createdAt', 'status'];
const DEFAULT_SORT = 'createdAt:desc';

function issuePlatformToken(admin, { issuedAt } = {}) {
  const payload = { sub: String(admin.id), typ: PLATFORM_TOKEN_TYPE };
  if (issuedAt) payload.iat = issuedAt;
  return jwt.sign(payload, env.jwt.secret, { expiresIn: env.jwt.expiresIn });
}

function buildPlatformSession(admin, tokenOptions) {
  return { token: issuePlatformToken(admin, tokenOptions), user: admin.toPublicJSON() };
}

async function logIn({ email, password }) {
  const cleanEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const suppliedPassword = typeof password === 'string' ? password : '';

  if (!cleanEmail || !suppliedPassword) {
    throw AppError.badRequest('Email and password are required');
  }

  const admin = await PlatformAdmin.scope('withPassword').findOne({ where: { email: cleanEmail } });
  const passwordMatches = await bcrypt.compare(suppliedPassword, admin?.passwordHash ?? ABSENT_ACCOUNT_HASH);

  if (!admin || !passwordMatches) throw AppError.unauthorized(INVALID_CREDENTIALS);
  if (!admin.isActive) throw AppError.forbidden('This account has been deactivated');

  await admin.update({ lastLoginAt: new Date() });

  const safeAdmin = await PlatformAdmin.findByPk(admin.id);
  return buildPlatformSession(safeAdmin, tokenOptionsAfterRevoke(admin.sessionsRevokedAt));
}

async function changeOwnPassword({ adminId, currentPassword, newPassword }) {
  const suppliedPassword = typeof currentPassword === 'string' ? currentPassword : '';
  if (!suppliedPassword) throw AppError.badRequest('Current password is required');
  const cleanPassword = requirePassword(newPassword);

  const admin = await PlatformAdmin.scope('withPassword').findByPk(adminId);
  if (!admin) throw AppError.notFound('Account not found');

  if (!(await bcrypt.compare(suppliedPassword, admin.passwordHash))) {
    throw AppError.badRequest('Current password is incorrect');
  }
  if (cleanPassword === suppliedPassword) {
    throw AppError.badRequest('New password must be different from your current password');
  }

  const revokedAt = new Date();
  await admin.update({
    passwordHash: await bcrypt.hash(cleanPassword, env.bcryptSaltRounds),
    sessionsRevokedAt: revokedAt,
  });

  const safeAdmin = await PlatformAdmin.findByPk(admin.id);
  return buildPlatformSession(safeAdmin, { issuedAt: Math.ceil(revokedAt.getTime() / 1000) });
}

function requireTenantId(value) {
  if (typeof value !== 'string' || !TENANT_ID_PATTERN.test(value)) {
    throw AppError.notFound('Organization not found');
  }
  return value;
}

async function findTenant(tenantId, { transaction, lock } = {}) {
  const tenant = await Tenant.findByPk(requireTenantId(tenantId), { transaction, lock });
  if (!tenant) throw AppError.notFound('Organization not found');
  return tenant;
}

async function countActiveByTenant(model, tenantIds) {
  const rows = await model.findAll({
    attributes: ['tenantId', [fn('COUNT', col('id')), 'count']],
    where: { tenantId: tenantIds, status: 'active' },
    group: ['tenantId'],
    raw: true,
  });
  return new Map(rows.map((row) => [row.tenantId, Number(row.count)]));
}

// One grouped query per table for the whole page, rather than one per organization.
async function loadTenantExtras(tenantIds) {
  if (tenantIds.length === 0) return { counts: {}, admins: new Map(), lastActivity: new Map(), passwordChanges: new Map() };

  const [users, sites, vehicles, machinery, admins, lastActivity] = await Promise.all([
    countActiveByTenant(User, tenantIds),
    countActiveByTenant(Site, tenantIds),
    countActiveByTenant(Vehicle, tenantIds),
    countActiveByTenant(Machinery, tenantIds),
    User.findAll({ where: { tenantId: tenantIds, role: ROLES.ADMIN } }),
    lastActivityByTenant(tenantIds),
  ]);

  return {
    counts: { users, sites, vehicles, machinery },
    admins: new Map(admins.map((admin) => [admin.tenantId, admin])),
    lastActivity,
    passwordChanges: await lastPasswordChangeByUser(admins),
  };
}

function toPublicTenant(tenant, { counts, admins, lastActivity, passwordChanges }) {
  const admin = admins.get(tenant.tenantId);
  const countFor = (name) => counts[name]?.get(tenant.tenantId) ?? 0;

  return {
    tenantId: tenant.tenantId,
    organizationName: tenant.organizationName,
    email: tenant.email,
    phone: tenant.phone,
    address: tenant.address,
    status: tenant.status,
    createdAt: tenant.createdAt,
    updatedAt: tenant.updatedAt,
    lastActivityAt: lastActivity.get(tenant.tenantId) ?? null,
    admin: admin
      ? {
          id: admin.id,
          name: admin.name,
          email: admin.email,
          status: admin.status,
          lastLoginAt: admin.lastLoginAt,
          mustChangePassword: Boolean(admin.mustChangePassword),
          lastPasswordChange: passwordChanges.get(admin.id) ?? null,
        }
      : null,
    counts: {
      users: countFor('users'),
      sites: countFor('sites'),
      vehicles: countFor('vehicles'),
      machinery: countFor('machinery'),
    },
  };
}

async function describeTenant(tenant) {
  return toPublicTenant(tenant, await loadTenantExtras([tenant.tenantId]));
}

async function listTenants({ query }) {
  const { page, limit, offset, order } = parseListQuery(query, {
    sortableFields: SORTABLE_FIELDS,
    defaultSort: DEFAULT_SORT,
  });

  const where = {};
  const status = parseEnumFilter(query.status, Tenant.STATUSES, 'Status');
  if (status) where.status = status;

  const search = typeof query.search === 'string' ? query.search.trim() : '';
  if (search) {
    const pattern = containsPattern(search);
    where[Op.or] = [
      { organizationName: { [Op.like]: pattern } },
      { email: { [Op.like]: pattern } },
      { tenantId: { [Op.like]: pattern } },
    ];
  }

  const { rows, count } = await Tenant.findAndCountAll({ where, order, limit, offset });
  const extras = await loadTenantExtras(rows.map((tenant) => tenant.tenantId));

  return buildListResponse(
    rows.map((tenant) => toPublicTenant(tenant, extras)),
    { page, limit, total: count }
  );
}

async function getTenant({ tenantId }) {
  const tenant = await findTenant(tenantId);
  const [described, activity] = await Promise.all([describeTenant(tenant), tenantActivitySummary(tenant.tenantId)]);
  return { ...described, activity };
}

async function createTenant({ platformAdmin, payload }) {
  const tenantId = await createTenantWithAdmin({
    organization: payload,
    admin: payload?.admin,
    platformAdmin,
  });
  return getTenant({ tenantId });
}

async function updateTenant({ platformAdmin, tenantId, payload }) {
  const input = readOrganizationInput(payload);

  await sequelize.transaction(async (transaction) => {
    const tenant = await findTenant(tenantId, { transaction, lock: transaction.LOCK.UPDATE });

    const after = Object.fromEntries(Object.entries(input).filter(([field, value]) => tenant[field] !== value));
    if (Object.keys(after).length === 0) return;
    const before = Object.fromEntries(Object.keys(after).map((field) => [field, tenant[field]]));

    await tenant.update(after, { transaction });
    await recordAudit(
      {
        tenantId: tenant.tenantId,
        entityType: 'Tenant',
        entityId: tenant.tenantId,
        action: 'ORGANIZATION_UPDATED',
        before,
        after: { ...after, ...platformActor(platformAdmin) },
      },
      { transaction }
    );
  });

  return getTenant({ tenantId });
}

async function setTenantStatus({ platformAdmin, tenantId, status }) {
  const nextStatus = parseEnumFilter(status, SETTABLE_TENANT_STATUSES, 'Status');
  if (!nextStatus) throw AppError.badRequest('Status is required');

  await sequelize.transaction(async (transaction) => {
    const tenant = await findTenant(tenantId, { transaction, lock: transaction.LOCK.UPDATE });
    if (tenant.status === nextStatus) return;

    const before = { status: tenant.status };
    await tenant.update({ status: nextStatus }, { transaction });
    await recordAudit(
      {
        tenantId: tenant.tenantId,
        entityType: 'Tenant',
        entityId: tenant.tenantId,
        action: nextStatus === 'active' ? 'ORGANIZATION_ACTIVATED' : 'ORGANIZATION_SUSPENDED',
        before,
        after: { status: nextStatus, ...platformActor(platformAdmin) },
      },
      { transaction }
    );
  });

  return getTenant({ tenantId });
}

// Gives the organization's admin a new temporary password and signs them out everywhere.
async function resetAdminPassword({ platformAdmin, tenantId, password }) {
  const temporaryPassword = requirePassword(password);
  const passwordHash = await bcrypt.hash(temporaryPassword, env.bcryptSaltRounds);

  await sequelize.transaction(async (transaction) => {
    const tenant = await findTenant(tenantId, { transaction });
    const admin = await User.findOne({
      where: { tenantId: tenant.tenantId, role: ROLES.ADMIN },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!admin) throw AppError.notFound('This organization has no admin account');

    await admin.update({ passwordHash, mustChangePassword: true, sessionsRevokedAt: new Date() }, { transaction });

    await PasswordResetToken.update(
      { usedAt: new Date() },
      { where: { userId: admin.id, usedAt: null }, transaction }
    );

    await recordAudit(
      {
        tenantId: tenant.tenantId,
        entityType: 'User',
        entityId: admin.id,
        action: 'ADMIN_PASSWORD_RESET',
        after: platformActor(platformAdmin),
      },
      { transaction }
    );
  });

  return getTenant({ tenantId });
}

module.exports = {
  findTenant,
  logIn,
  changeOwnPassword,
  listTenants,
  getTenant,
  createTenant,
  updateTenant,
  setTenantStatus,
  resetAdminPassword,
};
