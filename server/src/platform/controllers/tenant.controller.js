const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { controlPlane, isEnabled, tenantConnection, forgetTenant } = require('../connection');
const { createTenant, suspendTenant, resumeTenant, tenantUsage } = require('../provision');
const sub = require('../subscription');
const icount = require('../icount');

/**
 * The console: the handful of screens where a customer is created, priced,
 * switched off and switched back on.
 *
 * Its own signing key, and not the application's. A token minted for a gan's
 * system_admin must be worthless here — if one key signed both, the most
 * powerful account inside any single customer would be a step away from every
 * customer, and there are hundreds of those accounts.
 */

function platformSecret() {
  const s = process.env.PLATFORM_JWT_SECRET;
  if (!s) throw new Error('PLATFORM_JWT_SECRET is not set');
  return s;
}

async function platformAuth(req, res, next) {
  if (!isEnabled()) return res.status(503).json({ error: 'שכבת הלקוחות אינה פעילה בשרת הזה' });
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'נדרשת התחברות' });
  try {
    req.platformUser = jwt.verify(header.slice(7), platformSecret());
    next();
  } catch {
    res.status(401).json({ error: 'החיבור פג' });
  }
}

function requireOwner(req, res, next) {
  if (req.platformUser?.role !== 'owner') return res.status(403).json({ error: 'נדרשת הרשאת בעלים' });
  next();
}

exports.platformAuth = platformAuth;
exports.requireOwner = requireOwner;

exports.login = async (req, res, next) => {
  try {
    const { PlatformUser } = await controlPlane();
    const email = String(req.body.email || '').toLowerCase().trim();
    const user = await PlatformUser.findOne({ email, is_active: true });

    // One message for a wrong address and a wrong password. Telling them apart
    // turns this form into a way to enumerate who works here.
    const ok = user && await bcrypt.compare(String(req.body.password || ''), user.password_hash);
    if (!ok) return res.status(401).json({ error: 'פרטי התחברות שגויים' });

    user.last_login_at = new Date();
    await user.save();

    const token = jwt.sign(
      { _id: user._id, email: user.email, role: user.role, full_name: user.full_name },
      platformSecret(),
      { expiresIn: '12h' },
    );
    res.json({ token, user: { email: user.email, full_name: user.full_name, role: user.role } });
  } catch (err) { next(err); }
};

exports.list = async (req, res, next) => {
  try {
    const { Tenant } = await controlPlane();
    const q = {};
    if (req.query.status) q.status = req.query.status;
    if (req.query.search) q.$or = [
      { name: new RegExp(req.query.search, 'i') },
      { slug: new RegExp(req.query.search, 'i') },
    ];
    const tenants = await Tenant.find(q).sort({ created_at: -1 }).limit(500);
    res.json(tenants);
  } catch (err) { next(err); }
};

/**
 * One customer, with the counts read live from their own database.
 *
 * Live rather than cached because the number is what the invoice is built
 * from, and a stale child count is an argument with a customer we would lose.
 * It is one query against one small database, not a scan across everybody.
 */
exports.get = async (req, res, next) => {
  try {
    const { Tenant } = await controlPlane();
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'לקוח לא נמצא' });

    let usage = null;
    try { usage = await tenantUsage(tenant); }
    catch (e) { usage = { error: 'לא ניתן להתחבר למסד של הלקוח' }; }

    res.json({ tenant, usage });
  } catch (err) { next(err); }
};

