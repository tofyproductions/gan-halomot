/**
 * Thin wrapper around `zkteco-js` for the TIMEDOX TANDEM4 PRO.
 *
 * Known issues from the POC that we compensate for here:
 *   1. `getRealTimeLogs()` doesn't fire callbacks on this firmware → we poll.
 *   2. Historical `getAttendances()` records come back with timestamps of
 *      1999-12-31T22:00:00Z (epoch=0) — the library's decoder is buggy for
 *      this firmware variant. We therefore do NOT trust the `recordTime`
 *      for punches we "discover" via polling; we tag them with the Pi's
 *      current wall-clock time, which is kept in sync via NTP.
 *   3. `getAttendances()` can return inflated / inconsistent counts across
 *      calls. We de-duplicate strictly by `userSn` (the unique record ID)
 *      and track the highest userSn we've ever seen.
 *   4. Names come back mangled in Hebrew. We don't use names at all — we
 *      rely on `userId` (= Israeli ID) stored in the server DB.
 *
 * This module is intentionally single-connection: the agent opens a socket
 * when it wants to poll, does its work, and disconnects. Keeping the socket
 * open across minutes tends to make the device hang on this firmware.
 */
// package.json declares zkteco-js as the runtime dep (better firmware compat
// than node-zklib). We still try node-zklib first as a soft fallback in case
// some Pi was provisioned with the older lib — the field-name normalization
// in getAttendances() below makes the rest of agent.js agnostic to whichever
// one ends up loaded.
let ZKLib;
try { ZKLib = require('zkteco-js'); }
catch { ZKLib = require('node-zklib'); }
const log = require('./logger');

class Clock {
  constructor({ ip, port = 4370, timeoutMs = 10000, inport = 5200 }) {
    this.ip = ip;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.inport = inport;
  }

  async _withConnection(fn) {
    const zk = new ZKLib(this.ip, this.port, this.timeoutMs, this.inport);
    try {
      await zk.createSocket();
      return await fn(zk);
    } finally {
      try { await zk.disconnect(); } catch (e) { /* swallow */ }
    }
  }

  async getInfo() {
    return this._withConnection(async (zk) => {
      const counts = await zk.getInfo().catch(() => null);
      return counts || null;
    });
  }

  /**
   * Return the raw attendance array. Each record is roughly:
   *   { userSn: Number, deviceUserId: String, recordTime: Date, ip: String }
   */
  async getAttendances() {
    return this._withConnection(async (zk) => {
      const result = await zk.getAttendances();
      // The library sometimes returns { data: [...] }, sometimes a raw array.
      let arr;
      if (Array.isArray(result)) arr = result;
      else if (result && Array.isArray(result.data)) arr = result.data;
      else return [];
      // Normalize field names so this works whether the underlying lib is
      // node-zklib (userSn/deviceUserId/recordTime) or zkteco-js
      // (sn/user_id/record_time). The agent's pollPunches filter expects the
      // userSn shape; without this map, fresh punches under zkteco-js are
      // silently dropped (this exact bug took 17.8 days to spot at Moshe Dayan).
      return arr.map(r => ({
        userSn:       typeof r.userSn === 'number' ? r.userSn : r.sn,
        deviceUserId: r.deviceUserId || r.user_id,
        recordTime:   r.recordTime  || r.record_time,
        state:        r.state,
        verifyMode:   typeof r.verifyMode === 'number' ? r.verifyMode : r.type,
        ip:           r.ip,
      }));
    });
  }

  /**
   * Return the user list from the device.
   */
  async getUsers() {
    return this._withConnection(async (zk) => {
      const result = await zk.getUsers();
      if (Array.isArray(result)) return result;
      if (result && Array.isArray(result.data)) return result.data;
      return [];
    });
  }

  /**
   * Register a new user on the device.
   * @param {number} uid - Internal device UID (auto-assign if 0)
   * @param {string} userId - Israeli ID (9 digits)
   * @param {string} name - Display name
   * @param {string} password - Password (optional)
   * @param {number} role - 0=user, 14=admin
   * @param {number} cardno - Card number (optional)
   */
  async setUser(uid, userId, name, password = '', role = 0, cardno = 0) {
    return this._withConnection(async (zk) => {
      log.info(`setUser uid=${uid} userId=${userId} name=${name}`);
      const result = await zk.setUser(uid, userId, name, password, role, cardno);
      log.info(`setUser result: ${JSON.stringify(result)}`);
      return result;
    });
  }

  /**
   * Delete a user from the device by UID.
   * @param {number} uid - Internal device UID
   */
  async deleteUser(uid) {
    return this._withConnection(async (zk) => {
      log.info(`deleteUser uid=${uid}`);
      const result = await zk.deleteUser(uid);
      log.info(`deleteUser result: ${JSON.stringify(result)}`);
      return result;
    });
  }
}

module.exports = { Clock };
