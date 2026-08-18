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
  if (await Tenant.findOne({ slug })) {
    throw Object.assign(new Error('הכתובת כבר תפוסה'), { status: 409 });
  }

  const tenant = await Tenant.create({
    name: input.name,
    slug,
    db_name: dbNameFor(slug),
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

    const branch = await models.Branch.create({
      name: input.first_branch_name || input.name,
      is_active: true,
    });

    const root = await models.OrgUnit.create({
      name: input.name,
      kind: input.is_network ? 'network' : 'branch',
      parent_id: null,
      path: [],
      depth: 0,
      branch_id: input.is_network ? null : branch._id,
    });

    if (input.is_network) {
      await models.OrgUnit.create({
        name: input.first_branch_name || 'סניף ראשון',
        kind: 'branch',
        parent_id: root._id,
        path: [root._id],
        depth: 1,
        branch_id: branch._id,
      });
    }

    await models.User.create({
      email: String(input.admin_email).toLowerCase().trim(),
      password_hash: await bcrypt.hash(tempPassword, 10),
      password_set: false,          // forces a chosen password on first login
      full_name: input.admin_name || input.contact?.name || '',
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
    await rollback(tenant);
    await Tenant.deleteOne({ _id: tenant._id });
    throw err;
  }

  await AuditLog.create({
    actor_id: actor?._id || null,
    actor_email: actor?.email || '',
    action: 'tenant.create',
    tenant_id: tenant._id,
    tenant_slug: tenant.slug,
    detail: { name: tenant.name, db_name: tenant.db_name },
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
