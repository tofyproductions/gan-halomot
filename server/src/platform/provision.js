const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { controlPlane, tenantConnection } = require('./connection');
const { RESERVED } = require('./resolve');

/**
 * Bringing a customer into existence, and taking one out.
 *
 * Opening a gan has to be one action that either happens or does not. A tenant
 * row with no database behind it is a customer who cannot log in; a database
 * with no first user is a customer who cannot log in either, and both are
 * discovered by the customer rather than by us. So the row, the database, the
 * root of their org chart and the first login are one call, and a failure part
 * way through removes what it made.
 */

function dbNameFor(slug) {
  // Mongo forbids / \ . " $ * < > : | ? in database names; the slug pattern
  // already excludes them, and the prefix keeps customer databases obviously
  // separate from ours on a shared cluster.
  return `gf_${slug.replace(/-/g, '_')}`;
}

async function createTenant(input, actor) {
  const { Tenant, AuditLog } = await controlPlane();

  const slug = String(input.slug || '').toLowerCase().trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/.test(slug)) {
    throw Object.assign(new Error('כתובת לא תקינה — 3 עד 32 תווים, אותיות לועזיות קטנות, ספרות ומקפים'), { status: 400 });
  }
  if (RESERVED.has(slug)) {
    throw Object.assign(new Error('הכתובת שמורה למערכת'), { status: 400 });
  }
  // Checked with the other inputs, BEFORE anything is written. Validating
  // after Tenant.create() left a half customer holding the address: the
  // second attempt then failed with "the address is taken" by the first
  // attempt's own wreckage.
  // Name and id number together are the credentials, so neither can be blank —
  // and a blank name would match every user with a blank name on the next
  // customer built the same way.
  const adminName = String(input.admin_name || input.contact?.name || '').trim();
  if (!adminName) {
    const e = new Error('צריך שם מלא של מנהל/ת — זה חצי מפרטי הכניסה');
    e.status = 400; throw e;
  }
  const adminId = String(input.admin_id_number || '').replace(/\D/g, '');
  if (adminId.length < 5 || adminId.length > 9) {
    const e = new Error('צריך תעודת זהות של מנהל/ת (5–9 ספרות) — בלעדיה אי אפשר להיכנס למערכת');
    e.status = 400; throw e;
  }

  if (await Tenant.findOne({ slug })) {
    throw Object.assign(new Error('הכתובת כבר תפוסה'), { status: 409 });
  }

  /**
   * ADOPTING A DATABASE THAT ALREADY HAS PEOPLE IN IT.
   *
   * Normally a customer is born with their database, and everything below
   * creates what a new gan needs. But a database can also arrive already full:
   * the demo, a customer moved off a full cluster, a customer restored from an
   * export. Naming it here means the customer points at what exists instead of
   * at an empty `gf_<slug>` beside it.
   *
   * Two consequences, both load-bearing:
   *   - nothing below overwrites what it finds. A branch, an org root and an
   *     administrator are created only if they are MISSING.
   *   - the rollback must not drop the database. It drops one it created; a
   *     database that was handed to us belongs to somebody else, and a failed
   *     provisioning must never be how a gan loses its children.
   */
  const adopting = Boolean(input.adopt_db_name);
  const dbName = adopting ? String(input.adopt_db_name).trim() : dbNameFor(slug);
  if (adopting && !/^[A-Za-z0-9_-]{1,63}$/.test(dbName)) {
    throw Object.assign(new Error('שם מסד לא תקין — אותיות לועזיות, ספרות, קו תחתון ומקף בלבד'), { status: 400 });
  }

  const tenant = await Tenant.create({
    name: input.name,
    slug,
    db_name: dbName,
    db_uri: input.db_uri || '',
    status: 'pending',
    pricing: input.pricing || undefined,
    contact: input.contact || undefined,
    billing: input.billing || undefined,
    branding: { display_name: input.name, ...(input.branding || {}) },
    trial_ends_at: input.trial_ends_at || null,
    notes: input.notes || '',
  });

  // A first password nobody chose and nobody keeps: it is shown once, at
  // creation, and the account is flagged so the system nags until it is
  // replaced. Mailing a password would put it in a mailbox forever.
  const tempPassword = input.admin_password || crypto.randomBytes(6).toString('base64url');

  try {
    const { models } = await tenantConnection(tenant);

    const branch = (adopting && await models.Branch.findOne({}).sort({ created_at: 1 }))
      || await models.Branch.create({
        name: input.first_branch_name || input.name,
        is_active: true,
      });

    const existingRoot = adopting ? await models.OrgUnit.findOne({ parent_id: null }) : null;
    const root = existingRoot || await models.OrgUnit.create({
      name: input.name,
      kind: input.is_network ? 'network' : 'branch',
      parent_id: null,
      path: [],
      depth: 0,
      branch_id: input.is_network ? null : branch._id,
    });

    if (input.is_network && !existingRoot) {
      await models.OrgUnit.create({
        name: input.first_branch_name || 'סניף ראשון',
        kind: 'branch',
        parent_id: root._id,
        path: [root._id],
        depth: 1,
        branch_id: branch._id,
      });
    }

    // An adopted database already has its people. Adding a second
    // administrator with the same id number would collide, and adding one with
    // a different id number hands out a key nobody asked for.
    const alreadyIn = adopting && await models.User.findOne({ id_number: adminId });
    if (!alreadyIn) await models.User.create({
      email: String(input.admin_email).toLowerCase().trim(),
      // The identity the application actually logs in with. Without it the
      // administrator this very function creates cannot sign in at all:
      // findLoginUser() matches on name AND id number, and a customer was
      // being handed a system nobody could open.
      id_number: adminId,
      password_hash: await bcrypt.hash(tempPassword, 10),
      // password_set: false used to mean "forces a chosen password on first
      // login". It does the opposite — step one of login issues a token
      // outright when no password is set, so the temporary password was never
      // asked for and a name plus an id number was the whole of the door.
      password_set: true,
      full_name: adminName,
      role: 'system_admin',
      branch_id: branch._id,
      is_active: true,
    });

    tenant.status = input.trial_ends_at ? 'trial' : 'active';
    tenant.activated_at = new Date();
    await tenant.save();
  } catch (err) {
    // Half a customer is worse than none — it holds the slug and cannot be
    // logged into, and the next attempt collides with it.
    //
    // THE DATABASE IS DROPPED ONLY IF THIS CALL CREATED IT. An adopted one was
    // full before we touched it.
    if (!adopting) await rollback(tenant);
    await Tenant.deleteOne({ _id: tenant._id });
    throw err;
  }

  await AuditLog.create({
    actor_id: actor?._id || null,
    actor_email: actor?.email || '',
    action: 'tenant.create',
    tenant_id: tenant._id,
    tenant_slug: tenant.slug,
    detail: { name: tenant.name, db_name: tenant.db_name, adopted: adopting || undefined },
  });

  return { tenant, tempPassword };
}

