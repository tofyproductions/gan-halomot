const mongoose = require('mongoose');

const employerSchema = require('./models/Employer');
const jobSchema = require('./models/Job');
const seekerSchema = require('./models/Seeker');
const applicationSchema = require('./models/Application');

/**
 * ג׳וב חלום's own database, on its own connection.
 *
 * SEPARATE, AND NOT AS A TIDINESS PREFERENCE. This service is public: no login
 * to reach the board, traffic arriving from paid campaigns, and personal
 * details of people who are not anybody's customer. גן החלומות is four
 * branches of real families on the other server. A hole here must not be a
 * route to there, so the candidates' database does not sit beside a database
 * of children, and this process does not hold a handle to one.
 *
 * The guard below is the mechanical half of that promise.
 */

let conn = null;
let models = null;

/**
 * Refuse to start against anything that is not plainly this service's database.
 *
 * The connection string for production differs from this one by a few
 * characters, and a paste error would point the whole jobs board at the gan's
 * records — and it would LOOK fine, because mongoose creates collections on
 * demand. So the name is checked, not assumed.
 *
 * `JOBGAN_MONGODB_URI` is also a distinct variable name from MONGODB_URI and
 * PLATFORM_MONGODB_URI for the same reason: nothing is inherited by accident.
 */
function assertOwnDatabase(uri) {
  const m = uri.match(/^mongodb(?:\+srv)?:\/\/[^/?]+\/([^?]+)/);
  const dbName = m && m[1];
  if (!dbName) {
    throw new Error('JOBGAN_MONGODB_URI חייב לכלול שם מסד נתונים אחרי הסלאש.');
  }
  if (!/jobgan/i.test(dbName)) {
    throw new Error(
      `שם מסד היעד הוא "${dbName}" ואינו מכיל "jobgan". מסרב לעלות — `
      + 'זה עלול להיות המסד של גן החלומות או של לקוח.',
    );
  }
  if (process.env.MONGODB_URI && uri.trim() === process.env.MONGODB_URI.trim()) {
    throw new Error('JOBGAN_MONGODB_URI זהה ל-MONGODB_URI. זה המסד של הגן. מסרב לעלות.');
  }
  return dbName;
}

async function connect() {
  if (conn) return { conn, models };

  const uri = process.env.JOBGAN_MONGODB_URI;
  if (!uri) throw new Error('חסר JOBGAN_MONGODB_URI.');

  const dbName = assertOwnDatabase(uri);

  conn = await mongoose.createConnection(uri, {
    serverSelectionTimeoutMS: 20000,
  }).asPromise();

  models = {
    Employer:    conn.model('Employer', employerSchema),
    Job:         conn.model('Job', jobSchema),
    Seeker:      conn.model('Seeker', seekerSchema),
    Application: conn.model('Application', applicationSchema),
  };

  console.log(`[jobgan] מחובר למסד "${dbName}"`);
  return { conn, models };
}

function getModels() {
  if (!models) throw new Error('[jobgan] אין חיבור למסד. connect() לא נקרא.');
  return models;
}

async function close() {
  if (conn) { await conn.close(); conn = null; models = null; }
}

module.exports = { connect, getModels, close, assertOwnDatabase };
