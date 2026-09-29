const mongoose = require('mongoose');
const env = require('./env');

async function connectDB() {
  try {
    // Bound how long an operation waits for a reachable server. The driver's
    // default is 30s, and with Mongo unreachable a single request was measured
    // taking 60s end to end — long past any browser or proxy giving up, so the
    // user sees a dead tab rather than an error. The other two connections in
    // this codebase already set one (platform/connection.js 8s, jobgan/db.js
    // 20s); 20s matches the more forgiving of them, which is the right side to
    // err on here because this same call gates startup and a slow Atlas
    // handshake at deploy time must not turn into a restart loop.
    await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 20_000 });
    console.log('✅ Connected to MongoDB Atlas');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    process.exit(1);
  }
}

mongoose.connection.on('error', (err) => {
  console.error('MongoDB connection error:', err);
});

mongoose.connection.on('disconnected', () => {
  console.log('MongoDB disconnected');
});

module.exports = { connectDB };
