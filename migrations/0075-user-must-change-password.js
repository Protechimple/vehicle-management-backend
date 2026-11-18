const { DataTypes } = require('sequelize');

// Set when a Super Admin hands out a temporary password; cleared once the user picks their own.
async function up({ context: queryInterface }) {
  await queryInterface.addColumn('users', 'must_change_password', {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    after: 'sessions_revoked_at',
  });
}

async function down({ context: queryInterface }) {
  await queryInterface.removeColumn('users', 'must_change_password');
}

module.exports = { up, down };
