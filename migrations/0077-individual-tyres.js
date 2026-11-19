const { DataTypes, QueryTypes } = require('sequelize');

// Tyres become individual records (one row per tyre) kept in two stores per site: the New Tyre Store (bought
// tyres) and the Spare Tyre Store (an asset's own spare tyres, no purchase cost). Every fitting, removal,
// puncture, remould and scrap is a row in tyre_events, so each tyre's run and cost add up over its life.
// Each vehicle / machine gets an axle layout that decides its tyre positions.
//
// Existing quantity stock and fittings are converted, nothing is dropped with data in it:
//   new stock          -> tyres in the New Tyre Store (stock value split across them)
//   used stock         -> tyres in the Spare Tyre Store (no cost, no owner)
//   active fittings    -> fitted tyres
//   replaced fittings  -> scrapped tyres (the old module didn't return them to stock), run and cost kept

const TABLES = ['tyres', 'tyre_events', 'tyre_asset_layouts'];

const tenantRef = {
  type: DataTypes.STRING(64),
  allowNull: false,
  references: { model: 'tenants', key: 'tenant_id' },
  onUpdate: 'CASCADE',
  onDelete: 'RESTRICT',
};
const ref = (model, allowNull = false) => ({
  type: DataTypes.INTEGER.UNSIGNED,
  allowNull,
  references: { model, key: 'id' },
  onUpdate: 'CASCADE',
  onDelete: 'RESTRICT',
});
const assetType = (allowNull = true) => ({ type: DataTypes.ENUM('VEHICLE', 'MACHINERY'), allowNull });
const timestamps = {
  created_at: { type: DataTypes.DATE, allowNull: false },
  updated_at: { type: DataTypes.DATE, allowNull: false },
};

const money = (n) => Math.round(Number(n) * 100) / 100;

