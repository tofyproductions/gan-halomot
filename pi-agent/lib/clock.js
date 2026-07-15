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

  /**
   * READ-ONLY. Return the enrolled fingerprint templates for a single user,
   * matched by `userId` (= Israeli ID) on this device. Each template blob is
   * base64-encoded so it can be shipped to the server and later written to a
   * different branch's device (see the `import_template` command). This does
   * NOT modify the device in any way.
   *
   * ZK protocol: read the fingerprint-template data table via the same
   * chunked mechanism `getUsers()` uses (`readWithBuffer`), but with a request
   * descriptor selecting the FINGERTMP table instead of the USER table. The
   * descriptor is pack('<bhii', 1, command, fct, ext):
   *   - USER  table (getUsers): command=CMD_USERTEMP_RRQ(9), fct=FCT_USER(5)
   *     → bytes 01 09 00 05 00 00 00 00 00 00 00   (== REQUEST_DATA.GET_USERS)
   *   - FINGERTMP table (here): command=CMD_DB_RRQ(7),      fct=FCT_FINGERTMP(2)
   *     → bytes 01 07 00 02 00 00 00 00 00 00 00
   * The returned buffer is a 4-byte total-size header followed by variable
   * length records: size(uint16) uid(uint16) fid(int8) valid(int8) then the
   * template payload of (size-6) bytes. (Constants verified against pyzk.)
   *
   * @param {string} userId - Israeli ID (device userId)
   * @returns {{found:boolean, reason?:string, user?:object, templates?:Array}}
   */
  async getUserTemplates(userId) {
    return this._withConnection(async (zk) => {
      // 1. Map userId (Israeli ID) → the device's internal uid.
      const ures = await zk.getUsers();
      const users = Array.isArray(ures) ? ures : (ures && ures.data) || [];
      const match = users.find(u => String(u.userId) === String(userId));
      if (!match) return { found: false, reason: 'user_not_on_device' };
      const uid = match.uid;

      // 2. Read the whole fingerprint-template table and keep only this uid's.
      // readWithBuffer/freeData live on the transport layer (ztcp/zudp), not
      // on the Zkteco wrapper itself.
      const transport = zk.connectionType === 'udp' ? zk.zudp : zk.ztcp;
      if (transport.socket) { try { await transport.freeData(); } catch (e) { /* noop */ } }
      const REQ = Buffer.from([0x01, 0x07, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
      const res = await transport.readWithBuffer(REQ);
      if (transport.socket) { try { await transport.freeData(); } catch (e) { /* noop */ } }

      const templates = [];
      if (res && res.data instanceof Buffer && res.data.length >= 4) {
        let td = res.data.subarray(4); // skip the 4-byte total-size header
        while (td.length >= 6) {
          const recSize = td.readUInt16LE(0);
          if (recSize < 6 || recSize > td.length) break; // corrupt / end of table
          const recUid = td.readUInt16LE(2);
          const fid = td.readInt8(4);
          const valid = td.readInt8(5);
          const tpl = Buffer.from(td.subarray(6, recSize));
          if (recUid === uid && tpl.length > 0) {
            templates.push({ fid, valid, size: tpl.length, b64: tpl.toString('base64') });
          }
          td = td.subarray(recSize);
        }
      }
      log.info(`getUserTemplates userId=${userId} uid=${uid} fingers=${templates.length}`);
      return { found: true, user: { uid, userId: match.userId, name: match.name }, templates };
    });
  }

  /**
   * WRITE. Enroll fingerprint templates for an EXISTING device user, matched
   * by `userId` (= Israeli ID). The user must already be registered on the
   * device (via `setUser` / the add_user command) — we refuse to create one
   * here so a typo'd ID can't silently mint a ghost user.
   *
   * ZK protocol (mirrors pyzk's HR_save_usertemplates, verified against
   * https://github.com/fananimi/pyzk):
   *   packet = head(12B: uint32 lens of upack/table/fpack)
   *          + upack (73B user record, pack '<BHB8s24sIB7sx24s')
   *          + table (8B per finger: pack '<bHbI' → 2, uid, 0x10+fid, offset)
   *          + fpack (per finger: uint16 size + raw template bytes)
   *   upload: FREE_DATA → PREPARE_DATA(size) → DATA chunks of 1024
   *           → CMD 110 (_CMD_SAVE_USERTEMPS, arg pack '<IHH' 12,0,8)
   *           → REFRESHDATA.
   * Every step must be ACKed with CMD_ACK_OK (2000) or we abort.
   *
   * @param {string} userId - Israeli ID (device userId)
   * @param {Array<{fid:number, b64:string}>} templates
   * @param {string} [name] - display name to (re)write on the user record
   * @returns {{ok:boolean, reason?:string, uid?:number, fingers?:number}}
   */
  async setUserTemplates(userId, templates, name = '') {
    return this._withConnection(async (zk) => {
      const transport = zk.connectionType === 'udp' ? zk.zudp : zk.ztcp;
      const CMD_ACK_OK = 2000, CMD_PREPARE_DATA = 1500, CMD_DATA = 1501;
      const CMD_SAVE_USERTEMPS = 110, CMD_REFRESHDATA = 1013;
      const ackOf = (reply) => (reply && reply.length >= 2 ? reply.readUInt16LE(0) : -1);

      // 1. The user must already exist on the device.
      const ures = await zk.getUsers();
      const users = Array.isArray(ures) ? ures : (ures && ures.data) || [];
      const match = users.find(u => String(u.userId) === String(userId));
      if (!match) return { ok: false, reason: 'user_not_on_device' };
      const uid = match.uid;

      // 2. 73-byte user record. Field layout per pyzk repack73; we preserve
      // the device's existing role/password/card and only refresh the name.
      const upack = Buffer.alloc(73);
      upack.writeUInt8(2, 0);
      upack.writeUInt16LE(uid, 1);
      upack.writeUInt8(match.role || 0, 3);
      Buffer.from(String(match.password || ''), 'utf8').copy(upack, 4, 0, 8);
      Buffer.from(String(name || match.name || ''), 'utf8').copy(upack, 12, 0, 24);
      upack.writeUInt32LE(match.cardno || 0, 36);
      upack.writeUInt8(1, 40);
      // 41..47 group-id string (unused on our devices → zeros), 48 pad
      Buffer.from(String(match.userId), 'ascii').copy(upack, 49, 0, 24);

      // 3. Finger table + packed templates, offsets counted over fpack.
      const list = [...templates].sort((a, b) => a.fid - b.fid);
      const tableParts = [], fpackParts = [];
      let tstart = 0;
      for (const t of list) {
        const tpl = Buffer.from(t.b64, 'base64');
        const rec = Buffer.alloc(2 + tpl.length);
        rec.writeUInt16LE(tpl.length, 0);
        tpl.copy(rec, 2);
        const te = Buffer.alloc(8);
        te.writeUInt8(2, 0);
        te.writeUInt16LE(uid, 1);
        te.writeUInt8(0x10 + t.fid, 3);
        te.writeUInt32LE(tstart, 4);
        tableParts.push(te);
        fpackParts.push(rec);
        tstart += rec.length;
      }
      const table = Buffer.concat(tableParts);
      const fpack = Buffer.concat(fpackParts);
      const head = Buffer.alloc(12);
      head.writeUInt32LE(upack.length, 0);
      head.writeUInt32LE(table.length, 4);
      head.writeUInt32LE(fpack.length, 8);
      const packet = Buffer.concat([head, upack, table, fpack]);

      // 4. Upload + commit. Abort loudly on any non-ACK so a half-written
      // state is impossible (the device only applies on CMD_SAVE_USERTEMPS).
      try { await transport.freeData(); } catch (e) { /* noop */ }
      const sizeBuf = Buffer.alloc(4);
      sizeBuf.writeUInt32LE(packet.length, 0);
      let reply = await transport.executeCmd(CMD_PREPARE_DATA, sizeBuf);
      if (ackOf(reply) !== CMD_ACK_OK) throw new Error(`PREPARE_DATA rejected (code ${ackOf(reply)})`);
      const MAX_CHUNK = 1024;
      for (let off = 0; off < packet.length; off += MAX_CHUNK) {
        reply = await transport.executeCmd(CMD_DATA, packet.subarray(off, Math.min(off + MAX_CHUNK, packet.length)));
        if (ackOf(reply) !== CMD_ACK_OK) throw new Error(`DATA chunk @${off} rejected (code ${ackOf(reply)})`);
      }
      const saveArg = Buffer.alloc(8);
      saveArg.writeUInt32LE(12, 0);
      saveArg.writeUInt16LE(0, 4);
      saveArg.writeUInt16LE(8, 6);
      reply = await transport.executeCmd(CMD_SAVE_USERTEMPS, saveArg);
      if (ackOf(reply) !== CMD_ACK_OK) throw new Error(`SAVE_USERTEMPS rejected (code ${ackOf(reply)})`);
      try { await transport.executeCmd(CMD_REFRESHDATA, ''); } catch (e) { /* device applies anyway */ }

      log.info(`setUserTemplates userId=${userId} uid=${uid} fingers=${list.length} bytes=${packet.length}`);
      return { ok: true, uid, fingers: list.length };
    });
  }
}

module.exports = { Clock };