exports.create = async (req, res, next) => {
  try {
    if (!req.body.name || !req.body.slug || !req.body.admin_email) {
      return res.status(400).json({ error: 'חסרים שם, כתובת או מייל מנהל' });
    }
    // Checked here as well as in provision(), so the form says what is missing
    // before a database is created and then thrown away.
    if (!req.body.admin_id_number) {
      return res.status(400).json({ error: 'חסרה תעודת זהות של המנהל/ת — איתה נכנסים למערכת' });
    }
    const { tenant, tempPassword } = await createTenant(req.body, req.platformUser);
    // Shown once, here, and never stored in readable form or emailed. It is
    // now the password the first login actually asks for, so losing it means
    // resetting rather than shrugging.
    res.status(201).json({
      tenant,
      temp_password: tempPassword,
      login: {
        full_name: req.body.admin_name || (req.body.contact && req.body.contact.name) || '',
        id_number: String(req.body.admin_id_number).replace(/\D/g, ''),
      },
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
};

/**
 * Editing a customer. `slug` and `db_name` are not editable and are dropped
 * rather than refused — the address is printed on a contract and typed into
 * browsers, and the database behind it holds the records; renaming either from
 * a form is how a working customer stops existing.
 */
exports.update = async (req, res, next) => {
  try {
    const { Tenant, AuditLog } = await controlPlane();
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'לקוח לא נמצא' });

    const ALLOWED = ['name', 'pricing', 'entitlements', 'contact', 'billing', 'branding', 'trial_ends_at', 'notes', 'db_uri'];
    const before = {};
    for (const key of ALLOWED) {
      if (req.body[key] === undefined) continue;
      before[key] = tenant[key];
      tenant[key] = req.body[key];
    }
    await tenant.save();

    await AuditLog.create({
      actor_id: req.platformUser._id, actor_email: req.platformUser.email,
      action: 'tenant.update', tenant_id: tenant._id, tenant_slug: tenant.slug,
      detail: { before, after: req.body },
    });
    res.json(tenant);
  } catch (err) { next(err); }
};

/**
 * Pointing a customer at a different database.
 *
 * `update` deliberately refuses this: renaming the database from the same form
 * that edits a telephone number is how a working customer stops existing. But
 * it does have to be possible, and until now it was not — which is a promise
 * the runbook already made ("the 131st customer moves cluster") with nothing
 * behind it, and it is also what a customer created against the wrong database
 * needs, which is how it was found.
 *
 * So it is its own action, owner-only, and it LOOKS FIRST. `check` opens the
 * target and reports what is in it without saving, because "did I type the
 * right name" is the whole question and an empty gan looks exactly like a full
 * one from the outside. Nothing here writes to either database: the old one is
 * left as it was, and the new one is read.
 */
exports.setDatabase = async (req, res, next) => {
  try {
    const { Tenant, AuditLog } = await controlPlane();
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'לקוח לא נמצא' });

    const dbName = String(req.body.db_name || '').trim();
    if (!/^[A-Za-z0-9_-]{1,63}$/.test(dbName)) {
      return res.status(400).json({ error: 'שם מסד לא תקין — אותיות לועזיות, ספרות, קו תחתון ומקף בלבד' });
    }
    const dbUri = req.body.db_uri === undefined ? tenant.db_uri : String(req.body.db_uri).trim();

    // Read the target through a throwaway tenant shape, so the customer's own
    // cached connection is untouched while we are only looking.
    let found;
    try {
      const probe = { slug: `__probe_${tenant.slug}`, db_name: dbName, db_uri: dbUri };
      const { models, conn } = await tenantConnection(probe);
      found = {
        children: await models.Child.countDocuments(),
        employees: await models.Employee.countDocuments(),
        branches: await models.Branch.countDocuments(),
        users: await models.User.countDocuments(),
        collections: (await conn.db.listCollections().toArray()).length,
      };
      await forgetTenant(probe.slug);
    } catch (err) {
      return res.status(400).json({ error: `לא הצלחתי להתחבר למסד "${dbName}": ${err.message}` });
    }

    if (req.body.check) return res.json({ checked: true, db_name: dbName, found });

    const before = { db_name: tenant.db_name, db_uri: tenant.db_uri };
    tenant.db_name = dbName;
    tenant.db_uri = dbUri;
    await tenant.save();

    // The cache is keyed on slug. Without this the customer keeps answering
    // from the database they were on until the entry idles out, and the move
    // looks like it did nothing.
    await forgetTenant(tenant.slug);

    await AuditLog.create({
      actor_id: req.platformUser._id, actor_email: req.platformUser.email,
      action: 'tenant.database', tenant_id: tenant._id, tenant_slug: tenant.slug,
      detail: { before, after: { db_name: dbName, db_uri: dbUri }, found },
    });

    res.json({ tenant, found });
  } catch (err) { next(err); }
};

/**
 * The people inside a customer who can actually log in.
 *
 * Not everybody — a gan with ninety employees would return ninety rows, and
 * the question being asked is always about the two or three who hold a
 * management account. Read-only, and it never returns a password hash.
 */
