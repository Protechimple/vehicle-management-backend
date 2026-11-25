const { DataTypes } = require('sequelize');

// Centring Inventory: a module of its own, separate from the asset Inventory. Centring material (plates, props,
// spans…) is always held at a site. Stock is never stored: it is the sum of the entries, where each entry adds stock
// at a site, reduces it, or transfers it from one site to another, and lists the items and quantities it moved.

const TABLES = ['centring_items', 'centring_entries', 'centring_entry_lines'];

const ref = (model, allowNull = false) => ({
  type: DataTypes.INTEGER.UNSIGNED,
  allowNull,
  references: { model, key: 'id' },
  onUpdate: 'CASCADE',
  onDelete: 'RESTRICT',
});

const tenantColumn = () => ({
  type: DataTypes.STRING(64),
  allowNull: false,
  references: { model: 'tenants', key: 'tenant_id' },
  onUpdate: 'CASCADE',
  onDelete: 'RESTRICT',
});

async function up({ context: queryInterface }) {
  for (const table of TABLES) {
    if (await queryInterface.tableExists(table)) {
      throw new Error(`Table "${table}" already exists. Rename or drop it before running this migration.`);
    }
  }

  await queryInterface.createTable('centring_items', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    tenant_id: tenantColumn(),
    category: { type: DataTypes.STRING(100), allowNull: false },
    sub_category: { type: DataTypes.STRING(100), allowNull: true },
    item_name: { type: DataTypes.STRING(150), allowNull: false },
    unit: { type: DataTypes.STRING(20), allowNull: false },
    status: { type: DataTypes.ENUM('active', 'archived'), allowNull: false, defaultValue: 'active' },
    archived_at: { type: DataTypes.DATE, allowNull: true },
    archived_by: ref('users', true),
    created_by: ref('users'),
    updated_by: ref('users'),
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  await queryInterface.addConstraint('centring_items', { type: 'unique', fields: ['tenant_id', 'item_name'], name: 'uq_centring_items_tenant_name' });
  await queryInterface.addIndex('centring_items', ['tenant_id', 'status', 'category'], { name: 'ix_centring_items_tenant_status_category' });

  await queryInterface.createTable('centring_entries', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    tenant_id: tenantColumn(),
    entry_number: { type: DataTypes.STRING(32), allowNull: false },
    entry_type: { type: DataTypes.ENUM('add', 'reduce', 'transfer'), allowNull: false },
    entry_date: { type: DataTypes.DATEONLY, allowNull: false },
    // The site stock is added at or taken from. For a transfer, the site it leaves.
    site_id: ref('sites'),
    // Only for a transfer: the site it goes to.
    to_site_id: ref('sites', true),
    reason: { type: DataTypes.STRING(60), allowNull: true },
    notes: { type: DataTypes.STRING(1000), allowNull: true },
    status: { type: DataTypes.ENUM('active', 'archived'), allowNull: false, defaultValue: 'active' },
    archived_at: { type: DataTypes.DATE, allowNull: true },
    archived_by: ref('users', true),
    created_by: ref('users'),
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  await queryInterface.addConstraint('centring_entries', { type: 'unique', fields: ['tenant_id', 'entry_number'], name: 'uq_centring_entries_tenant_number' });
  await queryInterface.addIndex('centring_entries', ['tenant_id', 'status', 'site_id'], { name: 'ix_centring_entries_tenant_status_site' });
  await queryInterface.addIndex('centring_entries', ['tenant_id', 'status', 'to_site_id'], { name: 'ix_centring_entries_tenant_status_to_site' });
  await queryInterface.addIndex('centring_entries', ['tenant_id', 'entry_date'], { name: 'ix_centring_entries_tenant_date' });

  await queryInterface.createTable('centring_entry_lines', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    tenant_id: tenantColumn(),
    entry_id: { ...ref('centring_entries'), onDelete: 'CASCADE' },
    item_id: ref('centring_items'),
    quantity: { type: DataTypes.DECIMAL(14, 3), allowNull: false },
  });
  await queryInterface.addConstraint('centring_entry_lines', { type: 'unique', fields: ['entry_id', 'item_id'], name: 'uq_centring_entry_lines_entry_item' });
  await queryInterface.addIndex('centring_entry_lines', ['tenant_id', 'item_id'], { name: 'ix_centring_entry_lines_tenant_item' });
}

async function down({ context: queryInterface }) {
  await queryInterface.dropTable('centring_entry_lines');
  await queryInterface.dropTable('centring_entries');
  await queryInterface.dropTable('centring_items');
}

module.exports = { up, down };
