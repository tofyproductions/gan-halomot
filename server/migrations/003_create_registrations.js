exports.up = function(knex) {
  return knex.schema.createTable('registrations', (t) => {
    t.increments('id').primary();
    t.string('unique_id', 50).unique().notNullable();
    t.string('child_name', 255).notNullable();
    t.date('child_birth_date');
    t.integer('classroom_id').unsigned().references('id').inTable('classrooms');
    t.string('parent_name', 255).notNullable();
    t.string('parent_id_number', 20);
    t.string('parent_phone', 20);
    t.string('parent_email', 255);
    t.decimal('monthly_fee', 10, 2).notNullable();
    t.decimal('registration_fee', 10, 2).defaultTo(0);
    t.date('start_date').notNullable();
    t.date('end_date').notNullable();
    t.enu('status', ['link_generated', 'contract_signed', 'docs_uploaded', 'completed', 'cancelled'])
      .defaultTo('link_generated');
    t.boolean('agreement_signed').defaultTo(false);
    t.boolean('card_completed').defaultTo(false);
    t.jsonb('configuration').defaultTo('{}');
    t.string('access_token', 255);
    t.timestamp('token_expires_at');
    t.text('signature_data'); // base64 signature image
    t.string('contract_pdf_path', 500);
    t.timestamps(true, true);

    t.index('classroom_id');
    t.index('status');
    t.index('access_token');
  });
};

exports.down = function(knex) {
  return knex.schema.dropTableIfExists('registrations');
};
