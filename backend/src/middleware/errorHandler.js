// Runs when no route matches the request
const notFound = (req, res, next) => {
  const error = new Error(`Route not found: ${req.method} ${req.originalUrl}`);
  error.statusCode = 404;
  next(error);
};

// Central place that turns any error into a JSON response
// (Express recognizes it as an error handler because it has 4 parameters)
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  let statusCode = err.statusCode || 500;
  let message = err.message;

  // Mongoose: an id or value has the wrong format (e.g. "abc" used as an id)
  if (err.name === "CastError") {
    statusCode = 400;
    message = `Invalid value for ${err.path}`;
  }

  // Mongoose: a schema rule failed (required field, min value, ...)
  if (err.name === "ValidationError") {
    statusCode = 400;
    message = Object.values(err.errors)
      .map((fieldError) => fieldError.message)
      .join(". ");
  }

  // MongoDB: a unique value already exists
  if (err.code === 11000) {
    statusCode = 409;
    const field = Object.keys(err.keyValue || {})[0];
    message = field ? `A record with this ${field} already exists` : "Duplicate value";
  }

  if (statusCode === 500) {
    console.error(err);
  }

  res.status(statusCode).json({
    message: statusCode === 500 ? "Internal server error" : message,
  });
};

module.exports = { notFound, errorHandler };
