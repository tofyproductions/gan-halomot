function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: 'Validation failed',
        details: result.error.errors.map(e => ({ field: e.path.join('.'), message: e.message })),
      });
    }
    req.validatedBody = result.data;
    next();
  };
}

module.exports = { validate };