exports.tenantUsers = async (req, res, next) => {
  try {
    const { Tenant } = await controlPlane();
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'לקוח לא נמצא' });

    const { models } = await tenantConnection(tenant);
    const users = await models.User.find({
      role: { $in: ['system_admin', 'accountant', 'branch_manager'] },
      is_active: true,
    }).select('full_name id_number email role password_set must_change_password').limit(50).lean();

    res.json({ users });
  } catch (err) { next(err); }
};

/**
 * Issuing a new password for somebody inside a customer.
 *
 * WHY THIS EXISTS. A manager who forgets her password has, until now, no way
 * back in at all: the gan's login is a name, an id number and a password, and
 * nothing anywhere could replace the third. The account is simply lost.
 *
 * WHAT IT DELIBERATELY IS NOT. It does not show us their password — nobody
 * has it, it is a hash. It mints a new temporary one, shows it ONCE, and
 * flags the account so that the temporary password buys exactly one thing:
 * choosing a real one. That matters because this password travels through a
 * telephone call or a text message, and both of those keep a copy. After the
 * person chooses, the one that travelled is dead.
 *
 * Logged with who did it and for whom, because resetting somebody's password
 * is indistinguishable from taking their account, and the difference has to be
 * written down somewhere.
 */
exports.resetUserPassword = async (req, res, next) => {
  try {
    const { Tenant, AuditLog } = await controlPlane();
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'לקוח לא נמצא' });

    const { models } = await tenantConnection(tenant);
    const user = await models.User.findById(req.body.user_id);
    if (!user) return res.status(404).json({ error: 'משתמש לא נמצא אצל הלקוח' });

    // Readable down a telephone: no l/I/0/O, and grouped.
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    const pick = (n) => Array.from(crypto.randomBytes(n))
      .map((b) => alphabet[b % alphabet.length]).join('');
    const tempPassword = `${pick(4)}-${pick(4)}`;

    user.password_hash = await bcrypt.hash(tempPassword, 10);
    user.password_set = true;
    user.must_change_password = true;
    await user.save();

    await AuditLog.create({
      actor_id: req.platformUser._id, actor_email: req.platformUser.email,
      action: 'tenant.reset_password', tenant_id: tenant._id, tenant_slug: tenant.slug,
      detail: { user_id: String(user._id), full_name: user.full_name, role: user.role },
    });

    res.json({
      full_name: user.full_name,
      id_number: user.id_number || '',
      temp_password: tempPassword,
    });
  } catch (err) { next(err); }
};

/**
 * The standing charge at iCount.
 *
 * Reading it is a dry run of this month's sync — what WOULD be sent — beside
 * what iCount currently holds. "What is it about to charge them" is the only
 * question worth answering before a run that moves money.
 */
exports.subscription = async (req, res, next) => {
  try {
    const { Tenant } = await controlPlane();
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'לקוח לא נמצא' });

    const link = tenant.billing?.icount || {};
    const month = req.query.month || new Date().toISOString().slice(0, 7);

    let next_charge = null;
    let error = null;
    try { next_charge = await sub.preview(tenant, { month }); }
    catch (e) { error = e.message; }

    res.json({
      connected: Boolean(link.hk_id),
      icount_configured: icount.enabled(),
      hk_id: link.hk_id || null,
      hk_type: link.hk_type || '',
      opened_at: link.opened_at || null,
      last_sync: link.last_sync || null,
      month,
      next_charge,
      error,
    });
  } catch (err) { next(err); }
};

exports.openSubscription = async (req, res, next) => {
  try {
    res.json(await sub.openProfile(req.params.id, req.body || {}, { actor: req.platformUser }));
  } catch (err) { err.status ? res.status(err.status).json({ error: err.message }) : next(err); }
};

exports.syncSubscription = async (req, res, next) => {
  try {
    res.json(await sub.syncOne(req.params.id, {
      month: req.body?.month,
      // Sending is the exception, not the default: a request that forgot to
      // say which it wanted must not be the one that changes what people pay.
      dryRun: req.body?.confirm !== true,
      actor: req.platformUser,
    }));
  } catch (err) { err.status ? res.status(err.status).json({ error: err.message }) : next(err); }
};

