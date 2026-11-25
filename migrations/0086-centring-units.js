const { DataTypes } = require('sequelize');

// Centring units of measure become a list each organization keeps itself (Centring Catalog › Units of Measure), as in
// Inventory, instead of a fixed Nos/Sqm/Rmt/Kg/Set. An item still stores its unit's name, so stock, movements and
// reports read as before. Every unit an item already uses is added to the list, so existing items stay valid.

const ref = (model, allowNull = false) => ({
  type: DataTypes.INTEGER.UNSIGNED,
  allowNull,
  references: { model, key: 'id' },
  onUpdate: 'CASCADE',
  onDelete: 'RESTRICT',
});

async function up({ context: queryInterface }) {
  await queryInterface.createTable('centring_units', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    tenant_id: { type: DataTypes.STRING(64), allowNull: false, references: { model: 'tenants', key: 'tenant_id' }, onUpdate: 'CASCADE', onDelete: 'RESTRICT' },
    unit_name: { type: DataTypes.STRING(20), allowNull: false },
    status: { type: DataTypes.ENUM('active', 'archived'), allowNull: false, defaultValue: 'active' },
    archived_at: { type: DataTypes.DATE, allowNull: true },
    archived_by: ref('users', true),
    created_by: ref('users'),
    updated_by: ref('users'),
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });
  await queryInterface.addConstraint('centring_units', { type: 'unique', fields: ['tenant_id', 'unit_name'], name: 'uq_centring_units_name' });

  await queryInterface.sequelize.query(
    `INSERT INTO centring_units (tenant_id, unit_name, status, created_by, updated_by, created_at, updated_at)
     SELECT tenant_id, unit, 'active', MIN(created_by), MIN(created_by), NOW(), NOW()
     FROM centring_items GROUP BY tenant_id, unit`
  );
}

async function down({ context: queryInterface }) {
  await queryInterface.dropTable('centring_units');
}

module.exports = { up, down };
