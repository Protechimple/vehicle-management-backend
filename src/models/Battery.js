const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/database');

const STATUSES = ['ready', 'fitted', 'needs_repair', 'scrapped'];
const ASSET_TYPES = ['VEHICLE', 'MACHINERY'];

function addMonths(dateOnly, months) {
  const [year, month, day] = String(dateOnly).split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

class Battery extends Model {
  get warrantyUntil() {
    if (!this.warrantyMonths || !this.purchaseDate) return null;
    return addMonths(this.purchaseDate, Number(this.warrantyMonths));
  }

  toPublicJSON() {
    return {
      id: this.id,
      batteryCode: this.batteryCode,
      serialNumber: this.serialNumber,
      brand: this.brand,
      modelName: this.modelName,
      capacityAh: this.capacityAh == null ? null : Number(this.capacityAh),
      voltage: this.voltage == null ? null : Number(this.voltage),
      purchaseDate: this.purchaseDate,
      supplierName: this.supplierName,
      invoiceNumber: this.invoiceNumber,
      purchaseCost: Number(this.purchaseCost),
      warrantyMonths: this.warrantyMonths == null ? null : Number(this.warrantyMonths),
      warrantyUntil: this.warrantyUntil,
      siteId: this.siteId,
      status: this.batteryStatus,
      assetType: this.assetType,
      assetId: this.assetId,
      position: this.position,
      fittedAt: this.fittedAt,
      scrappedAt: this.scrappedAt,
      scrapReason: this.scrapReason,
      notes: this.notes,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}

Battery.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    tenantId: { type: DataTypes.STRING(64), allowNull: false, references: { model: 'tenants', key: 'tenant_id' } },
    batteryCode: { type: DataTypes.STRING(32), allowNull: false },
    serialNumber: { type: DataTypes.STRING(64), allowNull: false },
    brand: { type: DataTypes.STRING(100), allowNull: false },
    modelName: { type: DataTypes.STRING(100), allowNull: true },
    capacityAh: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    voltage: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    purchaseDate: { type: DataTypes.DATEONLY, allowNull: false },
    supplierName: { type: DataTypes.STRING(255), allowNull: true },
    invoiceNumber: { type: DataTypes.STRING(64), allowNull: true },
    purchaseCost: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
    warrantyMonths: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true },
    siteId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, references: { model: 'sites', key: 'id' } },
    batteryStatus: { type: DataTypes.ENUM(...STATUSES), allowNull: false, defaultValue: 'ready' },
    assetType: { type: DataTypes.ENUM(...ASSET_TYPES), allowNull: true },
    assetId: { type: DataTypes.STRING(64), allowNull: true },
    position: { type: DataTypes.STRING(50), allowNull: true },
    fittedAt: { type: DataTypes.DATEONLY, allowNull: true },
    scrappedAt: { type: DataTypes.DATEONLY, allowNull: true },
    scrapReason: { type: DataTypes.STRING(500), allowNull: true },
    notes: { type: DataTypes.STRING(1000), allowNull: true },
    createdBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, references: { model: 'users', key: 'id' } },
    updatedBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, references: { model: 'users', key: 'id' } },
  },
  { sequelize, modelName: 'Battery', tableName: 'batteries' }
);

Battery.STATUSES = STATUSES;
Battery.ASSET_TYPES = ASSET_TYPES;
Battery.addMonths = addMonths;

module.exports = Battery;
