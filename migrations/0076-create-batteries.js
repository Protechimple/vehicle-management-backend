const { DataTypes } = require('sequelize');

const TABLES = ['batteries', 'battery_events'];

const tenantRef = {
  type: DataTypes.STRING(64),
  allowNull: false,
  references: { model: 'tenants', key: 'tenant_id' },
  onUpdate: 'CASCADE',
  onDelete: 'RESTRICT',
};

const siteRef = {
  type: DataTypes.INTEGER.UNSIGNED,
  allowNull: false,
  references: { model: 'sites', key: 'id' },
  onUpdate: 'CASCADE',
  onDelete: 'RESTRICT',
};

const userRef = {
  type: DataTypes.INTEGER.UNSIGNED,
  references: { model: 'users', key: 'id' },
  onUpdate: 'CASCADE',
  onDelete: 'RESTRICT',
};

async function up({ context: queryInterface }) {
  for (const table of TABLES) {
    if (await queryInterface.tableExists(table)) {
      throw new Error(`Table "${table}" already exists. Rename or drop it before running this migration.`);
    }
  }

  // One row per physical battery. site_id is where it is stored, or the site it was fitted at.
  await queryInterface.createTable('batteries', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    tenant_id: tenantRef,
    battery_code: { type: DataTypes.STRING(32), allowNull: false },
    serial_number: { type: DataTypes.STRING(64), allowNull: false },
    brand: { type: DataTypes.STRING(100), allowNull: false },
    model_name: { type: DataTypes.STRING(100), allowNull: true },
    capacity_ah: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    voltage: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    purchase_date: { type: DataTypes.DATEONLY, allowNull: false },
    supplier_name: { type: DataTypes.STRING(255), allowNull: true },
    invoice_number: { type: DataTypes.STRING(64), allowNull: true },
    purchase_cost: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    warranty_months: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    site_id: siteRef,
    battery_status: {
      type: DataTypes.ENUM('ready', 'fitted', 'needs_repair', 'scrapped'),
      allowNull: false,
      defaultValue: 'ready',
    },
    asset_type: { type: DataTypes.ENUM('VEHICLE', 'MACHINERY'), allowNull: true },
    asset_id: { type: DataTypes.STRING(64), allowNull: true },
    position: { type: DataTypes.STRING(50), allowNull: true },
    fitted_at: { type: DataTypes.DATEONLY, allowNull: true },
    scrapped_at: { type: DataTypes.DATEONLY, allowNull: true },
    scrap_reason: { type: DataTypes.STRING(500), allowNull: true },
    notes: { type: DataTypes.STRING(1000), allowNull: true },
    created_by: { ...userRef, allowNull: false },
    updated_by: { ...userRef, allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });

  await queryInterface.addConstraint('batteries', {
    type: 'unique',
    fields: ['tenant_id', 'battery_code'],
    name: 'uq_batteries_tenant_code',
  });
  await queryInterface.addConstraint('batteries', {
    type: 'unique',
    fields: ['tenant_id', 'serial_number'],
    name: 'uq_batteries_tenant_serial',
  });
  await queryInterface.addIndex('batteries', ['tenant_id', 'battery_status', 'site_id'], { name: 'ix_batteries_tenant_status_site' });
  await queryInterface.addIndex('batteries', ['tenant_id', 'asset_type', 'asset_id'], { name: 'ix_batteries_tenant_asset' });
  await queryInterface.addIndex('batteries', ['tenant_id', 'purchase_date'], { name: 'ix_batteries_tenant_purchase_date' });

  // The battery's history: one row for every purchase, fitting, removal, repair and scrapping.
  await queryInterface.createTable('battery_events', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    tenant_id: tenantRef,
    battery_id: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      references: { model: 'batteries', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    event_type: {
      type: DataTypes.ENUM('purchased', 'fitted', 'removed', 'sent_for_repair', 'repaired', 'scrapped'),
      allowNull: false,
    },
    event_date: { type: DataTypes.DATEONLY, allowNull: false },
    site_id: siteRef,
    asset_type: { type: DataTypes.ENUM('VEHICLE', 'MACHINERY'), allowNull: true },
    asset_id: { type: DataTypes.STRING(64), allowNull: true },
    position: { type: DataTypes.STRING(50), allowNull: true },
    meter_type: { type: DataTypes.ENUM('KM', 'HOURS'), allowNull: true },
    meter_reading: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    outcome: { type: DataTypes.ENUM('ready', 'needs_repair', 'scrapped'), allowNull: true },
    amount: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    vendor: { type: DataTypes.STRING(255), allowNull: true },
    notes: { type: DataTypes.STRING(1000), allowNull: true },
    related_battery_id: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
      references: { model: 'batteries', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'SET NULL',
    },
    created_by: { ...userRef, allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });

  await queryInterface.addIndex('battery_events', ['tenant_id', 'battery_id', 'event_date'], { name: 'ix_battery_events_tenant_battery_date' });
  await queryInterface.addIndex('battery_events', ['tenant_id', 'asset_type', 'asset_id', 'event_date'], { name: 'ix_battery_events_tenant_asset_date' });
  await queryInterface.addIndex('battery_events', ['tenant_id', 'site_id', 'event_date'], { name: 'ix_battery_events_tenant_site_date' });
}

async function down({ context: queryInterface }) {
  await queryInterface.dropTable('battery_events');
  await queryInterface.dropTable('batteries');
}

module.exports = { up, down };
