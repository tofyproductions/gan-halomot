---
id: gan-halomot
name: גן החלומות — מערכת ניהול
district: gan
url: https://gan-halomot.onrender.com
health: /api/health
deploy: render
trial_until: "2026-10-12"
actions:
  - id: health-check
    tier: green
    how: GET /api/health
  - id: read-status
    tier: green
    how: "skill /gan — בדיקת דיפלויים אחרונים ב-Render וב-GitHub"
  - id: brain-summary
    tier: green
    how: "district_api brain-summary"
  - id: brain-payments
    tier: green
    how: "district_api brain-payments {month?} (month=YYYY-MM, default current month)"
  - id: brain-unpaid
    tier: green
    how: "district_api brain-unpaid {month?} (month=YYYY-MM, default current month)"
  - id: brain-children
    tier: green
    how: "district_api brain-children"
  - id: brain-sync
    tier: green
    how: "district_api brain-sync"
sync_check:
  action: brain-sync
  field: lastSyncAt
  max_hours: 26
  label: ה-Pi בגן
---
מערכת הניהול של גן החלומות: הורים, תשלומים, שכר, משמרות וקבלות.
רצה ב-Render (שירות gan-halomot, פרנקפורט); הקוד ב-GitHub tofyproductions/gan-halomot.
המשך עבודה: skill `/gan` (ו-`/ganflow` לשכבת הלקוחות).
