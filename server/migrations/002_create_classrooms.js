exports.up = function(knex) {
  return knex.schema.createTable('classrooms', (t) => {
    t.increments('id').primary();
    t.string('name', 100).notNullable();
    t.string('academic_year', 10).notNullable();
    t.integer('capacity');
    t.boolean('is_active').defaultTo(true);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.unique(['name', 'academic_year']);
  });
};

exports.down = function(knex) {
  return knex.schema.dropTableIfExists('classrooms');
};
