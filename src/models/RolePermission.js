const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/database');

// An organization's choice for one action of one role, where it differs from the built-in rule.
class RolePermission extends Model {}

RolePermission.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    tenantId: { type: DataTypes.STRING(64), allowNull: false },
    role: { type: DataTypes.ENUM('supervisor', 'site_manager', 'inventory_supervisor'), allowNull: false },
    resource: { type: DataTypes.STRING(40), allowNull: false },
    action: { type: DataTypes.STRING(40), allowNull: false },
    allowed: { type: DataTypes.BOOLEAN, allowNull: false },
    updatedBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  },
  { sequelize, modelName: 'RolePermission', tableName: 'role_permissions' }
);

module.exports = RolePermission;
