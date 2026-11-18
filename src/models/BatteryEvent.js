const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/database');

const EVENT_TYPES = ['purchased', 'fitted', 'removed', 'sent_for_repair', 'repaired', 'scrapped'];
const OUTCOMES = ['ready', 'needs_repair', 'scrapped'];

class BatteryEvent extends Model {
  toPublicJSON() {
    return {
      id: this.id,
      batteryId: this.batteryId,
      eventType: this.eventType,
      eventDate: this.eventDate,
      siteId: this.siteId,
      assetType: this.assetType,
      assetId: this.assetId,
      position: this.position,
      meterType: this.meterType,
      meterReading: this.meterReading == null ? null : Number(this.meterReading),
      outcome: this.outcome,
      amount: this.amount == null ? null : Number(this.amount),
      vendor: this.vendor,
      notes: this.notes,
      relatedBatteryId: this.relatedBatteryId,
      createdBy: this.createdBy,
      createdAt: this.createdAt,
    };
  }
}

BatteryEvent.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    tenantId: { type: DataTypes.STRING(64), allowNull: false, references: { model: 'tenants', key: 'tenant_id' } },
    batteryId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, references: { model: 'batteries', key: 'id' } },
    eventType: { type: DataTypes.ENUM(...EVENT_TYPES), allowNull: false },
    eventDate: { type: DataTypes.DATEONLY, allowNull: false },
    siteId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, references: { model: 'sites', key: 'id' } },
    assetType: { type: DataTypes.ENUM('VEHICLE', 'MACHINERY'), allowNull: true },
    assetId: { type: DataTypes.STRING(64), allowNull: true },
    position: { type: DataTypes.STRING(50), allowNull: true },
    meterType: { type: DataTypes.ENUM('KM', 'HOURS'), allowNull: true },
    meterReading: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    outcome: { type: DataTypes.ENUM(...OUTCOMES), allowNull: true },
    amount: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    vendor: { type: DataTypes.STRING(255), allowNull: true },
    notes: { type: DataTypes.STRING(1000), allowNull: true },
    relatedBatteryId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, references: { model: 'batteries', key: 'id' } },
    createdBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, references: { model: 'users', key: 'id' } },
  },
  { sequelize, modelName: 'BatteryEvent', tableName: 'battery_events' }
);

BatteryEvent.EVENT_TYPES = EVENT_TYPES;
BatteryEvent.OUTCOMES = OUTCOMES;

module.exports = BatteryEvent;