async function createTables(queryInterface) {
  await queryInterface.createTable('tyres', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    tenant_id: tenantRef,
    tyre_code: { type: DataTypes.STRING(32), allowNull: false },
    serial_number: { type: DataTypes.STRING(64), allowNull: true },
    tyre_type_id: ref('tyre_types'),
    site_id: ref('sites'),
    purchase_id: ref('tyre_purchases', true),
    purchase_cost: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    tyre_status: { type: DataTypes.ENUM('new', 'spare', 'fitted', 'remould', 'scrapped'), allowNull: false, defaultValue: 'new' },
    // Spare Tyre Store: the vehicle / machine the spare belongs to.
    owner_asset_type: assetType(),
    owner_asset_id: { type: DataTypes.STRING(64), allowNull: true },
    // Current fitting, while fitted.
    asset_type: assetType(),
    asset_id: { type: DataTypes.STRING(64), allowNull: true },
    position: { type: DataTypes.STRING(50), allowNull: true },
    fitted_at: { type: DataTypes.DATEONLY, allowNull: true },
    meter_type: { type: DataTypes.ENUM('KM', 'HOURS'), allowNull: true },
    fit_reading: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    // Lifetime totals, kept in step with tyre_events.
    run_km: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    run_hours: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    repair_cost: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    scrapped_at: { type: DataTypes.DATEONLY, allowNull: true },
    scrap_reason: { type: DataTypes.STRING(500), allowNull: true },
    scrap_value: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    notes: { type: DataTypes.STRING(1000), allowNull: true },
    created_by: ref('users'),
    updated_by: ref('users'),
    ...timestamps,
  });
  await queryInterface.addConstraint('tyres', { type: 'unique', fields: ['tenant_id', 'tyre_code'], name: 'uq_tyres_tenant_code' });
  await queryInterface.addConstraint('tyres', { type: 'unique', fields: ['tenant_id', 'serial_number'], name: 'uq_tyres_tenant_serial' });
  // One tyre per position on an asset, enforced by the database as well as the service.
  await queryInterface.sequelize.query(
    "ALTER TABLE tyres ADD COLUMN fitted_slot VARCHAR(130) GENERATED ALWAYS AS (IF(tyre_status = 'fitted', CONCAT(asset_type, ':', asset_id, ':', LOWER(position)), NULL)) STORED"
  );
  await queryInterface.addConstraint('tyres', { type: 'unique', fields: ['tenant_id', 'fitted_slot'], name: 'uq_tyres_fitted_slot' });
  await queryInterface.addIndex('tyres', ['tenant_id', 'tyre_status', 'site_id'], { name: 'ix_tyres_status_site' });
  await queryInterface.addIndex('tyres', ['tenant_id', 'asset_type', 'asset_id'], { name: 'ix_tyres_asset' });
  await queryInterface.addIndex('tyres', ['tenant_id', 'owner_asset_type', 'owner_asset_id'], { name: 'ix_tyres_owner' });

  await queryInterface.createTable('tyre_events', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    tenant_id: tenantRef,
    tyre_id: { ...ref('tyres'), onDelete: 'CASCADE' },
    event_type: {
      type: DataTypes.ENUM('purchased', 'added_spare', 'fitted', 'removed', 'puncture', 'remould_sent', 'remould_back', 'scrapped'),
      allowNull: false,
    },
    event_date: { type: DataTypes.DATEONLY, allowNull: false },
    site_id: ref('sites'),
    asset_type: assetType(),
    asset_id: { type: DataTypes.STRING(64), allowNull: true },
    position: { type: DataTypes.STRING(50), allowNull: true },
    meter_type: { type: DataTypes.ENUM('KM', 'HOURS'), allowNull: true },
    meter_reading: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    run_value: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    amount: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    vendor: { type: DataTypes.STRING(255), allowNull: true },
    notes: { type: DataTypes.STRING(1000), allowNull: true },
    created_by: ref('users'),
    ...timestamps,
  });
  await queryInterface.addIndex('tyre_events', ['tenant_id', 'tyre_id', 'event_date'], { name: 'ix_tyre_events_tyre' });
  await queryInterface.addIndex('tyre_events', ['tenant_id', 'asset_type', 'asset_id', 'event_date'], { name: 'ix_tyre_events_asset' });
  await queryInterface.addIndex('tyre_events', ['tenant_id', 'event_type', 'event_date'], { name: 'ix_tyre_events_type' });

  await queryInterface.createTable('tyre_asset_layouts', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    tenant_id: tenantRef,
    asset_type: assetType(false),
    asset_id: { type: DataTypes.STRING(64), allowNull: false },
    // Tyres on each axle, front to back, e.g. "2,4,4".
    axles: { type: DataTypes.STRING(64), allowNull: false },
    created_by: ref('users'),
    updated_by: ref('users'),
    ...timestamps,
  });
  await queryInterface.addConstraint('tyre_asset_layouts', {
    type: 'unique',
    fields: ['tenant_id', 'asset_type', 'asset_id'],
    name: 'uq_tyre_asset_layouts_asset',
  });
}

