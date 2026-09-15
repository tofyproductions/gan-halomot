/**
 * Outgoing mail for ג׳וב חלום.
 *
 * Sends through ./mailer, which is this service's OWN implementation and
 * imports nothing from the gan. It used to reuse services/email.service.js;
 * that module loads config/env.js, which refuses to load in production without
 * the gan's JWT_SECRET, and the board crashed on boot demanding a secret
 * belonging to a system it must not touch. See mailer.js.
 *
 * ⚠️ BEFORE LAUNCH: the new domain needs its sender-authentication records
 * (SPF / DKIM / DMARC) set up. Mail from a fresh domain lands in spam, and the
 * failure is silent in the worst way — a gan sees no applications and decides
 * the board is dead, while the applications were there all along.
 *
 * NOTHING HERE MAY THROW INTO A REQUEST. A woman's application must be saved
 * whether or not the gan's mail server is reachable; losing her application
 * because of a mail hiccup is the one outcome worth avoiding entirely.
 */

const { dispatch, FROM } = require('./mailer');
const { labelOf, AREAS, ROLES } = require('./constants');
const SITE = process.env.JOBGAN_PUBLIC_URL || 'https://jobs.dreamgan.com';

async function safeSend(args) {
  try {
    return await dispatch({ from: FROM, ...args });
  } catch (err) {
    console.error('[jobgan] שליחת מייל נכשלה:', err.message);
    return null;
  }
}

const shell = (title, body) => `
<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;line-height:1.6;color:#15181b;max-width:560px">
  <h2 style="margin:0 0 12px;font-size:19px">${title}</h2>
  ${body}
  <hr style="border:0;border-top:1px solid #dde2e6;margin:22px 0">
  <p style="font-size:12px;color:#8d979e;margin:0">ג׳וב חלום — עבודה בגני ילדים</p>
</div>`;

/**
 * A gan hears the moment somebody applies.
 *
 * The screen pulls applications when somebody signs in, which is correct and
 * insufficient: a gan that does not sign in for three days leaves a woman
 * waiting three days, and she has taken another job by then. This mail is what
 * brings them in.
 *
 * It carries no personal detail of hers. The policy promises her that her
 * details are revealed when the gan OPENS the application, and an email
 * containing her name and telephone would break that promise in a copy we
 * cannot recall.
 */
function newApplication({ employer, job, applicationsWaiting }) {
  return safeSend({
    to: employer.email,
    subject: `מועמדות חדשה — ${job.title}`,
    html: shell('הגיעה מועמדות חדשה', `
      <p style="margin:0 0 10px">למשרה <b>${job.title}</b> ב${labelOf(AREAS, job.area)} (${labelOf(ROLES, job.role)}).</p>
      <p style="margin:0 0 16px">ממתינות לך <b>${applicationsWaiting}</b> מועמדויות.</p>
      <p style="margin:0 0 16px"><a href="${SITE}/employer" style="background:#a8540b;color:#fff;padding:10px 18px;border-radius:3px;text-decoration:none;display:inline-block">לצפייה במועמדויות</a></p>
      <p style="margin:0;font-size:13px;color:#59636a">פרטי המועמדת נחשפים כשפותחים את המועמדות.</p>
    `),
    text: `הגיעה מועמדות חדשה למשרה ${job.title}. ממתינות ${applicationsWaiting} מועמדויות. ${SITE}/employer`,
  });
}

/** Her answer. Sent for every outcome, including the ones nobody enjoys. */
function applicationAnswered({ seeker, job, status }) {
  if (!seeker.email) return null;
  const copy = {
    invited:    ['הוזמנת לראיון', 'הגן שאליו הגשת מועמדות מעוניין לקבוע ראיון. הוא יצור איתך קשר בטלפון.'],
    rejected:   ['תשובה על מועמדותך', 'הגן השיב שהמשרה אינה מתאימה כרגע. המועמדויות האחרות שלך אינן מושפעות.'],
    job_closed: ['המשרה נסגרה', 'המשרה שאליה הגשת מועמדות נסגרה. לא נדרשת ממך פעולה.'],
  }[status];
  if (!copy) return null;
  return safeSend({
    to: seeker.email,
    subject: `${copy[0]} — ${job.title}`,
    html: shell(copy[0], `
      <p style="margin:0 0 10px">${copy[1]}</p>
      <p style="margin:0 0 16px">המשרה: <b>${job.title}</b>, ${labelOf(AREAS, job.area)}.</p>
      <p style="margin:0"><a href="${SITE}" style="color:#a8540b">למשרות נוספות</a></p>
    `),
    text: `${copy[0]} — ${job.title}. ${copy[1]}`,
  });
}

/** The gan is told its first ad passed review, because until then it waits. */
function employerApproved({ employer }) {
  return safeSend({
    to: employer.email,
    subject: 'המודעה שלך אושרה ופורסמה',
    html: shell('המודעה פורסמה', `
      <p style="margin:0 0 10px">שלום ${employer.contact_name}, המודעה של ${employer.gan_name} עברה את הבדיקה החד־פעמית ופורסמה בלוח.</p>
      <p style="margin:0 0 16px">המודעות הבאות שלך יתפרסמו מיד, בלי המתנה.</p>
      <p style="margin:0"><a href="${SITE}/employer" style="color:#a8540b">לאזור האישי</a></p>
    `),
    text: `המודעה של ${employer.gan_name} אושרה ופורסמה. ${SITE}/employer`,
  });
}

module.exports = { newApplication, applicationAnswered, employerApproved, safeSend };
