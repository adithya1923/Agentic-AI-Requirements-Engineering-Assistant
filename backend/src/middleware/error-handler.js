export function notFoundHandler(_request, response) {
  response.status(404).json({ error: { message: 'Route not found', code: 'NOT_FOUND' } });
}

export function errorHandler(error, _request, response, _next) {
  if (response.headersSent) return;

  const databaseUnavailable = error.code === 'DATABASE_UNAVAILABLE'
    || ['ECONNREFUSED', '28P01', '3D000'].includes(error.code)
    || (typeof error.code === 'string' && error.code.startsWith('08'));
  const status = databaseUnavailable ? 503 : (Number.isInteger(error.status) ? error.status : 500);
  const message = databaseUnavailable
    ? 'Database is unavailable'
    : (status >= 500 ? 'An unexpected server error occurred' : error.message);
  if (databaseUnavailable) console.error('Database is unavailable');
  else if (status >= 500) console.error(error);

  response.status(status).json({
    error: {
      message,
      code: databaseUnavailable ? 'DATABASE_UNAVAILABLE' : (error.code || (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR')),
    },
  });
}
