// External vehicle fuel: the optional "Vehicle type" field became "Vehicle name" (2026-11-07). Values are kept.
async function up({ context: queryInterface }) {
  await queryInterface.renameColumn('external_fuel_entries', 'vehicle_type', 'vehicle_name');
}

async function down({ context: queryInterface }) {
  await queryInterface.renameColumn('external_fuel_entries', 'vehicle_name', 'vehicle_type');
}

module.exports = { up, down };
