exports.up = function(knex) {
  return knex.schema.createTable('documents', (t) => {
    t.increments('id').primary();
    t.integer('registration_id').unsigned().references('id').inTable('registrations');
    t.integer('child_id').unsigned().references('id').inTable('children');
    t.string('doc_type', 50).notNullable(); // 'contract', 'id_copy', 'payment_proof'
    t.string('file_name', 255).notNullable();
    t.string('file_path', 500).notNullable(); // R2 key
    t.string('mime_type', 100);
    t.bigInteger('file_size_bytes');
    t.timestamp('uploaded_at').defaultTo(knex.fn.now());

    t.index('registration_id');
  });
};

exports.down = function(knex) {
  return knex.schema.dropTableIfExists('documents');
};
