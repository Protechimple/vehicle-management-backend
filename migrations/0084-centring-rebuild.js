const { DataTypes } = require('sequelize');

// Centring Inventory, rebuilt to work like the Inventory module (the organization asked for its earlier centring data
// to be removed). Set up once: categories, sub categories under them, items under those, and suppliers. Then stock
// moves by entries:
//   purchase   — bought from a supplier, received at the Main Store (to_site_id NULL) or straight at a site
//   issue      — sent from the Main Store to a site
//   transfer   — moved from one site to another site, or back to the Main Store (to_site_id NULL)
//   adjustment — lost, damaged, scrapped or a stock count, at the Main Store (to_site_id NULL) or a site; each line
//                says whether it added (in) or removed (out) stock
// A NULL site always means the Main Store. Stock is never stored: it is the sum of the entries.

const OLD_TABLES = ['centring_entry_lines', 'centring_entries', 'centring_items'];
const NEW_TABLES = ['centring_categories', 'centring_sub_categories', 'centring_suppliers', 'centring_items', 'centring_entries', 'centring_entry_lines'];

const ref = (model, allowNull = false) => ({
  type: DataTypes.INTEGER.UNSIGNED,
  allowNull,
  references: { model, key: 'id' },
  onUpdate: 'CASCADE',
  onDelete: 'RESTRICT',
});

const tenant = () => ({
  type: DataTypes.STRING(64),
  allowNull: false,
  references: { model: 'tenants', key: 'tenant_id' },
  onUpdate: 'CASCADE',
  onDelete: 'RESTRICT',
});

const id = () => ({ type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true });

const masterColumns = () => ({
  status: { type: DataTypes.ENUM('active', 'archived'), allowNull: false, defaultValue: 'active' },
  archived_at: { type: DataTypes.DATE, allowNull: true },
  archived_by: ref('users', true),
  created_by: ref('users'),
  updated_by: ref('users'),
  created_at: { type: DataTypes.DATE, allowNull: false },
  updated_at: { type: DataTypes.DATE, allowNull: false },
});

