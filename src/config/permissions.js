const ROLES = Object.freeze({
  ADMIN: 'admin',
  SITE_MANAGER: 'site_manager',
  SUPERVISOR: 'supervisor',
  INVENTORY_SUPERVISOR: 'inventory_supervisor',
});

const ROLE_LABELS = Object.freeze({
  [ROLES.ADMIN]: 'Admin',
  [ROLES.SITE_MANAGER]: 'Site Manager',
  [ROLES.SUPERVISOR]: 'Supervisor',
  [ROLES.INVENTORY_SUPERVISOR]: 'Inventory Supervisor',
});

// Every role below the Admin works at sites, and the Admin can change what each of them may do.
const SITE_ROLES = Object.freeze([ROLES.SITE_MANAGER, ROLES.SUPERVISOR, ROLES.INVENTORY_SUPERVISOR]);

// Every site role may be given one site or several. Their sites are kept in user_sites.
const MULTI_SITE_ROLES = SITE_ROLES;

// Who may be placed under a Site Manager. A Site Manager always reports to the Admin.
const MANAGEABLE_ROLES = Object.freeze([ROLES.SUPERVISOR, ROLES.INVENTORY_SUPERVISOR]);

const ADMIN_ONLY = [ROLES.ADMIN];
const SITE_STAFF = [ROLES.ADMIN, ROLES.SITE_MANAGER, ROLES.SUPERVISOR];
const EVERYONE = [ROLES.ADMIN, ...SITE_ROLES];

const standardModule = Object.freeze({
  CREATE: SITE_STAFF,
  READ: SITE_STAFF,
  UPDATE: SITE_STAFF,
  DELETE: ADMIN_ONLY,
  RESTORE: ADMIN_ONLY,
});

// The built-in rules. They are each role's defaults; an Admin may change the configurable ones per role and per user.
const PERMISSIONS = Object.freeze({
  VEHICLE: Object.freeze({ ...standardModule, READ: EVERYONE }),
  MACHINERY: Object.freeze({ ...standardModule, READ: EVERYONE }),
  // Correcting a saved cost is the Admin's. A Supervisor enters it once, when finishing the work.
  MAINTENANCE: Object.freeze({ ...standardModule, UPDATE_COST: ADMIN_ONLY }),
  SERVICE: standardModule,
  TYRE: standardModule,
  // Scrapping is normal site work, so a Supervisor may do it. Correcting or deleting a battery's details is the Admin's.
  BATTERY: Object.freeze({ ...standardModule, SCRAP: SITE_STAFF, EDIT_DETAILS: ADMIN_ONLY }),
  FUEL: standardModule,
  ADBLUE: standardModule,
  COMPLIANCE: standardModule,

  SITE: Object.freeze({
    ...standardModule,
    READ: EVERYONE,
    CREATE: ADMIN_ONLY,
    UPDATE: ADMIN_ONLY,
    ASSIGN: ADMIN_ONLY,
  }),

  DOCUMENT: Object.freeze({
    CREATE: SITE_STAFF,
    READ: SITE_STAFF,
  }),

  ITEM_CATEGORY: Object.freeze({ ...standardModule, READ: EVERYONE, CREATE: ADMIN_ONLY, UPDATE: ADMIN_ONLY }),
  UOM: Object.freeze({ ...standardModule, READ: EVERYONE, CREATE: ADMIN_ONLY, UPDATE: ADMIN_ONLY }),
  ITEM: Object.freeze({ ...standardModule, READ: EVERYONE, CREATE: ADMIN_ONLY, UPDATE: ADMIN_ONLY }),
  SUPPLIER: Object.freeze({ ...standardModule, READ: EVERYONE, CREATE: ADMIN_ONLY, UPDATE: ADMIN_ONLY }),

  PURCHASE: Object.freeze({ CREATE: EVERYONE, READ: EVERYONE, UPDATE: EVERYONE, RECEIVE: EVERYONE }),

  STOCK: Object.freeze({ READ: EVERYONE }),

  ASSET_ISSUE: Object.freeze({ CREATE: EVERYONE, READ: EVERYONE, REVERSE: EVERYONE }),

  STOCK_ADJUSTMENT: Object.freeze({ CREATE: EVERYONE, READ: EVERYONE }),
  STOCK_TRANSFER: Object.freeze({ CREATE: ADMIN_ONLY, READ: ADMIN_ONLY, RECEIVE: ADMIN_ONLY }),

  FUEL_STATION: Object.freeze({ ...standardModule, CREATE: ADMIN_ONLY, UPDATE: ADMIN_ONLY }),
  FUEL_COLLECTION: Object.freeze({
    CREATE: SITE_STAFF,
    READ: SITE_STAFF,
    UPDATE: SITE_STAFF,
    RECEIVE: SITE_STAFF,
    CANCEL: ADMIN_ONLY,
  }),
  FUEL_STOCK: Object.freeze({ READ: SITE_STAFF }),

  REPORTS: Object.freeze({
    VIEW: EVERYONE,
    PRINT: EVERYONE,
    EXPORT: ADMIN_ONLY,
  }),

  USERS: Object.freeze({
    LIST: ADMIN_ONLY,
    CREATE_SUPERVISOR: ADMIN_ONLY,
    UPDATE_SUPERVISOR: ADMIN_ONLY,
    SET_SUPERVISOR_STATUS: ADMIN_ONLY,
    CHANGE_SUPERVISOR_PASSWORD: ADMIN_ONLY,
    MANAGE_ACCESS: ADMIN_ONLY,
    // A Site Manager sees the people placed under them.
    VIEW_TEAM: [ROLES.SITE_MANAGER],
    VIEW_OWN_PROFILE: EVERYONE,
    UPDATE_OWN_PROFILE: ADMIN_ONLY,
    CHANGE_OWN_PASSWORD: ADMIN_ONLY,
  }),

  DASHBOARD: Object.freeze({
    VIEW: EVERYONE,
    VIEW_SUMMARY_METRICS: EVERYONE,
  }),

  BRANDING: Object.freeze({
    READ: EVERYONE,
    UPDATE: ADMIN_ONLY,
  }),
});

