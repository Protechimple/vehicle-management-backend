const { Op, fn, col, QueryTypes } = require('sequelize');

const {
  sequelize,
  Tenant,
  User,
  AuditLog,
  Vehicle,
  Machinery,
  FuelTransaction,
  Maintenance,
  Purchase,
  AssetIssue,
} = require('../models');
const { parseListQuery, parseEnumFilter } = require('../utils/queryOptions');
const { buildListResponse } = require('../utils/listResponse');

const DAY_MS = 24 * 60 * 60 * 1000;
const SUMMARY_DAYS = 30;
const OVERVIEW_DAYS = 7;
const OVERVIEW_ORGANIZATIONS_LIMIT = 10;
const QUIET_ORGANIZATIONS_LIMIT = 10;

const SIGN_IN_ACTIONS = ['LOGIN', 'LOGOUT'];
const ACTIVITY_CATEGORIES = ['signins', 'changes', 'platform'];

// Actions a Super Admin takes on an organization. The sentence already names what changed.
const PLATFORM_ACTIONS = [
  'ORGANIZATION_CREATED',
  'ORGANIZATION_UPDATED',
  'ORGANIZATION_SUSPENDED',
  'ORGANIZATION_ACTIVATED',
  'ADMIN_PASSWORD_RESET',
];

const ACTION_LABELS = {
  LOGIN: 'Signed in',
  LOGOUT: 'Signed out',
  CREATED: 'Created',
  UPDATED: 'Updated',
  ARCHIVED: 'Deleted',
  RESTORED: 'Restored',
  RECEIVED: 'Received',
  CANCELLED: 'Cancelled',
  COST_CORRECTED: 'Corrected cost',
  ORGANIZATION_CREATED: 'Created the organization',
  ORGANIZATION_UPDATED: 'Updated the organization details',
  ORGANIZATION_SUSPENDED: 'Suspended the organization',
  ORGANIZATION_ACTIVATED: 'Activated the organization',
  PROFILE_UPDATED: 'Updated own profile',
  PASSWORD_CHANGED: 'Changed own password',
  PASSWORD_RESET: 'Reset password by email link',
  ADMIN_PASSWORD_RESET: 'Reset the admin password',
  SUPERVISOR_CREATED: 'Supervisor added',
  SUPERVISOR_UPDATED: 'Supervisor updated',
  SUPERVISOR_PASSWORD_CHANGED: 'Supervisor password set',
};

const ENTITY_LABELS = { Tenant: 'Organization', User: 'User account', UnitOfMeasure: 'Unit of measure' };

// Fields, in order of preference, that name the record an entry is about.
const SUBJECT_FIELDS = [
  'assetId',
  'organizationName',
  'name',
  'itemName',
  'supplierName',
  'stationName',
  'purchaseNumber',
  'collectionNumber',
  'issueNumber',
  'reversalNumber',
  'adjustmentNumber',
  'transferNumber',
  'typeCode',
  'categoryName',
  'uomName',
  'email',
];