async function up({ context: queryInterface }) {
  for (const table of OLD_TABLES) {
    if (await queryInterface.tableExists(table)) await queryInterface.dropTable(table);
  }
  await queryInterface.sequelize.query("DELETE FROM code_counters WHERE counter_key LIKE 'centring\\_%'");
  // The old access settings name actions that no longer exist.
  await queryInterface.sequelize.query("DELETE FROM role_permissions WHERE resource = 'CENTRING'");
  await queryInterface.sequelize.query("DELETE FROM user_permissions WHERE resource = 'CENTRING'");

  for (const table of NEW_TABLES) {
    if (await queryInterface.tableExists(table)) throw new Error(`Table "${table}" already exists. Rename or drop it before running this migration.`);
  }

  await queryInterface.createTable('centring_categories', {
    id: id(),
    tenant_id: tenant(),
    category_name: { type: DataTypes.STRING(100), allowNull: false },
    ...masterColumns(),
  });
  await queryInterface.addConstraint('centring_categories', { type: 'unique', fields: ['tenant_id', 'category_name'], name: 'uq_centring_categories_name' });

  await queryInterface.createTable('centring_sub_categories', {
    id: id(),
    tenant_id: tenant(),
    category_id: ref('centring_categories'),
    sub_category_name: { type: DataTypes.STRING(100), allowNull: false },
    ...masterColumns(),
  });
  await queryInterface.addConstraint('centring_sub_categories', { type: 'unique', fields: ['tenant_id', 'category_id', 'sub_category_name'], name: 'uq_centring_sub_categories_name' });

  await queryInterface.createTable('centring_suppliers', {
    id: id(),
    tenant_id: tenant(),
    supplier_name: { type: DataTypes.STRING(150), allowNull: false },
    contact_person: { type: DataTypes.STRING(100), allowNull: true },
    phone: { type: DataTypes.STRING(30), allowNull: true },
    gst_number: { type: DataTypes.STRING(20), allowNull: true },
    address: { type: DataTypes.STRING(500), allowNull: true },
    ...masterColumns(),
  });
  await queryInterface.addConstraint('centring_suppliers', { type: 'unique', fields: ['tenant_id', 'supplier_name'], name: 'uq_centring_suppliers_name' });

  await queryInterface.createTable('centring_items', {
    id: id(),
    tenant_id: tenant(),
    category_id: ref('centring_categories'),
    sub_category_id: ref('centring_sub_categories'),
    item_name: { type: DataTypes.STRING(150), allowNull: false },
    unit: { type: DataTypes.STRING(20), allowNull: false },
    ...masterColumns(),
  });
  await queryInterface.addConstraint('centring_items', { type: 'unique', fields: ['tenant_id', 'item_name'], name: 'uq_centring_items_name' });
  await queryInterface.addIndex('centring_items', ['tenant_id', 'status', 'category_id'], { name: 'ix_centring_items_category' });

  await queryInterface.createTable('centring_entries', {
    id: id(),
    tenant_id: tenant(),
    entry_number: { type: DataTypes.STRING(32), allowNull: false },
    entry_type: { type: DataTypes.ENUM('purchase', 'issue', 'transfer', 'adjustment'), allowNull: false },
    entry_date: { type: DataTypes.DATEONLY, allowNull: false },
    from_site_id: ref('sites', true),
    to_site_id: ref('sites', true),
    supplier_id: ref('centring_suppliers', true),
    bill_number: { type: DataTypes.STRING(60), allowNull: true },
    reason: { type: DataTypes.STRING(40), allowNull: true },
    issued_to: { type: DataTypes.STRING(150), allowNull: true },
    remarks: { type: DataTypes.STRING(1000), allowNull: true },
    total_amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    status: { type: DataTypes.ENUM('active', 'archived'), allowNull: false, defaultValue: 'active' },
    archived_at: { type: DataTypes.DATE, allowNull: true },
    archived_by: ref('users', true),
    created_by: ref('users'),
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  await queryInterface.addConstraint('centring_entries', { type: 'unique', fields: ['tenant_id', 'entry_number'], name: 'uq_centring_entries_number' });
  await queryInterface.addIndex('centring_entries', ['tenant_id', 'status', 'entry_type', 'entry_date'], { name: 'ix_centring_entries_type_date' });
  await queryInterface.addIndex('centring_entries', ['tenant_id', 'status', 'from_site_id'], { name: 'ix_centring_entries_from' });
  await queryInterface.addIndex('centring_entries', ['tenant_id', 'status', 'to_site_id'], { name: 'ix_centring_entries_to' });

  await queryInterface.createTable('centring_entry_lines', {
    id: id(),
    tenant_id: tenant(),
    entry_id: { ...ref('centring_entries'), onDelete: 'CASCADE' },
    item_id: ref('centring_items'),
    direction: { type: DataTypes.ENUM('in', 'out'), allowNull: false, defaultValue: 'in' },
    quantity: { type: DataTypes.DECIMAL(14, 3), allowNull: false },
    unit_price: { type: DataTypes.DECIMAL(14, 4), allowNull: false, defaultValue: 0 },
    tax_percent: { type: DataTypes.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
    amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
  });
  await queryInterface.addConstraint('centring_entry_lines', { type: 'unique', fields: ['entry_id', 'item_id'], name: 'uq_centring_entry_lines_item' });
  await queryInterface.addIndex('centring_entry_lines', ['tenant_id', 'item_id'], { name: 'ix_centring_entry_lines_item' });
}

// The earlier centring tables and their data were removed on purpose, so there is nothing to go back to.
async function down() {
  throw new Error('0084-centring-rebuild cannot be undone: the earlier centring tables and data were removed by design.');
}

module.exports = { up, down };
