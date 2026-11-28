const multer = require('multer');
const env = require('../config/env');
const AppError = require('../utils/AppError');
const { AssetDocument } = require('../models');

const MAX_FILE_SIZE_BYTES = env.upload.maxFileSizeMB * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png']);

function fileFilter(_req, file, callback) {
  if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
    return callback(AppError.badRequest('Only PDF, JPG and PNG files are accepted'));
  }
  callback(null, true);
}

// Browsers send file names as UTF-8; multer would otherwise read them as Latin-1.
const singleDocumentUpload = multer({
  defParamCharset: 'utf8',
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
  fileFilter,
});

const assetCreationUpload = multer({
  defParamCharset: 'utf8',
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES, files: AssetDocument.DOC_TYPES.length },
  fileFilter,
});

const MAX_LOGO_SIZE_BYTES = 2 * 1024 * 1024;

const LOGO_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

const logoUpload = multer({
  defParamCharset: 'utf8',
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_LOGO_SIZE_BYTES, files: 1 },
  fileFilter(_req, file, callback) {
    if (!LOGO_MIME_TYPES.has(file.mimetype)) {
      return callback(AppError.badRequest('Logo must be a PNG, JPG or WEBP image'));
    }
    callback(null, true);
  },
});

// Spreadsheets for bulk import. Browsers label .csv files inconsistently (text/csv, application/vnd.ms-excel, …),
// so the extension decides; the parser rejects anything that is not really a workbook or CSV.
const SHEET_EXTENSIONS = /\.(xlsx|csv)$/i;

const importSheetUpload = multer({
  defParamCharset: 'utf8',
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
  fileFilter(_req, file, callback) {
    if (!SHEET_EXTENSIONS.test(file.originalname ?? '')) {
      return callback(AppError.badRequest('Only .xlsx and .csv files can be imported'));
    }
    callback(null, true);
  },
});

const PHOTO_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// A photo arrives with the small thumbnail the browser made from it.
const assetPhotoUpload = multer({
  defParamCharset: 'utf8',
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 2 },
  fileFilter(_req, file, callback) {
    if (!PHOTO_MIME_TYPES.has(file.mimetype)) {
      return callback(AppError.badRequest('Photos must be JPG, PNG or WEBP images'));
    }
    callback(null, true);
  },
});

module.exports = {
  uploadImportSheet: importSheetUpload.single('file'),
  uploadAssetPhoto: assetPhotoUpload.fields([
    { name: 'photo', maxCount: 1 },
    { name: 'thumb', maxCount: 1 },
  ]),
  uploadSingleDocument: singleDocumentUpload.single('file'),
  uploadLogo: logoUpload.single('logo'),
  MAX_LOGO_SIZE_BYTES,
  uploadAssetCreationDocuments: assetCreationUpload.fields(
    AssetDocument.DOC_TYPES.map((docType) => ({ name: docType, maxCount: 1 }))
  ),
  MAX_FILE_SIZE_BYTES,
};
