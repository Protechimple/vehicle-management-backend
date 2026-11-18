const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/database');

const PLATFORM_ADMIN_STATUSES = ['active', 'inactive'];
const SUPER_ADMIN_ROLE = 'super_admin';

class PlatformAdmin extends Model {
  get isActive() {
    return this.status === 'active';
  }

  toPublicJSON() {
    return {
      id: this.id,
      name: this.name,
      email: this.email,
      role: SUPER_ADMIN_ROLE,
      status: this.status,
      lastLoginAt: this.lastLoginAt,
      createdAt: this.createdAt,
    };
  }
}

PlatformAdmin.init(
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      primaryKey: true,
      autoIncrement: true,
    },
    name: {
      type: DataTypes.STRING(150),
      allowNull: false,
    },
    email: {
      type: DataTypes.STRING(255),
      allowNull: false,
      unique: true,
    },
    passwordHash: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM(...PLATFORM_ADMIN_STATUSES),
      allowNull: false,
      defaultValue: 'active',
    },
    lastLoginAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    sessionsRevokedAt: {
      type: DataTypes.DATE(3),
      allowNull: true,
    },
  },
  {
    sequelize,
    modelName: 'PlatformAdmin',
    tableName: 'platform_admins',
    defaultScope: {
      attributes: { exclude: ['passwordHash'] },
    },
    scopes: {
      withPassword: { attributes: { include: ['passwordHash'] } },
    },
  }
);

PlatformAdmin.STATUSES = PLATFORM_ADMIN_STATUSES;
PlatformAdmin.ROLE = SUPER_ADMIN_ROLE;

module.exports = PlatformAdmin;
