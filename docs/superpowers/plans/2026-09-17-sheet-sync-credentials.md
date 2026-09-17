# Giving the server access to the two sheets

1. Open https://console.cloud.google.com/ and pick (or create) a project.
2. APIs & Services → Library → enable **Google Sheets API**.
3. APIs & Services → Credentials → Create credentials → **Service account**.
   Name it `gan-sheet-sync`. No roles needed.
4. Open the new service account → Keys → Add key → Create new key → **JSON**.
   A file downloads. It contains a private key: treat it like a password.
5. Copy the service account's email address. It looks like
   `gan-sheet-sync@<project>.iam.gserviceaccount.com`.
6. Open each of the two sheets in Google Sheets → Share → paste that address →
   give it **Editor** → uncheck "Notify people" → Share.
   - לוח עדכונים דיגיטלי - סניף משה דיין - תינוקייה - אפליקצייה
   - לוח עדכונים דיגיטלי - סניף קפלן - תינוקייה - אפליקצייה
7. On Render, add the whole JSON file's contents as one environment variable
   named `GOOGLE_SHEETS_CREDENTIALS`.

The key never enters the repository. `.env` and Render hold it; nothing else.