const ACTION_LABELS = Object.freeze({
  READ: 'View',
  VIEW: 'View',
  CREATE: 'Create',
  UPDATE: 'Edit',
  DELETE: 'Delete',
  RESTORE: 'Restore',
  RECEIVE: 'Receive',
  REVERSE: 'Reverse',
  CANCEL: 'Cancel',
  SCRAP: 'Scrap',
  EDIT_DETAILS: 'Edit details',
  UPDATE_COST: 'Correct cost',
  PRINT: 'Print',
  EXPORT: 'Export',
});

// What the Admin's access screen shows, grouped as the sidebar groups it. Anything not listed here keeps its built-in
// rule for everyone: user management, branding, the dashboard and site set-up stay as they are.
const ACCESS_MODULES = Object.freeze([
  {
    key: 'assets',
    label: 'Assets',
    resources: [
      { resource: 'VEHICLE', label: 'Vehicles' },
      { resource: 'MACHINERY', label: 'Machinery' },
      { resource: 'COMPLIANCE', label: 'Compliance' },
      { resource: 'DOCUMENT', label: 'Asset documents' },
    ],
  },
  { key: 'maintenance', label: 'Maintenance', resources: [{ resource: 'MAINTENANCE', label: 'Maintenance' }] },
  {
    key: 'fuel',
    label: 'Fuel',
    resources: [
      { resource: 'FUEL', label: 'Fuel issues & external fuel' },
      { resource: 'FUEL_COLLECTION', label: 'Fuel collections' },
      { resource: 'FUEL_STOCK', label: 'Fuel stock' },
      { resource: 'FUEL_STATION', label: 'Fuel stations' },
    ],
  },
  { key: 'adblue', label: 'AdBlue', resources: [{ resource: 'ADBLUE', label: 'AdBlue' }] },
  {
    key: 'inventory',
    label: 'Inventory',
    resources: [
      { resource: 'ITEM', label: 'Items' },
      { resource: 'ITEM_CATEGORY', label: 'Item categories' },
      { resource: 'UOM', label: 'Units of measure' },
      { resource: 'SUPPLIER', label: 'Suppliers' },
      { resource: 'PURCHASE', label: 'Purchases' },
      { resource: 'STOCK', label: 'Stock' },
      { resource: 'ASSET_ISSUE', label: 'Issues to assets' },
      { resource: 'STOCK_ADJUSTMENT', label: 'Stock adjustments' },
      { resource: 'STOCK_TRANSFER', label: 'Stock transfers' },
    ],
  },
  { key: 'tyres', label: 'Tyres', resources: [{ resource: 'TYRE', label: 'Tyres' }] },
  { key: 'batteries', label: 'Batteries', resources: [{ resource: 'BATTERY', label: 'Batteries' }] },
  { key: 'reports', label: 'Reports', resources: [{ resource: 'REPORTS', label: 'Reports' }] },
]);