async function rollback(tenant) {
  try {
    const { conn } = await tenantConnection(tenant);
    await conn.dropDatabase();
  } catch { /* the database may never have been created */ }
}

/**
 * Stop serving a customer without losing anything of theirs.
 *
 * Suspension sets a date six months out rather than deleting, because that is
 * what the terms of use say, because records about children are not ours to
 * throw away on the day an invoice is late, and because the commonest reason
 * a gan stops paying in August is that it is August.
 */
async function suspendTenant(tenantId, reason, actor) {
  const { Tenant, AuditLog } = await controlPlane();
  const tenant = await Tenant.findById(tenantId);
  if (!tenant) throw Object.assign(new Error('לקוח לא נמצא'), { status: 404 });

  const purge = new Date();
  purge.setMonth(purge.getMonth() + 6);

  tenant.status = 'suspended';
  tenant.suspended_at = new Date();
  tenant.purge_after = purge;
  await tenant.save();

  await AuditLog.create({
    actor_id: actor?._id || null, actor_email: actor?.email || '',
    action: 'tenant.suspend', tenant_id: tenant._id, tenant_slug: tenant.slug,
    detail: { reason, purge_after: purge },
  });
  return tenant;
}

async function resumeTenant(tenantId, actor) {
  const { Tenant, AuditLog } = await controlPlane();
  const tenant = await Tenant.findById(tenantId);
  if (!tenant) throw Object.assign(new Error('לקוח לא נמצא'), { status: 404 });

  tenant.status = 'active';
  tenant.suspended_at = null;
  tenant.purge_after = null;
  await tenant.save();

  await AuditLog.create({
    actor_id: actor?._id || null, actor_email: actor?.email || '',
    action: 'tenant.resume', tenant_id: tenant._id, tenant_slug: tenant.slug,
  });
  return tenant;
}

/** How many children a customer is holding — what the invoice is computed from. */
async function tenantUsage(tenant) {
  const { models } = await tenantConnection(tenant);
  const [children, employees, branches] = await Promise.all([
    models.Child.countDocuments({ is_active: true }),
    models.Employee.countDocuments({ is_active: true }).catch(() => 0),
    models.Branch.countDocuments({ is_active: true }),
  ]);
  return { children, employees, branches, monthly_charge: tenant.monthlyCharge(children) };
}

module.exports = { createTenant, suspendTenant, resumeTenant, tenantUsage, dbNameFor };