async function convertExistingData(queryInterface, transaction) {
  const { sequelize } = queryInterface;
  const select = (sql) => sequelize.query(sql, { type: QueryTypes.SELECT, transaction });
  const now = new Date();
  const counters = new Map();
  const nextCode = (tenantId) => {
    const n = (counters.get(tenantId) ?? 0) + 1;
    counters.set(tenantId, n);
    return `TYR-${String(n).padStart(6, '0')}`;
  };

  async function insertTyre(row, events) {
    await queryInterface.bulkInsert('tyres', [{ ...row, created_at: now, updated_at: now }], { transaction });
    const [{ tyreId }] = await select(`SELECT id AS tyreId FROM tyres WHERE tenant_id = ${sequelize.escape(row.tenant_id)} AND tyre_code = ${sequelize.escape(row.tyre_code)}`);
    if (events.length) {
      await queryInterface.bulkInsert('tyre_events', events.map((e) => ({ ...e, tenant_id: row.tenant_id, tyre_id: tyreId, created_by: row.created_by, created_at: now, updated_at: now })), { transaction });
    }
  }

  const stocks = await select('SELECT * FROM tyre_stocks WHERE new_quantity > 0 OR used_quantity > 0 ORDER BY id');
  for (const s of stocks) {
    const [owner] = await select(`SELECT created_by AS userId FROM tyre_types WHERE id = ${Number(s.tyre_type_id)}`);
    let remainingValue = money(s.stock_value);
    for (let i = 0; i < s.new_quantity; i += 1) {
      const left = s.new_quantity - i;
      const cost = left === 1 ? remainingValue : money(remainingValue / left);
      remainingValue = money(remainingValue - cost);
      await insertTyre(
        { tenant_id: s.tenant_id, tyre_code: nextCode(s.tenant_id), tyre_type_id: s.tyre_type_id, site_id: s.site_id, purchase_cost: cost, tyre_status: 'new', notes: 'Converted from tyre stock', created_by: owner.userId, updated_by: owner.userId },
        [{ event_type: 'purchased', event_date: now.toISOString().slice(0, 10), site_id: s.site_id, amount: cost, notes: 'Converted from tyre stock' }]
      );
    }
    for (let i = 0; i < s.used_quantity; i += 1) {
      await insertTyre(
        { tenant_id: s.tenant_id, tyre_code: nextCode(s.tenant_id), tyre_type_id: s.tyre_type_id, site_id: s.site_id, purchase_cost: 0, tyre_status: 'spare', notes: 'Converted from used tyre stock', created_by: owner.userId, updated_by: owner.userId },
        [{ event_type: 'added_spare', event_date: now.toISOString().slice(0, 10), site_id: s.site_id, notes: 'Converted from used tyre stock' }]
      );
    }
  }

  const fitments = await select('SELECT * FROM tyre_fitments ORDER BY fitted_at, id');
  for (const f of fitments) {
    const active = f.removed_at == null;
    const run = active ? 0 : Math.max(0, money(Number(f.remove_meter_reading) - Number(f.fit_meter_reading)));
    const events = [
      { event_type: 'fitted', event_date: f.fitted_at, site_id: f.site_id, asset_type: f.asset_type, asset_id: f.asset_id, position: f.position, meter_type: f.meter_type, meter_reading: f.fit_meter_reading, amount: f.unit_cost },
    ];
    if (!active) {
      events.push(
        { event_type: 'removed', event_date: f.removed_at, site_id: f.site_id, asset_type: f.asset_type, asset_id: f.asset_id, position: f.position, meter_type: f.meter_type, meter_reading: f.remove_meter_reading, run_value: run },
        { event_type: 'scrapped', event_date: f.removed_at, site_id: f.site_id, notes: 'Replaced before individual tyre tracking' }
      );
    }
    await insertTyre(
      {
        tenant_id: f.tenant_id,
        tyre_code: nextCode(f.tenant_id),
        serial_number: f.serial_number,
        tyre_type_id: f.tyre_type_id,
        site_id: f.site_id,
        purchase_cost: f.unit_cost,
        tyre_status: active ? 'fitted' : 'scrapped',
        asset_type: active ? f.asset_type : null,
        asset_id: active ? f.asset_id : null,
        position: active ? f.position : null,
        fitted_at: active ? f.fitted_at : null,
        meter_type: active ? f.meter_type : null,
        fit_reading: active ? f.fit_meter_reading : null,
        run_km: f.meter_type === 'KM' ? run : 0,
        run_hours: f.meter_type === 'HOURS' ? run : 0,
        scrapped_at: active ? null : f.removed_at,
        scrap_reason: active ? null : 'Replaced before individual tyre tracking',
        created_by: f.created_by,
        updated_by: f.updated_by,
      },
      events
    );
  }

  // Keep the code counter ahead of the converted tyres.
  for (const [tenantId, highest] of counters) {
    await sequelize.query(
      'INSERT INTO code_counters (tenant_id, counter_key, highest_used) VALUES (:tenantId, :key, :highest) ON DUPLICATE KEY UPDATE highest_used = GREATEST(highest_used, :highest)',
      { replacements: { tenantId, key: 'tyres:TYR-', highest }, transaction }
    );
  }
  return { tyres: [...counters.values()].reduce((t, n) => t + n, 0) };
}

