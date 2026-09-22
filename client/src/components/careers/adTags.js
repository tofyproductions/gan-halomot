/**
 * The Facebook Pixel and the Google Ads tag that measure the hiring campaign.
 *
 * These were already on the GitHub Pages site the ads point at. Moving the
 * landing page without them would not be a neutral change: Meta and Google
 * optimise delivery against conversions they can see, so a campaign that
 * stops reporting leads does not merely lose a report — it starts spending
 * the same budget on worse traffic, and the drop looks like the page got
 * worse rather than like the measurement stopped.
 *
 * LOADED ON THE CAREERS PAGE ONLY, and this is the point of the file existing
 * instead of two <script> tags in index.html. index.html is the staff
 * application: putting a Meta pixel there would report every manager opening a
 * payroll screen to Facebook, from their own phone, forever. Nothing here runs
 * until somebody navigates to /careers, and `stopAdTags` takes it back down on
 * the way out.
 *
 * IDs live here rather than in the environment on purpose — they are public
 * (anybody can read them off the page source), they belong to the marketing
 * campaign rather than to the deployment, and a missing variable would fail
 * silently in the one way that is expensive.
 */

const META_PIXEL_ID = '1592074848787594';
const GOOGLE_ADS_ID = 'AW-17955320262';

const MARK = 'data-careers-ad-tag';

/** Add a script this module owns, so cleanup can find it again. */
function inject(attrs) {
  const el = document.createElement('script');
  el.setAttribute(MARK, '1');
  el.async = true;
  Object.assign(el, attrs);
  document.head.appendChild(el);
  return el;
}

export function startAdTags() {
  if (typeof document === 'undefined') return;
  // A double mount in React StrictMode would otherwise fire PageView twice.
  if (document.querySelector(`[${MARK}]`)) return;

  try {
    /* —— Meta pixel —— */
    if (!window.fbq) {
      const n = (...args) => { n.callMethod ? n.callMethod(...args) : n.queue.push(args); };
      n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
      window.fbq = n;
      window._fbq = window._fbq || n;
      inject({ src: 'https://connect.facebook.net/en_US/fbevents.js' });
    }
    window.fbq('init', META_PIXEL_ID);
    window.fbq('track', 'PageView');
  } catch (err) {
    // A blocked tracker is the normal case on a lot of phones, and it is not
    // a reason for a job applicant to see a broken page.
    console.warn('[careers] meta pixel unavailable:', err?.message);
  }

  try {
    /* —— Google Ads —— */
    window.dataLayer = window.dataLayer || [];
    if (!window.gtag) {
      // eslint-disable-next-line func-names, prefer-rest-params
      window.gtag = function () { window.dataLayer.push(arguments); };
      inject({ src: `https://www.googletagmanager.com/gtag/js?id=${GOOGLE_ADS_ID}` });
      window.gtag('js', new Date());
    }
    window.gtag('config', GOOGLE_ADS_ID);
  } catch (err) {
    console.warn('[careers] google tag unavailable:', err?.message);
  }
}

/**
 * Leaving the page takes the scripts back out.
 *
 * It does not un-ring the bell — whatever already loaded stays in memory for
 * this tab — but it stops a staff member who wandered onto /careers from
 * carrying a live pixel into the rest of the application.
 */
export function stopAdTags() {
  if (typeof document === 'undefined') return;
  document.querySelectorAll(`[${MARK}]`).forEach(el => el.remove());
}