exports.syncAllSubscriptions = async (req, res, next) => {
  try {
    res.json(await sub.syncAll({
      month: req.body?.month,
      dryRun: req.body?.confirm !== true,
      actor: req.platformUser,
    }));
  } catch (err) { err.status ? res.status(err.status).json({ error: err.message }) : next(err); }
};

exports.suspend = async (req, res, next) => {
  try { res.json(await suspendTenant(req.params.id, req.body.reason || '', req.platformUser)); }
  catch (err) { err.status ? res.status(err.status).json({ error: err.message }) : next(err); }
};

exports.resume = async (req, res, next) => {
  try { res.json(await resumeTenant(req.params.id, req.platformUser)); }
  catch (err) { err.status ? res.status(err.status).json({ error: err.message }) : next(err); }
};

/** The one number the business runs on: what everybody together owes this month. */
exports.summary = async (req, res, next) => {
  try {
    const { Tenant } = await controlPlane();
    const tenants = await Tenant.find({ status: { $in: ['active', 'trial'] } });

    let children = 0;
    let revenue = 0;
    const failed = [];
    for (const t of tenants) {
      try {
        const u = await tenantUsage(t);
        children += u.children;
        revenue += u.monthly_charge;
      } catch { failed.push(t.slug); }
    }
    const { Tenant: T } = await controlPlane();
    res.json({
      tenants: tenants.length,
      suspended: await T.countDocuments({ status: 'suspended' }),
      children,
      monthly_revenue: Math.round(revenue),
      unreachable: failed,
    });
  } catch (err) { next(err); }
};

exports.audit = async (req, res, next) => {
  try {
    const { AuditLog } = await controlPlane();
    const q = req.query.tenant_id ? { tenant_id: req.query.tenant_id } : {};
    res.json(await AuditLog.find(q).sort({ at: -1 }).limit(200));
  } catch (err) { next(err); }
};

/**
 * Open a customer's system, as support, to look at what they are looking at.
 *
 * This is the feature that sells — "call us and we'll go through it with you" —
 * and it is the first thing a network's security review asks about, because it
 * is also the most dangerous thing here: our staff, inside their records.
 *
 * FOUR THINGS MAKE IT DEFENSIBLE RATHER THAN ALARMING.
 *
 * It is READ ONLY. Support can see every screen and change nothing. Fixing a
 * customer's payroll while signed in as one of their managers leaves a record
 * that says the manager did it, and no support call is worth that. When
 * something has to be changed, the customer changes it while we watch, or an
 * owner does it through the console where it is logged as us.
 *
 * It expires in thirty minutes. A support session is a phone call, not an
 * account; a token that outlives the call is a key left in a door.
 *
 * It is logged before it is issued, with who asked and why — the log is the
 * only honest answer to "who was in our system on the 3rd", and a log written
 * after the fact is a log that can be skipped when the request fails.
 *
 * And it carries the customer it was minted for, like every other token here,
 * so it cannot be pointed at a different one.
 */
exports.impersonate = async (req, res, next) => {
  try {
    const { Tenant, AuditLog } = await controlPlane();
    const tenant = await Tenant.findById(req.params.id);
    if (!tenant) return res.status(404).json({ error: 'לקוח לא נמצא' });
    if (tenant.status === 'closed') return res.status(410).json({ error: 'המנוי נסגר' });

    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 5) {
      return res.status(400).json({ error: 'צריך לכתוב בשביל מה נכנסים — זה נרשם ביומן' });
    }

    const { tenantConnection } = require('../connection');
    const { models } = await tenantConnection(tenant);
    const admin = await models.User.findOne({ role: 'system_admin', is_active: true }).lean();
    if (!admin) return res.status(409).json({ error: 'אין אצל הלקוח מנהל מערכת פעיל להיכנס בשמו' });

    // Written BEFORE the token exists. A log written afterwards is one that
    // gets skipped on the path where something goes wrong.
    await AuditLog.create({
      actor_id: req.platformUser._id,
      actor_email: req.platformUser.email,
      action: 'tenant.impersonate',
      tenant_id: tenant._id,
      tenant_slug: tenant.slug,
      detail: { reason, as: admin.full_name, minutes: 30 },
      ip: req.ip || '',
    });

    const token = jwt.sign({
      id: admin._id,
      email: admin.email,
      full_name: admin.full_name,
      role: admin.role,
      branch_id: admin.branch_id || null,
      org_unit_id: admin.org_unit_id ? String(admin.org_unit_id) : null,
      tenant: tenant.slug,
      // The two claims the application checks. `support` makes every screen
      // reachable and every write refused; `support_by` is who to name on
      // screen, so nobody in the gan sees an unexplained session.
      support: true,
      support_by: req.platformUser.email,
    }, process.env.JWT_SECRET, { expiresIn: '30m' });

    res.json({
      token,
      as: admin.full_name,
      tenant: { slug: tenant.slug, name: tenant.name },
      expires_in_minutes: 30,
      read_only: true,
    });
  } catch (err) { next(err); }
};

