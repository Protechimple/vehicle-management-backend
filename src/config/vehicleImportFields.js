const Vehicle = require('../models/Vehicle');
const ComplianceDocument = require('../models/ComplianceDocument');

// The one description of the vehicle import sheet. The template, the parser and the preview are all built from it,
// so a field added here appears in the downloaded template and is read from uploaded sheets with no other change.
//
//   key       stable name, also accepted as a column header
//   header    the column header in the template
//   path      where the value goes in the vehicle payload (dots for nesting)
//   kind      text | number | enum | date | site
//   required  true: the column must exist and every row needs a value
//             'LIGHT' / 'HEAVY': needed only for that vehicle type (checked per row)
//   options   the allowed values of an enum
//   help      shown as the header note and on the Instructions sheet

const VEHICLE_IMPORT_FIELDS = Object.freeze([
  { key: 'registrationNumber', header: 'Registration number', path: 'registrationNumber', kind: 'text', required: true, max: 32, help: 'e.g. MH-12 AB 1234. Must not already exist.' },
  { key: 'type', header: 'Type', path: 'type', kind: 'enum', required: true, options: Vehicle.TYPES, help: `${Vehicle.TYPES.join(' or ')}. ${Vehicle.HOURS_BASED_TYPE} is tracked in hours, the other in KM.` },
  { key: 'fuelType', header: 'Fuel type', path: 'fuelType', kind: 'enum', required: true, options: Vehicle.FUEL_TYPES, help: Vehicle.FUEL_TYPES.join(', ') },
  { key: 'modelNumber', header: 'Model number', path: 'modelNumber', kind: 'text', required: false, max: 100, help: 'Optional.' },
  { key: 'chassisNumber', header: 'Chassis number', path: 'chassisNumber', kind: 'text', required: false, max: 100, help: 'Optional. Must not already exist.' },
  { key: 'year', header: 'Year', path: 'year', kind: 'number', required: false, help: 'Optional. Year of manufacture, e.g. 2021.' },
  { key: 'site', header: 'Site', path: 'currentSiteId', kind: 'site', required: false, help: 'Site name, as listed in the dropdown. Leave blank to keep it unassigned (Admin only).' },

  { key: 'currentKM', header: 'Current KM', path: 'currentKM', kind: 'number', required: 'LIGHT', help: 'Light Vehicle only. Odometer reading now.' },
  { key: 'serviceIntervalKM', header: 'Service interval (KM)', path: 'serviceIntervalKM', kind: 'number', required: 'LIGHT', help: 'Light Vehicle only. KM between services.' },
  { key: 'currentHours', header: 'Current hours', path: 'currentHours', kind: 'number', required: 'HEAVY', help: 'Heavy Vehicle only. Hour meter reading now.' },
  { key: 'serviceIntervalHours', header: 'Service interval (hours)', path: 'serviceIntervalHours', kind: 'number', required: 'HEAVY', help: 'Heavy Vehicle only. Hours between services.' },

  { key: 'roadTaxType', header: 'Road tax type', path: 'compliance.roadTax.roadTaxType', kind: 'enum', required: false, options: ComplianceDocument.ROAD_TAX_TYPES, help: `Optional. ${ComplianceDocument.ROAD_TAX_TYPES.join(', ')}.` },
  { key: 'roadTaxExpiry', header: 'Road tax expiry date', path: 'compliance.roadTax.expiryDate', kind: 'date', required: false, help: 'Needed only when Road tax type is OTHER. YYYY-MM-DD.' },
  { key: 'roadTaxNumber', header: 'Road tax number', path: 'compliance.roadTax.documentNumber', kind: 'text', required: false, max: 64, help: 'Optional.' },

  { key: 'nationalPermitExpiry', header: 'National permit expiry date', path: 'compliance.nationalPermit.expiryDate', kind: 'date', required: false, help: 'Optional. YYYY-MM-DD.' },
  { key: 'nationalPermitNumber', header: 'National permit number', path: 'compliance.nationalPermit.documentNumber', kind: 'text', required: false, max: 64, help: 'Optional.' },

  { key: 'insuranceStart', header: 'Insurance start date', path: 'compliance.insurance.startDate', kind: 'date', required: false, help: 'Optional. Give start and end together.' },
  { key: 'insuranceEnd', header: 'Insurance end date', path: 'compliance.insurance.expiryDate', kind: 'date', required: false, help: 'Optional. After the start date.' },
  { key: 'insuranceNumber', header: 'Insurance policy number', path: 'compliance.insurance.documentNumber', kind: 'text', required: false, max: 64, help: 'Optional.' },

  { key: 'statePermitStart', header: 'State permit start date', path: 'compliance.statePermit.startDate', kind: 'date', required: false, help: 'Optional. Give start and end together.' },
  { key: 'statePermitEnd', header: 'State permit end date', path: 'compliance.statePermit.expiryDate', kind: 'date', required: false, help: 'Optional. After the start date.' },
  { key: 'statePermitNumber', header: 'State permit number', path: 'compliance.statePermit.documentNumber', kind: 'text', required: false, max: 64, help: 'Optional.' },

  { key: 'fitnessStart', header: 'Fitness start date', path: 'compliance.fitness.startDate', kind: 'date', required: false, help: 'Optional. Give start and end together.' },
  { key: 'fitnessEnd', header: 'Fitness end date', path: 'compliance.fitness.expiryDate', kind: 'date', required: false, help: 'Optional. After the start date.' },
  { key: 'fitnessNumber', header: 'Fitness certificate number', path: 'compliance.fitness.documentNumber', kind: 'text', required: false, max: 64, help: 'Optional.' },
]);

const MAX_IMPORT_ROWS = 500;

module.exports = { VEHICLE_IMPORT_FIELDS, MAX_IMPORT_ROWS };
