const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/database');

const EVENT_TYPES = ['purchased', 'added_spare', 'fitted', 'removed', 'puncture', 'remould_sent', 'remould_back', 'scrapped', 'transferred'];
// Events whose amount is money spent on the tyre after buying it.
const REPAIR_EVENTS = ['puncture', 'remould_back'];

const num = (value) => (value == null ? null : Number(value));

class TyreEvent extends Model {
  toPublicJSON() {
    return {
      id: this.id,
      tyreId: this.tyreId,
      eventType: this.eventType,
      eventDate: this.eventDate,
      eventTime: this.eventTime ? String(this.eventTime).slice(0, 5) : null,
      siteId: this.siteId,
      assetType: this.assetType,
      assetId: this.assetId,
      position: this.position,
      meterType: this.meterType,
      meterReading: num(this.meterReading),
      runValue: num(this.runValue),
      amount: num(this.amount),
      vendor: this.vendor,
      notes: this.notes,
      transferId: this.transferId,
      createdBy: this.createdBy,
      createdAt: this.createdAt,
    };
  }
}

TyreEvent.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    tenantId: { type: DataTypes.STRING(64), allowNull: false, references: { model: 'tenants', key: 'tenant_id' } },
    tyreId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, references: { model: 'tyres', key: 'id' } },
    eventType: { type: DataTypes.ENUM(...EVENT_TYPES), allowNull: false },
    eventDate: { type: DataTypes.DATEONLY, allowNull: false },
    eventTime: { type: DataTypes.TIME, allowNull: true },
    siteId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, references: { model: 'sites', key: 'id' } },
    assetType: { type: DataTypes.ENUM('VEHICLE', 'MACHINERY'), allowNull: true },
    assetId: { type: DataTypes.STRING(64), allowNull: true },
    position: { type: DataTypes.STRING(50), allowNull: true },
    meterType: { type: DataTypes.ENUM('KM', 'HOURS'), allowNull: true },
    meterReading: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    runValue: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    amount: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    vendor: { type: DataTypes.STRING(255), allowNull: true },
    notes: { type: DataTypes.STRING(1000), allowNull: true },
    transferId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, references: { model: 'tyre_transfers', key: 'id' } },
    createdBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, references: { model: 'users', key: 'id' } },
  },
  { sequelize, modelName: 'TyreEvent', tableName: 'tyre_events' }
);

TyreEvent.EVENT_TYPES = EVENT_TYPES;
TyreEvent.REPAIR_EVENTS = REPAIR_EVENTS;

module.exports = TyreEvent;