/**
 * The billing month: work it out, look at it, and mark it sent or paid.
 *
 * Computing is owner-only. Support looking at what a customer owes is a support
 * call; support deciding what they owe is not.
 */
exports.billingRun = async (req, res, next) => {
  try {
    const { runMonth } = require('../billing');
    const out = await runMonth({
      month: req.body?.month,
      recompute: Boolean(req.body?.recompute),
      dryRun: Boolean(req.body?.dry_run),
    });
    const { AuditLog } = await controlPlane();
    if (!out.dryRun) {
      await AuditLog.create({
        actor_id: req.platformUser._id,
        actor_email: req.platformUser.email,
        action: 'billing.run',
        detail: { month: out.month, tenants: out.tenants, total: out.total, failed: out.failed.length },
        ip: req.ip || '',
      });
    }
    res.json(out);
  } catch (err) {
    if (err.message.includes('נדרש')) return res.status(400).json({ error: err.message });
    next(err);
  }
};

exports.billingList = async (req, res, next) => {
  try {
    const { BillingPeriod } = await controlPlane();
    const q = {};
    if (req.query.month) q.month = req.query.month;
    if (req.query.tenant_id) q.tenant_id = req.query.tenant_id;
    const rows = await BillingPeriod.find(q).sort({ month: -1, tenant_name: 1 }).limit(500).lean();
    const total = rows.filter((r) => r.status !== 'void').reduce((a, r) => a + (r.amount || 0), 0);
    res.json({ rows, total });
  } catch (err) { next(err); }
};

exports.billingMark = async (req, res, next) => {
  try {
    const { BillingPeriod, AuditLog } = await controlPlane();
    const status = String(req.body?.status || '');
    if (!['draft', 'issued', 'paid', 'void'].includes(status)) {
      return res.status(400).json({ error: 'סטטוס לא מוכר' });
    }
    const row = await BillingPeriod.findById(req.params.id);
    if (!row) return res.status(404).json({ error: 'חודש חיוב לא נמצא' });

    row.status = status;
    if (status === 'issued') row.issued_at = new Date();
    if (status === 'paid') row.paid_at = new Date();
    if (req.body?.note != null) row.note = String(req.body.note);
    await row.save();

    await AuditLog.create({
      actor_id: req.platformUser._id,
      actor_email: req.platformUser.email,
      action: 'billing.' + status,
      tenant_id: row.tenant_id,
      tenant_slug: row.tenant_slug,
      detail: { month: row.month, amount: row.amount },
      ip: req.ip || '',
    });
    res.json(row);
  } catch (err) { next(err); }
};

/**
 * The name and address customers are given.
 *
 * The console used to write the domain into eight places. An address that lives
 * in two copies disagrees the day somebody edits one — and the copy that gets
 * missed is the one printed on a contract. It also has to be the same domain
 * the resolver reads customers out of, so it comes from here rather than from
 * the page.
 *
 * Public on purpose: it is a brand name and a domain, not a secret, and
 * requiring a login to render the login screen's own logo is a loop.
 */
exports.brand = (req, res) => {
  res.json({
    name: process.env.PLATFORM_BRAND || 'חלום',
    tagline: process.env.PLATFORM_TAGLINE || 'מערכת לניהול גני ילדים',
    domain: process.env.PLATFORM_DOMAIN || 'dreamgan.com',
  });
};
