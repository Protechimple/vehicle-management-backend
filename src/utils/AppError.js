class AppError extends Error {
  constructor(statusCode, message, code) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    // Optional machine-readable reason, for the client to act on (e.g. PASSWORD_CHANGE_REQUIRED).
    if (code) this.code = code;
    Error.captureStackTrace(this, AppError);
  }

  static badRequest(message) {
    return new AppError(400, message);
  }

  static unauthorized(message = 'Authentication required') {
    return new AppError(401, message);
  }

  static forbidden(message = 'You do not have permission to perform this action', code) {
    return new AppError(403, message, code);
  }

  static notFound(message = 'Resource not found') {
    return new AppError(404, message);
  }

  static conflict(message) {
    return new AppError(409, message);
  }
}

module.exports = AppError;
