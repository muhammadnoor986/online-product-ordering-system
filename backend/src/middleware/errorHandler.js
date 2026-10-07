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
  const statusCode = err.statusCode || 500;

  if (statusCode === 500) {
    console.error(err);
  }

  res.status(statusCode).json({
    message: statusCode === 500 ? "Internal server error" : err.message,
  });
};

module.exports = { notFound, errorHandler };
