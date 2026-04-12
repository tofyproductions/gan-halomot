exports.up = function(knex) {
  return knex.schema
    .createTable('collections', (t) => {
      t.increments('id').primary();
      t.integer('registration_id').unsigned().references('id').inTable('registrations').onDelete('CASCADE');
      t.integer('child_id').unsigned().references('id').inTable('children').onDelete('SET NULL');
      t.string('academic_year', 10).notNullable();
      t.decimal('registration_fee_receipt', 10, 2).defaultTo(0);
      t.integer('exit_month'); // 1-12, month child left (null = active)
      t.text('notes');
      t.timestamp('last_updated').defaultTo(knex.fn.now());

      t.unique(['registration_id', 'academic_year']);
      t.index('academic_year');
    })
    .createTable('collection_months', (t) => {
      t.increments('id').primary();
      t.integer('collection_id').unsigned().references('id').inTable('collections').onDelete('CASCADE');
      t.integer('month_number').notNullable(); // 1=Jan...12=Dec (actual calendar month)
      t.decimal('expected_amount', 10, 2).defaultTo(0);
      t.decimal('paid_amount', 10, 2).defaultTo(0);
      t.string('receipt_number', 50);
      t.enu('payment_status', ['pending', 'expected', 'paid', 'partial', 'exempt', 'overdue'])
        .defaultTo('pending');
      t.date('payment_date');
      t.boolean('is_prorated').defaultTo(false);
      t.text('notes');

      t.unique(['collection_id', 'month_number']);
      t.index('collection_id');
    });
};

exports.down = function(knex) {
  return knex.schema
    .dropTableIfExists('collection_months')
    .dropTableIfExists('collections');
};
