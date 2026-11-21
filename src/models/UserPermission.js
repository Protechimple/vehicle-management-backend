const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/database');

// One person's exception to their role's access for one action.
class UserPermission extends Model {}

UserPermission.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    tenantId: { type: DataTypes.STRING(64), allowNull: false },
    userId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    resource: { type: DataTypes.STRING(40), allowNull: false },
    action: { type: DataTypes.STRING(40), allowNull: false },
    allowed: { type: DataTypes.BOOLEAN, allowNull: false },
    updatedBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  },
  { sequelize, modelName: 'UserPermission', tableName: 'user_permissions' }
);

module.exports = UserPermission;