function humanize(code) {
  const words = String(code)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function subjectOf(log) {
  for (const snapshot of [log.after, log.before]) {
    if (!snapshot || typeof snapshot !== 'object') continue;
    const field = SUBJECT_FIELDS.find((key) => typeof snapshot[key] === 'string' && snapshot[key].trim());
    if (field) return snapshot[field];
  }
  return null;
}

function actorOf(log) {
  if (log.performer) {
    return { type: 'user', name: log.performer.name, email: log.performer.email, role: log.performer.role };
  }
  const platformAdmin = log.after?.performedByPlatformAdmin;
  if (platformAdmin) return { type: 'platform', name: 'Super Admin', email: platformAdmin.email };
  return { type: 'system', name: 'System', email: null };
}

// Updates store only the changed fields, so vehicles and machinery are named by looking up their asset ID.
const ASSET_MODELS = { Vehicle, Machinery };

async function loadAssetNames(logs) {
  const names = new Map();
  await Promise.all(
    Object.entries(ASSET_MODELS).map(async ([entityType, model]) => {
      const ids = [...new Set(logs.filter((log) => log.entityType === entityType).map((log) => Number(log.entityId)))].filter(
        Number.isInteger
      );
      if (ids.length === 0) return;
      const assets = await model.findAll({ attributes: ['id', 'assetId'], where: { id: ids } });
      for (const asset of assets) names.set(`${entityType}:${asset.id}`, asset.assetId);
    })
  );
  return names;
}

// What a Super Admin sees: who did what to which record, and when. The changed values themselves stay private.
function toActivityEntry(log, assetNames, organizationName) {
  const isSignIn = SIGN_IN_ACTIONS.includes(log.action);
  const describesItself = isSignIn || PLATFORM_ACTIONS.includes(log.action);
  const subject =
    subjectOf(log) ?? assetNames.get(`${log.entityType}:${log.entityId}`) ?? (log.entityType === 'Tenant' ? null : `#${log.entityId}`);

  return {
    id: String(log.id),
    tenantId: log.tenantId,
    ...(organizationName === undefined ? {} : { organizationName }),
    at: log.createdAt,
    action: log.action,
    actionLabel: ACTION_LABELS[log.action] ?? humanize(log.action),
    entityType: log.entityType,
    entityLabel: describesItself ? null : (ENTITY_LABELS[log.entityType] ?? humanize(log.entityType)),
    subject: describesItself ? null : subject,
    actor: actorOf(log),
  };
}

const performerInclude = { model: User, as: 'performer', attributes: ['id', 'name', 'email', 'role'] };

function since(days) {
  return new Date(Date.now() - days * DAY_MS);
}

// Audit entries newest first, for one organization or (without tenantId) all of them.
async function listActivity({ tenantId, query }) {
  const { page, limit, offset } = parseListQuery(query, { sortableFields: ['createdAt'], defaultSort: 'createdAt:desc' });
  const category = parseEnumFilter(query.category, ACTIVITY_CATEGORIES, 'Category');

  const where = {};
  if (tenantId) where.tenantId = tenantId;
  if (category === 'signins') where.action = SIGN_IN_ACTIONS;
  if (category === 'changes') where.action = { [Op.notIn]: [...SIGN_IN_ACTIONS, ...PLATFORM_ACTIONS] };
  if (category === 'platform') where.action = PLATFORM_ACTIONS;

  const include = [performerInclude];
  if (!tenantId) include.push({ model: Tenant, as: 'tenant', attributes: ['organizationName'] });

  const { rows, count } = await AuditLog.findAndCountAll({
    where,
    include,
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit,
    offset,
    distinct: true,
  });

  const assetNames = await loadAssetNames(rows);
  return buildListResponse(
    rows.map((log) => toActivityEntry(log, assetNames, tenantId ? undefined : (log.tenant?.organizationName ?? null))),
    { page, limit, total: count }
  );
}

function listTenantActivity({ tenantId, query }) {
  return listActivity({ tenantId, query });
}

async function countSince(model, tenantId, from) {
  return model.count({ where: { tenantId, createdAt: { [Op.gte]: from } } });
}

async function tenantActivitySummary(tenantId) {
  const from = since(SUMMARY_DAYS);
  const inWindow = { tenantId, createdAt: { [Op.gte]: from } };

  const [signIns, activeUsers, changes, fuelEntries, maintenanceJobs, purchases, assetIssues, lastActivity, lastSignIn] =
    await Promise.all([
      AuditLog.count({ where: { ...inWindow, action: 'LOGIN' } }),
      AuditLog.count({ where: { ...inWindow, action: 'LOGIN' }, distinct: true, col: 'performedBy' }),
      AuditLog.count({ where: { ...inWindow, action: { [Op.notIn]: SIGN_IN_ACTIONS } } }),
      countSince(FuelTransaction, tenantId, from),
      countSince(Maintenance, tenantId, from),
      countSince(Purchase, tenantId, from),
      countSince(AssetIssue, tenantId, from),
      AuditLog.max('createdAt', { where: { tenantId } }),
      AuditLog.max('createdAt', { where: { tenantId, action: 'LOGIN' } }),
    ]);

  return {
    lastActivityAt: lastActivity ?? null,
    lastSignInAt: lastSignIn ?? null,
    periodDays: SUMMARY_DAYS,
    lastPeriod: { signIns, activeUsers, changes, fuelEntries, maintenanceJobs, purchases, assetIssues },
  };
}

async function lastActivityByTenant(tenantIds) {
  if (tenantIds.length === 0) return new Map();
  const rows = await AuditLog.findAll({
    attributes: ['tenantId', [fn('MAX', col('created_at')), 'lastActivityAt']],
    where: { tenantId: tenantIds },
    group: ['tenantId'],
    raw: true,
  });
  return new Map(rows.map((row) => [row.tenantId, row.lastActivityAt]));
}

// One row per organization, most recently active first, so the Overview never mixes their data together.
function organizationBreakdown(weekStart) {
  return sequelize.query(
    `SELECT t.tenant_id AS tenantId, t.organization_name AS organizationName, t.status, t.created_at AS createdAt,
            (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.tenant_id AND u.status = 'active') AS users,
            (SELECT COUNT(*) FROM vehicles v WHERE v.tenant_id = t.tenant_id AND v.status = 'active') AS vehicles,
            (SELECT COUNT(*) FROM machinery m WHERE m.tenant_id = t.tenant_id AND m.status = 'active') AS machinery,
            (SELECT COUNT(*) FROM audit_logs a WHERE a.tenant_id = t.tenant_id AND a.action = 'LOGIN'
                AND a.created_at >= :weekStart) AS signIns,
            (SELECT COUNT(*) FROM audit_logs a WHERE a.tenant_id = t.tenant_id AND a.action NOT IN (:excluded)
                AND a.created_at >= :weekStart) AS changes,
            (SELECT MAX(a.created_at) FROM audit_logs a WHERE a.tenant_id = t.tenant_id) AS lastActivityAt
       FROM tenants t
      ORDER BY lastActivityAt IS NULL, lastActivityAt DESC
      LIMIT :limit`,
    {
      replacements: { weekStart, excluded: [...SIGN_IN_ACTIONS, ...PLATFORM_ACTIONS], limit: OVERVIEW_ORGANIZATIONS_LIMIT },
      type: QueryTypes.SELECT,
    }
  );
}

async function platformOverview() {
  const weekStart = since(OVERVIEW_DAYS);
  const quietSince = since(SUMMARY_DAYS);

  const [tenantsByStatus, users, vehicles, machinery, signIns, activeOrganizations, changes, breakdown, quiet] =
    await Promise.all([
      Tenant.findAll({ attributes: ['status', [fn('COUNT', col('tenant_id')), 'count']], group: ['status'], raw: true }),
      User.count({ where: { status: 'active' } }),
      Vehicle.count({ where: { status: 'active' } }),
      Machinery.count({ where: { status: 'active' } }),
      AuditLog.count({ where: { action: 'LOGIN', createdAt: { [Op.gte]: weekStart } } }),
      AuditLog.count({ where: { createdAt: { [Op.gte]: weekStart } }, distinct: true, col: 'tenantId' }),
      AuditLog.count({ where: { action: { [Op.notIn]: SIGN_IN_ACTIONS }, createdAt: { [Op.gte]: weekStart } } }),
      organizationBreakdown(weekStart),
      // Active organizations nobody has used for a while: worth a call.
      sequelize.query(
        `SELECT t.tenant_id AS tenantId, t.organization_name AS organizationName, t.created_at AS createdAt,
                MAX(a.created_at) AS lastActivityAt
           FROM tenants t
           LEFT JOIN audit_logs a ON a.tenant_id = t.tenant_id
          WHERE t.status = 'active'
          GROUP BY t.tenant_id, t.organization_name, t.created_at
         HAVING lastActivityAt IS NULL OR lastActivityAt < :quietSince
          ORDER BY lastActivityAt IS NOT NULL, lastActivityAt ASC
          LIMIT :limit`,
        { replacements: { quietSince, limit: QUIET_ORGANIZATIONS_LIMIT }, type: QueryTypes.SELECT }
      ),
    ]);

  const organizations = { total: 0, active: 0, suspended: 0, inactive: 0 };
  for (const row of tenantsByStatus) {
    organizations[row.status] = Number(row.count);
    organizations.total += Number(row.count);
  }

  return {
    totals: { organizations, users, vehicles, machinery },
    lastWeek: { days: OVERVIEW_DAYS, signIns, activeOrganizations, changes },
    organizationsActivity: breakdown.map((row) => ({
      ...row,
      users: Number(row.users),
      vehicles: Number(row.vehicles),
      machinery: Number(row.machinery),
      signIns: Number(row.signIns),
      changes: Number(row.changes),
    })),
    quietOrganizations: { days: SUMMARY_DAYS, rows: quiet },
  };
}

// Who set each admin's current password, and when. Newest audit entry per user wins.
const PASSWORD_EVENTS = { PASSWORD_CHANGED: 'admin', PASSWORD_RESET: 'reset_link', ADMIN_PASSWORD_RESET: 'super_admin' };

async function lastPasswordChangeByUser(users) {
  if (users.length === 0) return new Map();
  const logs = await AuditLog.findAll({
    attributes: ['entityId', 'action', 'createdAt'],
    where: {
      tenantId: [...new Set(users.map((user) => user.tenantId))],
      entityType: 'User',
      entityId: users.map((user) => String(user.id)),
      action: Object.keys(PASSWORD_EVENTS),
    },
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
  });

  const latest = new Map();
  for (const log of logs) {
    const userId = Number(log.entityId);
    if (!latest.has(userId)) latest.set(userId, { at: log.createdAt, by: PASSWORD_EVENTS[log.action] });
  }
  return latest;
}

module.exports = { lastPasswordChangeByUser, listActivity, listTenantActivity, tenantActivitySummary, lastActivityByTenant, platformOverview };