const VIEW_ACTIONS = ['READ', 'VIEW'];

const keyOf = (resource, action) => `${resource}:${action}`;

function viewActionOf(resource) {
  return VIEW_ACTIONS.find((action) => PERMISSIONS[resource]?.[action]) ?? null;
}

const CONFIGURABLE = new Set(
  ACCESS_MODULES.flatMap((module) =>
    module.resources.flatMap(({ resource }) => Object.keys(PERMISSIONS[resource]).map((action) => keyOf(resource, action)))
  )
);

function isConfigurable(resource, action) {
  return CONFIGURABLE.has(keyOf(resource, action));
}

function isDefaultAllowed(role, resource, action) {
  const allowedRoles = PERMISSIONS[resource]?.[action];
  return Array.isArray(allowedRoles) && allowedRoles.includes(role);
}

// The access a user has: the built-in rule, then the organization's choice for the role, then the user's own exception.
// Taking away a screen's View takes away everything else on it, so no one is left able to edit what they cannot open.
// rolesOverrides / userOverrides: Map of "RESOURCE:ACTION" -> boolean.
function resolvePermissions({ role, roleOverrides = new Map(), userOverrides = new Map() }) {
  const granted = new Set();

  for (const [resource, actions] of Object.entries(PERMISSIONS)) {
    for (const action of Object.keys(actions)) {
      const key = keyOf(resource, action);
      let allowed = isDefaultAllowed(role, resource, action);
      if (role !== ROLES.ADMIN && CONFIGURABLE.has(key)) {
        if (roleOverrides.has(key)) allowed = roleOverrides.get(key);
        if (userOverrides.has(key)) allowed = userOverrides.get(key);
      }
      if (allowed) granted.add(key);
    }
  }

  if (role !== ROLES.ADMIN) {
    for (const { resources } of ACCESS_MODULES) {
      for (const { resource } of resources) {
        const view = viewActionOf(resource);
        if (view && !granted.has(keyOf(resource, view))) {
          for (const action of Object.keys(PERMISSIONS[resource])) granted.delete(keyOf(resource, action));
        }
      }
    }
  }

  return granted;
}

// The built-in rule only. Used where there is no signed-in user to ask, such as scripts.
function hasPermission(role, resource, action) {
  return isDefaultAllowed(role, resource, action);
}

// The signed-in user's access, as worked out when their request was authenticated.
function can(auth, resource, action) {
  if (!auth) return false;
  if (auth.permissions instanceof Set) return auth.permissions.has(keyOf(resource, action));
  return isDefaultAllowed(auth.role, resource, action);
}

module.exports = {
  ROLES,
  ROLE_LABELS,
  SITE_ROLES,
  MULTI_SITE_ROLES,
  MANAGEABLE_ROLES,
  PERMISSIONS,
  ACTION_LABELS,
  ACCESS_MODULES,
  keyOf,
  viewActionOf,
  isConfigurable,
  isDefaultAllowed,
  resolvePermissions,
  hasPermission,
  can,
};
