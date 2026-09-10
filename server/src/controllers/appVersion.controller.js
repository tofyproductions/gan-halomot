const { Setting } = require('../models');

/**
 * Which version of the mobile apps is live in the stores.
 *
 * The web app can tell a running tab it is stale on its own: every build
 * stamps itself and emits that stamp beside the bundle, the page compares the
 * two and offers a reload (client/vite.config.js). Nothing on a phone can do
 * that — an installed App Store or Play build ships its own copy of the whole
 * front end, and no amount of reloading turns build 6 into build 7. The only
 * honest thing to say there is "there is a newer version, here is the store".
 *
 * Which means somebody has to say so. Store review takes days and is outside
 * anyone's control here, so this cannot be derived from a deploy: it is typed
 * in by a system_admin once Apple or Google approve a build. Until it is
 * filled in the field is empty, and an empty field shows nobody anything —
 * silence is the correct behaviour for "we do not know", and a wrong claim
 * that an update exists sends every parent to a store page that offers them
 * nothing.
 *
 * Read anonymously. The app asks before anybody signs in, and a version number
 * published in two public stores is not a secret.
 */

const KEY = 'app_store_versions';

const EMPTY = {
  ios: { version: '', url: '' },
  android: { version: '', url: '' },
};

async function readVersions() {
  const doc = await Setting.findOne({ key: KEY }).lean();
  const v = doc?.value || {};
  return {
    ios: { version: String(v.ios?.version || ''), url: String(v.ios?.url || '') },
    android: { version: String(v.android?.version || ''), url: String(v.android?.url || '') },
  };
}

/** GET /api/app-version — anonymous. */
async function publicVersions(req, res, next) {
  try {
    res.json(await readVersions());
  } catch (err) { next(err); }
}

/** GET /api/admin/app-version */
async function getVersions(req, res, next) {
  try {
    res.json(await readVersions());
  } catch (err) { next(err); }
}

/**
 * PUT /api/admin/app-version
 *
 * The store link is checked for being an https URL and nothing more. It is
 * typed in by the one person who has the store consoles open in another tab,
 * and guessing at Apple's and Google's URL shapes here would only reject a
 * correct link the day one of them changes.
 */
async function setVersions(req, res, next) {
  try {
    const clean = { ...EMPTY };
    for (const platform of ['ios', 'android']) {
      const entry = req.body?.[platform] || {};
      const version = String(entry.version || '').trim().slice(0, 20);
      const url = String(entry.url || '').trim().slice(0, 300);
      if (version && !/^\d+(\.\d+)*$/.test(version)) {
        return res.status(400).json({ error: `מספר גרסה לא תקין (${platform}) — מספרים ונקודות בלבד` });
      }
      if (url && !/^https:\/\//i.test(url)) {
        return res.status(400).json({ error: `כתובת החנות חייבת להתחיל ב-https (${platform})` });
      }
      clean[platform] = { version, url };
    }

    await Setting.findOneAndUpdate({ key: KEY }, { value: clean }, { upsert: true });
    res.json(clean);
  } catch (err) { next(err); }
}

module.exports = { publicVersions, getVersions, setVersions, KEY };
