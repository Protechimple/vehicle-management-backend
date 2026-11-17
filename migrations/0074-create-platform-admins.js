const { DataTypes } = require('sequelize');

// Super Admins run the platform itself, so they belong to no tenant and live apart from `users`.
async function up({ context: queryInterface }) {
  await queryInterface.createTable('platform_admins', {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(150), allowNull: false },
    email: { type: DataTypes.STRING(255), allowNull: false },
    password_hash: { type: DataTypes.STRING(255), allowNull: false },
    status: {
      type: DataTypes.ENUM('active', 'inactive'),
      allowNull: false,
      defaultValue: 'active',
    },
    last_login_at: { type: DataTypes.DATE, allowNull: true },
    sessions_revoked_at: { type: DataTypes.DATE(3), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
  });

  await queryInterface.addConstraint('platform_admins', {
    type: 'unique',
    fields: ['email'],
    name: 'uq_platform_admins_email',
  });
}

async function down({ context: queryInterface }) {
  await queryInterface.dropTable('platform_admins');
}

module.exports = { up, down };
