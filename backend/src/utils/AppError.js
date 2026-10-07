// An Error that carries an HTTP status code (handled by errorHandler.js).
// `details` is optional extra information for the client, for example a list of
// products that are out of stock. Existing code that passes only two arguments is unaffected.
class AppError extends Error {
  constructor(message, statusCode, details) {
    super(message);
    this.statusCode = statusCode;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

module.exports = AppError;
