exports.up = function(knex) {
  return knex.schema.createTable('users', (t) => {
    t.increments('id').primary();
    t.string('email', 255).unique().notNullable();
    t.string('password_hash', 255).notNullable();
    t.string('full_name', 255).notNullable();
    t.string('role', 50).defaultTo('admin');
    t.timestamps(true, true);
  });
};

exports.down = function(knex) {
  return knex.schema.dropTableIfExists('users');
};
