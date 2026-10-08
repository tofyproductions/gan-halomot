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
  - id: brain-attendance
    tier: green
    how: "district_api brain-attendance {date?} (date=YYYY-MM-DD, default today) — expected per class: active children minus reported absences"
  - id: brain-orders
    tier: green
    how: "district_api brain-orders — orders awaiting the office's approval"
  - id: brain-birthdays
    tier: green
    how: "district_api brain-birthdays {days?} (days=1..14, default 7) — upcoming birthdays, short names"
  - id: brain-shifts
    tier: green
    how: "district_api brain-shifts {date?} (date=YYYY-MM-DD, default today) — the published rota and classes below ratio"
  - id: brain-signups
    tier: green
    how: "district_api brain-signups {days?} (days=1..14, default 1) — parents who activated the portal, first names"
sync_check:
  action: brain-sync
  field: lastSyncAt
  max_hours: 26
  label: ה-Pi בגן
brand:
  logo: .brain/brand/logo.png
  guide: .brain/brand/GUIDE.md
  colors:
    blue: "#00AEEF"
    sky: "#23AAE1"
    red: "#ED1C24"
    orange: "#F26522"
    yellow: "#FFDE16"
    green: "#0BA14B"
    indigo: "#2E3192"
    ink: "#231F20"
    sign-red: "#FF0000"
    cal-cream: "#FFF4E3"
    cal-peach: "#FFD699"
    cal-red: "#CE2027"
  fonts: [Gveret Levin, Arial Hebrew Kit, Gan CLM, Corsiva Hebrew Kit, Athelas Kit]
  files:
    - .brain/brand/brand.css
    - .brain/brand/GveretLevinAlefAlefAlef-Regular.otf
    - .brain/brand/ArialHebrew-Regular.ttf
    - .brain/brand/ArialHebrew-Bold.ttf
    - .brain/brand/GanCLM-Bold.ttf
    - .brain/brand/CorsivaHebrew-Bold.ttf
    - .brain/brand/Athelas-Bold.ttf
    - .brain/brand/bg-meadow-landscape.jpg
    - .brain/brand/bg-meadow-landscape-soft.jpg
    - .brain/brand/bg-meadow-landscape-dim.jpg
    - .brain/brand/bg-meadow-portrait.jpg
    - .brain/brand/bg-meadow-portrait-soft.jpg
    - .brain/brand/bday-frame-party.png
    - .brain/brand/bday-frame-confetti.png
    - .brain/brand/bday-bg-mazal-tov.jpg
    - .brain/brand/allergy-milk.png
    - .brain/brand/allergy-sesame.png
    - .brain/brand/cert-ribbon.png
    - .brain/brand/cert-rosette.png
    - .brain/brand/ref-class-sign.jpg
    - .brain/brand/ref-allergy-sign.jpg
    - .brain/brand/ref-birthday-party.jpg
    - .brain/brand/ref-birthday-confetti.jpg
    - .brain/brand/ref-holiday-table.jpg
    - .brain/brand/ref-certificate.jpg
---
מערכת הניהול של גן החלומות: הורים, תשלומים, שכר, משמרות וקבלות.
רצה ב-Render (שירות gan-halomot, פרנקפורט); הקוד ב-GitHub tofyproductions/gan-halomot.
המשך עבודה: skill `/gan` (ו-`/ganflow` לשכבת הלקוחות).
