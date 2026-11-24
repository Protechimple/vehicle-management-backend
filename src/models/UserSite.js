const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/database');

// One site a Site Manager covers.
class UserSite extends Model {}

UserSite.init( 
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    tenantId: { type: DataTypes.STRING(64), allowNull: false },
    userId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    siteId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    createdBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  },
  { sequelize, modelName: 'UserSite', tableName: 'user_sites' }
);

module.exports = UserSite;
