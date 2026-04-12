exports.up = function(knex) {
  return knex.schema
    .createTable('archives', (t) => {
      t.increments('id').primary();
      t.integer('registration_id');
      t.enu('archive_type', ['signed', 'unsigned']).notNullable();
      t.jsonb('original_data').notNullable();
      t.string('child_name', 255).notNullable();
      t.string('classroom_name', 100);
      t.string('academic_year', 10);
      t.timestamp('archived_at').defaultTo(knex.fn.now());
      t.integer('archived_by').unsigned().references('id').inTable('users');
      t.timestamp('restored_at');
      t.integer('restored_by').unsigned().references('id').inTable('users');

      t.index('archive_type');
      t.index('academic_year');
    })
    .createTable('collection_history', (t) => {
      t.increments('id').primary();
      t.jsonb('collection_data').notNullable();
      t.string('child_name', 255);
      t.string('academic_year', 10);
      t.timestamp('archived_at').defaultTo(knex.fn.now());
    })
    .createTable('price_adjustments', (t) => {
      t.increments('id').primary();
      t.integer('registration_id').unsigned().references('id').inTable('registrations');
      t.integer('effective_month').notNullable(); // 1-12
      t.decimal('new_monthly_fee', 10, 2).notNullable();
      t.text('reason');
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.integer('created_by').unsigned().references('id').inTable('users');
    })
    .createTable('audit_log', (t) => {
      t.increments('id').primary();
      t.integer('user_id').unsigned().references('id').inTable('users');
      t.string('action', 100).notNullable();
      t.string('entity_type', 50);
      t.integer('entity_id');
      t.jsonb('old_data');
      t.jsonb('new_data');
      t.string('ip_address', 45);
      t.timestamp('created_at').defaultTo(knex.fn.now());

      t.index(['entity_type', 'entity_id']);
    });
};

exports.down = function(knex) {
  return knex.schema
    .dropTableIfExists('audit_log')
    .dropTableIfExists('price_adjustments')
    .dropTableIfExists('collection_history')
    .dropTableIfExists('archives');
};
