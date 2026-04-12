function notFoundHandler(req, res, next) {
  res.status(404).json({ error: 'Route not found', path: req.originalUrl });
}

function errorHandler(err, req, res, _next) {
  console.error('Error:', err.message);
  if (process.env.NODE_ENV !== 'production') console.error(err.stack);

  const status = err.status || 500;
  res.status(status).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
}

module.exports = { notFoundHandler, errorHandler };