async function up({ context: queryInterface }) {
  for (const table of TABLES) {
    if (await queryInterface.tableExists(table)) {
      throw new Error(`Table "${table}" already exists. Rename or drop it before running this migration.`);
    }
  }
  await createTables(queryInterface);
  await queryInterface.sequelize.transaction((transaction) => convertExistingData(queryInterface, transaction));
  await queryInterface.dropTable('tyre_fitments');
  await queryInterface.dropTable('tyre_stocks');
}

// The old tables come back empty: converted tyres can't be turned back into quantities and fittings.
async function down({ context: queryInterface }) {
  await queryInterface.dropTable('tyre_asset_layouts');
  await queryInterface.dropTable('tyre_events');
  await queryInterface.dropTable('tyres');

  await queryInterface.createTable('tyre_stocks', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    tenant_id: tenantRef,
    site_id: ref('sites'),
    tyre_type_id: ref('tyre_types'),
    new_quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    used_quantity: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    stock_value: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    ...timestamps,
  });
  await queryInterface.addConstraint('tyre_stocks', { type: 'unique', fields: ['tenant_id', 'site_id', 'tyre_type_id'], name: 'uq_tyre_stocks_site_type' });

  await queryInterface.createTable('tyre_fitments', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    tenant_id: tenantRef,
    site_id: ref('sites'),
    tyre_type_id: ref('tyre_types'),
    asset_type: assetType(false),
    asset_id: { type: DataTypes.STRING(64), allowNull: false },
    position: { type: DataTypes.STRING(50), allowNull: false },
    serial_number: { type: DataTypes.STRING(64), allowNull: true },
    tyre_condition: { type: DataTypes.ENUM('new', 'used'), allowNull: false, defaultValue: 'new' },
    unit_cost: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    meter_type: { type: DataTypes.ENUM('KM', 'HOURS'), allowNull: false },
    fitted_at: { type: DataTypes.DATEONLY, allowNull: false },
    fit_meter_reading: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    removed_at: { type: DataTypes.DATEONLY, allowNull: true },
    remove_meter_reading: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    remove_notes: { type: DataTypes.STRING(1000), allowNull: true },
    removed_by: ref('users', true),
    replaced_by_fitment_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    created_by: ref('users'),
    updated_by: ref('users'),
    ...timestamps,
  });
  await queryInterface.addConstraint('tyre_fitments', {
    type: 'foreign key',
    fields: ['replaced_by_fitment_id'],
    name: 'fk_tyre_fitments_replaced_by',
    references: { table: 'tyre_fitments', field: 'id' },
    onUpdate: 'CASCADE',
    onDelete: 'RESTRICT',
  });
  await queryInterface.sequelize.query(
    'ALTER TABLE tyre_fitments ADD COLUMN active_position VARCHAR(50) GENERATED ALWAYS AS (IF(removed_at IS NULL, position, NULL)) STORED'
  );
  await queryInterface.addConstraint('tyre_fitments', { type: 'unique', fields: ['tenant_id', 'asset_type', 'asset_id', 'active_position'], name: 'uq_tyre_fitments_active_position' });
  await queryInterface.addIndex('tyre_fitments', ['tenant_id', 'asset_type', 'asset_id'], { name: 'ix_tyre_fitments_asset' });
  await queryInterface.addIndex('tyre_fitments', ['tenant_id', 'site_id', 'fitted_at'], { name: 'ix_tyre_fitments_site_date' });
  await queryInterface.addIndex('tyre_fitments', ['tenant_id', 'tyre_type_id'], { name: 'ix_tyre_fitments_type' });
}

module.exports = { up, down };
