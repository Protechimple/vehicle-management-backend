const { DataTypes } = require('sequelize');

const NEW_TABLES = ['user_sites', 'role_permissions', 'user_permissions'];

const tenantRef = {
  type: DataTypes.STRING(64),
  allowNull: false,
  references: { model: 'tenants', key: 'tenant_id' },
  onUpdate: 'CASCADE',
  onDelete: 'RESTRICT',
};

const userRef = (onDelete) => ({
  type: DataTypes.INTEGER.UNSIGNED,
  references: { model: 'users', key: 'id' },
  onUpdate: 'CASCADE',
  onDelete,
});

const timestamps = {
  created_at: { type: DataTypes.DATE, allowNull: false },
  updated_at: { type: DataTypes.DATE, allowNull: false },
};

async function up({ context: queryInterface }) {
  const sequelize = queryInterface.sequelize;

  for (const table of NEW_TABLES) {
    if (await queryInterface.tableExists(table)) {
      throw new Error(`Table "${table}" already exists. Rename or drop it before running this migration.`);
    }
  }

  await sequelize.query(
    "ALTER TABLE users MODIFY role ENUM('admin', 'supervisor', 'site_manager', 'inventory_supervisor') NOT NULL"
  );

  // The Site Manager a person reports to. Removing that manager leaves the person without one, not deleted.
  await queryInterface.addColumn('users', 'manager_id', { type: DataTypes.INTEGER.UNSIGNED, allowNull: true });
  await queryInterface.addConstraint('users', {
    type: 'foreign key',
    fields: ['manager_id'],
    name: 'fk_users_manager_id',
    references: { table: 'users', field: 'id' },
    onUpdate: 'CASCADE',
    onDelete: 'SET NULL',
  });
  await queryInterface.addIndex('users', ['tenant_id', 'manager_id'], { name: 'ix_users_tenant_manager' });

  // The sites a Site Manager covers. Single-site roles keep using users.site_id.
  await queryInterface.createTable('user_sites', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    tenant_id: tenantRef,
    user_id: { ...userRef('CASCADE'), allowNull: false },
    site_id: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      references: { model: 'sites', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'RESTRICT',
    },
    created_by: { ...userRef('RESTRICT'), allowNull: false },
    ...timestamps,
  });
  await queryInterface.addConstraint('user_sites', {
    type: 'unique',
    fields: ['user_id', 'site_id'],
    name: 'uq_user_sites_user_site',
  });
  await queryInterface.addIndex('user_sites', ['tenant_id', 'site_id'], { name: 'ix_user_sites_tenant_site' });

  // The organization's choice for a role, where it differs from the built-in rule.
  await queryInterface.createTable('role_permissions', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    tenant_id: tenantRef,
    role: { type: DataTypes.ENUM('supervisor', 'site_manager', 'inventory_supervisor'), allowNull: false },
    resource: { type: DataTypes.STRING(40), allowNull: false },
    action: { type: DataTypes.STRING(40), allowNull: false },
    allowed: { type: DataTypes.BOOLEAN, allowNull: false },
    updated_by: { ...userRef('RESTRICT'), allowNull: false },
    ...timestamps,
  });
  await queryInterface.addConstraint('role_permissions', {
    type: 'unique',
    fields: ['tenant_id', 'role', 'resource', 'action'],
    name: 'uq_role_permissions_tenant_role_action',
  });

  // One person's exception to their role's access.
  await queryInterface.createTable('user_permissions', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    tenant_id: tenantRef,
    user_id: { ...userRef('CASCADE'), allowNull: false },
    resource: { type: DataTypes.STRING(40), allowNull: false },
    action: { type: DataTypes.STRING(40), allowNull: false },
    allowed: { type: DataTypes.BOOLEAN, allowNull: false },
    updated_by: { ...userRef('RESTRICT'), allowNull: false },
    ...timestamps,
  });
  await queryInterface.addConstraint('user_permissions', {
    type: 'unique',
    fields: ['user_id', 'resource', 'action'],
    name: 'uq_user_permissions_user_action',
  });
}

async function down({ context: queryInterface }) {
  const sequelize = queryInterface.sequelize;
  const [[{ count }]] = await sequelize.query(
    "SELECT COUNT(*) AS count FROM users WHERE role IN ('site_manager', 'inventory_supervisor')"
  );
  if (Number(count) > 0) {
    throw new Error(
      `${count} user(s) have the Site Manager or Inventory Supervisor role. Change or remove them before undoing this migration.`
    );
  }

  await queryInterface.dropTable('user_permissions');
  await queryInterface.dropTable('role_permissions');
  await queryInterface.dropTable('user_sites');
  await queryInterface.removeConstraint('users', 'fk_users_manager_id');
  await queryInterface.removeIndex('users', 'ix_users_tenant_manager');
  await queryInterface.removeColumn('users', 'manager_id');
  await sequelize.query("ALTER TABLE users MODIFY role ENUM('admin', 'supervisor') NOT NULL");
}

module.exports = { up, down };
