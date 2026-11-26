const path = require('node:path');
const { Readable } = require('node:stream');
const ExcelJS = require('exceljs');
const { Op } = require('sequelize');

const { sequelize, Vehicle, Machinery, Site } = require('../models');
const AppError = require('../utils/AppError');
const { VEHICLE_IMPORT_FIELDS, MAX_IMPORT_ROWS } = require('../config/vehicleImportFields');
const { allowedSiteIds, includesSite } = require('./siteAccess');
const { validateVehicleCandidate, insertVehicle } = require('./vehicle.service');

const SHEET_NAME = 'Vehicles';
const LISTS_SHEET_NAME = 'Lists';
const TEMPLATE_ROWS = MAX_IMPORT_ROWS + 1;

// "Registration number *", "registration_number" and "registrationNumber" all name the same column.
function normaliseHeader(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

const FIELD_BY_HEADER = new Map(
  VEHICLE_IMPORT_FIELDS.flatMap((field) => [
    [normaliseHeader(field.header), field],
    [normaliseHeader(field.key), field],
  ])
);

function headerLabel(field) {
  return field.required === true ? `${field.header} *` : field.header;
}

function columnLetter(index) {
  let letter = '';
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) {
    letter = String.fromCharCode(65 + ((n - 1) % 26)) + letter;
  }
  return letter;
}

// The sites a user may place a vehicle at: every active site for the Admin, otherwise their own active sites.
async function assignableSites(tenantId, auth) {
  const ownSiteIds = allowedSiteIds(auth);
  const where = { tenantId, status: 'active' };
  if (ownSiteIds !== null) where.id = { [Op.in]: ownSiteIds };
  return Site.findAll({ where, order: [['name', 'ASC']], attributes: ['id', 'name'] });
}

// ---------------------------------------------------------------- template

async function buildTemplate({ tenantId, auth }) {
  const sites = await assignableSites(tenantId, auth);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'VMMS';

  const sheet = workbook.addWorksheet(SHEET_NAME, { views: [{ state: 'frozen', ySplit: 1 }] });
  const lists = workbook.addWorksheet(LISTS_SHEET_NAME, { state: 'hidden' });
  const instructions = workbook.addWorksheet('Instructions');

  sheet.columns = VEHICLE_IMPORT_FIELDS.map((field) => ({
    header: headerLabel(field),
    key: field.key,
    width: Math.max(16, field.header.length + 4),
    style: field.kind === 'date' ? { numFmt: 'yyyy-mm-dd' } : field.kind === 'text' ? { numFmt: '@' } : {},
  }));
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.eachCell((cell, colNumber) => {
    const field = VEHICLE_IMPORT_FIELDS[colNumber - 1];
    cell.note = field.help;
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: field.required === true ? 'FFFDE68A' : 'FFE5E7EB' },
    };
  });

  // Each dropdown reads its values from a column of the hidden Lists sheet.
  let listColumn = 0;
  VEHICLE_IMPORT_FIELDS.forEach((field, index) => {
    const values = field.kind === 'enum' ? field.options : field.kind === 'site' ? sites.map((s) => s.name) : null;
    if (!values || values.length === 0) return;

    listColumn += 1;
    const letter = columnLetter(listColumn);
    lists.getCell(`${letter}1`).value = field.header;
    values.forEach((value, i) => {
      lists.getCell(`${letter}${i + 2}`).value = value;
    });

    const target = columnLetter(index + 1);
    sheet.dataValidations.add(`${target}2:${target}${TEMPLATE_ROWS}`, {
      type: 'list',
      allowBlank: true,
      showErrorMessage: true,
      errorTitle: field.header,
      error: `Pick a value from the list for ${field.header}.`,
      formulae: [`${LISTS_SHEET_NAME}!$${letter}$2:$${letter}$${values.length + 1}`],
    });
  });

  instructions.columns = [
    { header: 'Column', key: 'header', width: 30 },
    { header: 'Required', key: 'required', width: 22 },
    { header: 'How to fill', key: 'help', width: 80 },
  ];
  instructions.getRow(1).font = { bold: true };
  for (const field of VEHICLE_IMPORT_FIELDS) {
    instructions.addRow({
      header: field.header,
      required:
        field.required === true ? 'Yes' : field.required === 'LIGHT' ? 'Light Vehicle' : field.required === 'HEAVY' ? 'Heavy Vehicle' : 'No',
      help: field.help,
    });
  }
  instructions.addRow({});
  instructions.addRow({ header: 'Notes' }).font = { bold: true };
  for (const note of [
    `Fill one vehicle per row on the "${SHEET_NAME}" sheet, starting at row 2. At most ${MAX_IMPORT_ROWS} rows per file.`,
    'Columns marked * must be present. Columns may be in any order; extra columns are ignored.',
    'Dates as YYYY-MM-DD (DD-MM-YYYY and DD/MM/YYYY are also accepted).',
    'Documents (RC, PUC, …) and photos are uploaded on each vehicle’s page after the import.',
    'Nothing is saved until every row is valid.',
  ]) {
    instructions.addRow({ header: '', required: '', help: note });
  }

  return workbook.xlsx.writeBuffer();
}

