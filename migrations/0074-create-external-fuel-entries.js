const { DataTypes } = require('sequelize');

// Fuel given from site stock to vehicles that don't belong to the organization (client, guest, contractor).
// Kept apart from fuel_transactions: these vehicles have no asset record, meter history or cost centre here.
async function up({ context: queryInterface }) {
  const userRef = {
    type: DataTypes.INTEGER.UNSIGNED,
    references: { model: 'users', key: 'id' },
    onUpdate: 'CASCADE',
    onDelete: 'RESTRICT',
  };
  const ledgerRef = {
    type: DataTypes.INTEGER.UNSIGNED,
    allowNull: true,
    references: { model: 'fuel_stock_ledger', key: 'id' },
    onUpdate: 'CASCADE',
    onDelete: 'RESTRICT',
  };

  await queryInterface.changeColumn('fuel_stock_ledger', 'entry_type', {
    type: DataTypes.ENUM('RECEIPT', 'ISSUE', 'ISSUE_REVERSAL', 'EXTERNAL_ISSUE', 'EXTERNAL_ISSUE_REVERSAL'),
    allowNull: false,
  });
  await queryInterface.changeColumn('fuel_stock_ledger', 'reference_type', {
    type: DataTypes.ENUM('FUEL_COLLECTION', 'FUEL_TRANSACTION', 'EXTERNAL_FUEL_ENTRY'),
    allowNull: false,
  });

  await queryInterface.createTable('external_fuel_entries', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    tenant_id: {
      type: DataTypes.STRING(64),
      allowNull: false,
      references: { model: 'tenants', key: 'tenant_id' },
      onUpdate: 'CASCADE',
      onDelete: 'RESTRICT',
    },
    entry_number: { type: DataTypes.STRING(64), allowNull: false },
    site_id: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      references: { model: 'sites', key: 'id' },
      onUpdate: 'CASCADE',
      onDelete: 'RESTRICT',
    },
    fuel_type: { type: DataTypes.ENUM('Diesel', 'Petrol'), allowNull: false },
    entry_date: { type: DataTypes.DATEONLY, allowNull: false },
    entry_time: { type: DataTypes.TIME, allowNull: true },
    vehicle_number: { type: DataTypes.STRING(32), allowNull: false },
    vehicle_type: { type: DataTypes.STRING(100), allowNull: true },
    category: { type: DataTypes.ENUM('CLIENT', 'GUEST', 'CONTRACTOR', 'OTHER'), allowNull: false },
    party_name: { type: DataTypes.STRING(150), allowNull: false },
    driver_name: { type: DataTypes.STRING(150), allowNull: true },
    driver_mobile: { type: DataTypes.STRING(32), allowNull: true },
    quantity: { type: DataTypes.DECIMAL(12, 3), allowNull: false },
    price_per_litre: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
    amount: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
    meter_reading: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
    authorised_by: { type: DataTypes.STRING(150), allowNull: true },
    reference_number: { type: DataTypes.STRING(64), allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    ledger_entry_id: ledgerRef,
    reversal_ledger_entry_id: ledgerRef,
    status: { type: DataTypes.ENUM('active', 'archived'), allowNull: false, defaultValue: 'active' },
    archived_at: { type: DataTypes.DATE, allowNull: true },
    archived_by: { ...userRef, allowNull: true },
    created_by: { ...userRef, allowNull: false },
    updated_by: { ...userRef, allowNull: false },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });

  await queryInterface.addConstraint('external_fuel_entries', {
    type: 'unique',
    fields: ['tenant_id', 'entry_number'],
    name: 'uq_external_fuel_entries_tenant_number',
  });
  await queryInterface.addIndex('external_fuel_entries', ['tenant_id', 'site_id', 'entry_date'], {
    name: 'ix_external_fuel_entries_tenant_site_date',
  });
  await queryInterface.addIndex('external_fuel_entries', ['tenant_id', 'entry_date'], {
    name: 'ix_external_fuel_entries_tenant_date',
  });
}

async function down({ context: queryInterface }) {
  const [[{ n }]] = await queryInterface.sequelize.query(
    "SELECT COUNT(*) AS n FROM fuel_stock_ledger WHERE reference_type = 'EXTERNAL_FUEL_ENTRY'"
  );
  if (Number(n) > 0) {
    throw new Error(
      `fuel_stock_ledger has ${n} external vehicle fuel movements. Removing them would change site fuel stock, so this migration stops here.`
    );
  }

  await queryInterface.dropTable('external_fuel_entries');

  await queryInterface.changeColumn('fuel_stock_ledger', 'entry_type', {
    type: DataTypes.ENUM('RECEIPT', 'ISSUE', 'ISSUE_REVERSAL'),
    allowNull: false,
  });
  await queryInterface.changeColumn('fuel_stock_ledger', 'reference_type', {
    type: DataTypes.ENUM('FUEL_COLLECTION', 'FUEL_TRANSACTION'),
    allowNull: false,
  });
}

module.exports = { up, down };
