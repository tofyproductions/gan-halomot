exports.up = function(knex) {
  return knex.schema.createTable('children', (t) => {
    t.increments('id').primary();
    t.integer('registration_id').unsigned().references('id').inTable('registrations').onDelete('SET NULL');
    t.string('child_name', 255).notNullable();
    t.date('birth_date');
    t.integer('classroom_id').unsigned().references('id').inTable('classrooms');
    t.string('parent_name', 255).notNullable();
    t.string('phone', 20);
    t.string('email', 255);
    t.text('medical_alerts');
    t.boolean('is_active').defaultTo(true);
    t.string('academic_year', 10).notNullable();
    t.timestamps(true, true);

    t.index('classroom_id');
    t.index('academic_year');
    t.index('registration_id');
  });
};

exports.down = function(knex) {
  return knex.schema.dropTableIfExists('children');
};