// ---------------------------------------------------------------- parsing

function plainCellValue(value) {
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join('');
    if ('result' in value) return plainCellValue(value.result);
    if ('text' in value) return value.text;
    if ('error' in value) return null;
    return null;
  }
  return value;
}

const pad = (n) => String(n).padStart(2, '0');

// Excel keeps dates as UTC midnights (or as day serial numbers); people also type them as text.
function toDateOnly(value) {
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  }
  if (typeof value === 'number' && value > 0 && value < 2958466) {
    return toDateOnly(new Date(Math.round((value - 25569) * 86400000)));
  }
  const text = String(value).trim();
  const dayFirst = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text);
  if (dayFirst) return `${dayFirst[3]}-${pad(dayFirst[2])}-${pad(dayFirst[1])}`;
  const yearFirst = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
  if (yearFirst) return `${yearFirst[1]}-${pad(yearFirst[2])}-${pad(yearFirst[3])}`;
  return text;
}

function setPath(target, dottedPath, value) {
  const parts = dottedPath.split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) {
    node[part] ??= {};
    node = node[part];
  }
  node[parts.at(-1)] = value;
}

function isBlank(value) {
  return value == null || (typeof value === 'string' && value.trim() === '');
}

async function loadWorksheet(file) {
  const workbook = new ExcelJS.Workbook();
  const isCsv = file.mimetype === 'text/csv' || path.extname(file.originalname ?? '').toLowerCase() === '.csv';
  try {
    if (isCsv) {
      // Values are read as text so a registration like 0012 or a date stays as typed.
      await workbook.csv.read(Readable.from(file.buffer), { map: (value) => value });
    } else {
      await workbook.xlsx.load(file.buffer);
    }
  } catch {
    throw AppError.badRequest('The file could not be read. Upload the .xlsx template or a .csv file.');
  }
  const sheet = workbook.getWorksheet(SHEET_NAME) ?? workbook.worksheets[0];
  if (!sheet) throw AppError.badRequest('The file has no sheets');
  return sheet;
}

// Reads the sheet into raw rows: { rowNumber, values (by field key, for display), payload (vehicle shape) }.
async function parseSheet(file, sites) {
  const sheet = await loadWorksheet(file);
  const warnings = [];

  const columns = new Map(); // column number → field
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const raw = plainCellValue(cell.value);
    if (isBlank(raw)) return;
    const field = FIELD_BY_HEADER.get(normaliseHeader(raw));
    if (!field) {
      warnings.push(`Column "${raw}" is not a vehicle field and was ignored`);
    } else if ([...columns.values()].includes(field)) {
      warnings.push(`Column "${raw}" appears twice; only the first is used`);
    } else {
      columns.set(colNumber, field);
    }
  });

  const present = new Set(columns.values());
  const missing = VEHICLE_IMPORT_FIELDS.filter((field) => field.required === true && !present.has(field));
  if (missing.length > 0) {
    throw AppError.badRequest(
      `The sheet is missing required column${missing.length > 1 ? 's' : ''}: ${missing.map((f) => f.header).join(', ')}. Download the template to see the expected columns.`
    );
  }

  const siteByName = new Map(sites.map((site) => [site.name.trim().toLowerCase(), site]));
  const rows = [];

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;

    const values = {};
    const payload = {};
    const rowErrors = [];
    let hasValue = false;

    for (const [colNumber, field] of columns) {
      const raw = plainCellValue(row.getCell(colNumber).value);
      if (isBlank(raw)) continue;
      hasValue = true;

      let value;
      if (field.kind === 'date') {
        value = toDateOnly(raw);
      } else if (field.kind === 'number') {
        value = typeof raw === 'number' ? raw : String(raw).trim().replace(/,/g, '');
      } else if (field.kind === 'enum') {
        const text = String(raw).trim();
        value = field.options.find((option) => option.toLowerCase() === text.toLowerCase()) ?? text;
      } else if (field.kind === 'site') {
        const name = String(raw).trim();
        const site = siteByName.get(name.toLowerCase());
        values[field.key] = name;
        if (site) {
          setPath(payload, field.path, site.id);
        } else {
          rowErrors.push({ field: field.key, message: `Site "${name}" was not found among the sites you can use` });
        }
        continue;
      } else {
        value = raw instanceof Date ? toDateOnly(raw) : String(raw).trim();
      }

      values[field.key] = value;
      setPath(payload, field.path, value);
    }

    if (hasValue) rows.push({ rowNumber, values, payload, rowErrors });
  });

  if (rows.length === 0) throw AppError.badRequest('The sheet has no vehicle rows. Fill the template from row 2.');
  if (rows.length > MAX_IMPORT_ROWS) {
    throw AppError.badRequest(`The sheet has ${rows.length} rows; at most ${MAX_IMPORT_ROWS} can be imported at once`);
  }

  return { columns: [...present].map((field) => field.key), warnings, rows };
}

// ---------------------------------------------------------------- validation

const identity = (value) => String(value).trim().toUpperCase();

