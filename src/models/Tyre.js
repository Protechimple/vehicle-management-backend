const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/database');

// new = New Tyre Store, spare = Spare Tyre Store, remould = away for remoulding / renewal.
const STATUSES = ['new', 'spare', 'fitted', 'remould', 'scrapped'];
const STORED = ['new', 'spare'];
const ASSET_TYPES = ['VEHICLE', 'MACHINERY'];
const METER_TYPES = ['KM', 'HOURS'];

const num = (value) => (value == null ? null : Number(value));

class Tyre extends Model {
  get totalCost() {
    return Math.round((Number(this.purchaseCost) + Number(this.repairCost)) * 100) / 100;
  }

  toPublicJSON() {
    return {
      id: this.id,
      tyreCode: this.tyreCode,
      serialNumber: this.serialNumber,
      tyreTypeId: this.tyreTypeId,
      siteId: this.siteId,
      purchaseId: this.purchaseId,
      purchaseCost: Number(this.purchaseCost),
      status: this.tyreStatus,
      ownerAssetType: this.ownerAssetType,
      ownerAssetId: this.ownerAssetId,
      assetType: this.assetType,
      assetId: this.assetId,
      position: this.position,
      fittedAt: this.fittedAt,
      fittedTime: this.fittedTime ? String(this.fittedTime).slice(0, 5) : null,
      meterType: this.meterType,
      fitReading: num(this.fitReading),
      runKm: Number(this.runKm),
      runHours: Number(this.runHours),
      repairCost: Number(this.repairCost),
      totalCost: this.totalCost,
      scrappedAt: this.scrappedAt,
      scrappedTime: this.scrappedTime ? String(this.scrappedTime).slice(0, 5) : null,
      scrapReason: this.scrapReason,
      scrapValue: num(this.scrapValue),
      notes: this.notes,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}

Tyre.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    tenantId: { type: DataTypes.STRING(64), allowNull: false, references: { model: 'tenants', key: 'tenant_id' } },
    tyreCode: { type: DataTypes.STRING(32), allowNull: false },
    serialNumber: { type: DataTypes.STRING(64), allowNull: true },
    tyreTypeId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, references: { model: 'tyre_types', key: 'id' } },
    siteId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, references: { model: 'sites', key: 'id' } },
    purchaseId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, references: { model: 'tyre_purchases', key: 'id' } },
    purchaseCost: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
    tyreStatus: { type: DataTypes.ENUM(...STATUSES), allowNull: false, defaultValue: 'new' },
    ownerAssetType: { type: DataTypes.ENUM(...ASSET_TYPES), allowNull: true },
    ownerAssetId: { type: DataTypes.STRING(64), allowNull: true },
    assetType: { type: DataTypes.ENUM(...ASSET_TYPES), allowNull: true },
    assetId: { type: DataTypes.STRING(64), allowNull: true },
    position: { type: DataTypes.STRING(50), allowNull: true },
    fittedAt: { type: DataTypes.DATEONLY, allowNull: true },
    fittedTime: { type: DataTypes.TIME, allowNull: true },
    meterType: { type: DataTypes.ENUM(...METER_TYPES), allowNull: true },
    fitReading: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    runKm: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    runHours: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    repairCost: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
    scrappedAt: { type: DataTypes.DATEONLY, allowNull: true },
    scrappedTime: { type: DataTypes.TIME, allowNull: true },
    scrapReason: { type: DataTypes.STRING(500), allowNull: true },
    scrapValue: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    notes: { type: DataTypes.STRING(1000), allowNull: true },
    createdBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, references: { model: 'users', key: 'id' } },
    updatedBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, references: { model: 'users', key: 'id' } },
  },
  { sequelize, modelName: 'Tyre', tableName: 'tyres' }
);

Tyre.STATUSES = STATUSES;
Tyre.STORED = STORED;
Tyre.ASSET_TYPES = ASSET_TYPES;
Tyre.METER_TYPES = METER_TYPES;

module.exports = Tyre;
