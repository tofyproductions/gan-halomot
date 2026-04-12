exports.seed = async function(knex) {
  // Clear existing classrooms
  await knex('classrooms').del();

  // Seed default classrooms for current academic year
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const startYear = (month > 8 || (month === 8 && now.getDate() >= 10)) ? year : year - 1;
  const acadYear = `${startYear}-${startYear + 1}`;

  const classNames = ['תינוקייה א', 'תינוקייה ב', 'צעירים', 'בוגרים'];

  await knex('classrooms').insert(
    classNames.map(name => ({ name, academic_year: acadYear, capacity: 35, is_active: true }))
  );
};