function groupRowsBy(rows, pick) {
  const groups = new Map();
  for (const row of rows) {
    const value = pick(row);
    if (!value) continue;
    const key = identity(value);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return groups;
}

async function takenIdentifiers(rows) {
  const registrations = [...new Set(rows.map((r) => r.input.registrationNumber).filter(Boolean))];
  const chassis = [...new Set(rows.map((r) => r.input.chassisNumber).filter(Boolean))];

  // Like assetIdentifier.service, uniqueness covers every vehicle and machine.
  const [byRegistration, vehiclesByChassis, machinesBySerial] = await Promise.all([
    registrations.length
      ? Vehicle.findAll({ where: { registrationNumber: registrations }, attributes: ['registrationNumber'] })
      : [],
    chassis.length ? Vehicle.findAll({ where: { chassisNumber: chassis }, attributes: ['chassisNumber'] }) : [],
    chassis.length ? Machinery.findAll({ where: { serialNumber: chassis }, attributes: ['serialNumber'] }) : [],
  ]);

  return {
    registrations: new Set(byRegistration.map((v) => identity(v.registrationNumber))),
    chassis: new Set([
      ...vehiclesByChassis.map((v) => identity(v.chassisNumber)),
      ...machinesBySerial.map((m) => identity(m.serialNumber)),
    ]),
  };
}

async function validateSheet({ tenantId, auth, file }) {
  const sites = await assignableSites(tenantId, auth);
  const parsed = await parseSheet(file, sites);
  const ownSiteIds = allowedSiteIds(auth);

  const rows = parsed.rows.map((row) => {
    const { input, compliance, errors } = validateVehicleCandidate(row.payload, auth);
    const rowErrors = [...row.rowErrors];
    for (const error of errors) {
      // A bad site name is already reported; the "choose a site" message that follows from it is noise.
      if (error.field === 'currentSiteId' && rowErrors.some((e) => e.field === 'site')) continue;
      rowErrors.push(error.field === 'currentSiteId' ? { ...error, field: 'site' } : error);
    }
    // A single-site user's vehicles always go to their site, so naming another site is a mistake worth reporting.
    const requestedSiteId = row.payload.currentSiteId;
    if (ownSiteIds !== null && requestedSiteId != null && !includesSite(ownSiteIds, requestedSiteId)) {
      rowErrors.push({ field: 'site', message: 'You can only add vehicles to your own sites' });
    }
    return { rowNumber: row.rowNumber, values: row.values, input, compliance, errors: rowErrors };
  });

  const markDuplicates = (field, label) => {
    for (const group of groupRowsBy(rows, (r) => r.input[field]).values()) {
      if (group.length < 2) continue;
      const rowNumbers = group.map((r) => r.rowNumber).join(', ');
      for (const row of group) {
        row.errors.push({ field, message: `${label} appears more than once in this sheet (rows ${rowNumbers})` });
      }
    }
  };
  markDuplicates('registrationNumber', 'Registration number');
  markDuplicates('chassisNumber', 'Chassis number');

  const taken = await takenIdentifiers(rows);
  for (const row of rows) {
    if (row.input.registrationNumber && taken.registrations.has(identity(row.input.registrationNumber))) {
      row.errors.push({ field: 'registrationNumber', message: 'This registration number is already in use by another asset' });
    }
    if (row.input.chassisNumber && taken.chassis.has(identity(row.input.chassisNumber))) {
      row.errors.push({ field: 'chassisNumber', message: 'This chassis number is already in use by another asset' });
    }
  }

  const invalid = rows.filter((row) => row.errors.length > 0).length;
  return {
    columns: parsed.columns,
    warnings: parsed.warnings,
    rows,
    summary: { total: rows.length, valid: rows.length - invalid, invalid },
  };
}

function toPreview(result) {
  return {
    columns: result.columns,
    warnings: result.warnings,
    summary: result.summary,
    rows: result.rows.map(({ rowNumber, values, errors }) => ({ rowNumber, values, errors })),
  };
}

async function previewImport({ tenantId, auth, file }) {
  if (!file) throw AppError.badRequest('Choose a file to upload');
  return toPreview(await validateSheet({ tenantId, auth, file }));
}

// All or nothing: the sheet is checked again, and the vehicles are created in one transaction only if every row is valid.
async function commitImport({ tenantId, auth, actingUserId, file }) {
  if (!file) throw AppError.badRequest('Choose a file to upload');
  const result = await validateSheet({ tenantId, auth, file });
  if (result.summary.invalid > 0) return { ok: false, preview: toPreview(result) };

  const created = await sequelize.transaction(async (transaction) => {
    const vehicles = [];
    for (const row of result.rows) {
      vehicles.push(
        await insertVehicle({ tenantId, actingUserId, input: row.input, compliance: row.compliance, transaction })
      );
    }
    return vehicles;
  });

  return {
    ok: true,
    created: created.length,
    vehicles: created.map((vehicle) => ({ id: vehicle.id, assetId: vehicle.assetId, registrationNumber: vehicle.registrationNumber })),
  };
}

module.exports = { buildTemplate, previewImport, commitImport };
