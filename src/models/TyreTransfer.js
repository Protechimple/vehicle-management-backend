const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/database');

class TyreTransfer extends Model {
  toPublicJSON() {
    return {
      id: this.id,
      transferNumber: this.transferNumber,
      fromSiteId: this.fromSiteId,
      toSiteId: this.toSiteId,
      transferDate: this.transferDate,
      transferTime: this.transferTime ? String(this.transferTime).slice(0, 5) : null,
      tyreCount: Number(this.tyreCount),
      notes: this.notes,
      createdBy: this.createdBy,
      createdAt: this.createdAt,
    };
  }
}

TyreTransfer.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    tenantId: { type: DataTypes.STRING(64), allowNull: false, references: { model: 'tenants', key: 'tenant_id' } },
    transferNumber: { type: DataTypes.STRING(32), allowNull: false },
    fromSiteId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, references: { model: 'sites', key: 'id' } },
    toSiteId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, references: { model: 'sites', key: 'id' } },
    transferDate: { type: DataTypes.DATEONLY, allowNull: false },
    transferTime: { type: DataTypes.TIME, allowNull: true },
    tyreCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    notes: { type: DataTypes.STRING(1000), allowNull: true },
    createdBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, references: { model: 'users', key: 'id' } },
  },
  { sequelize, modelName: 'TyreTransfer', tableName: 'tyre_transfers' }
);

module.exports = TyreTransfer;
