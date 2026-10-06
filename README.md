# Cash Payment Vouchers v2 — GitHub Pages + Google Sheet

Installable web app (works on phone, tablet, desktop). Your **Google Sheet is the database**, receipt photos go to **Google Drive**, the site is hosted free on **GitHub Pages**.

```
index.html style.css app.js sw.js config.js manifest.webmanifest icons/   ← the website (repo root)
backend/Code.gs  backend/appsscript.json                                   ← paste into Apps Script
test/                                                                      ← optional automated tests
```

## One-time setup (≈10 minutes)

### 1) Backend (Google Sheet + Apps Script)
1. Create a new empty Google Sheet (e.g. "Cash Vouchers DB").
2. **Extensions → Apps Script**. Delete the sample code, paste all of `backend/Code.gs`.
   (Optional: Project Settings → tick "Show appsscript.json" and paste `backend/appsscript.json`.)
3. **Project Settings → Script properties → Add**:
   - `OWNER_EMAIL` = your email  · `OWNER_PIN` = a temporary 6-digit PIN · `OWNER_NAME` = your name (optional)
4. Select function **`setup`** → **Run** → approve the permissions (Sheets + Drive). It creates the tabs, a Drive folder for receipts, your owner login, and **deletes OWNER_PIN** afterwards.
5. **Deploy → New deployment → Web app** → Execute as: **Me** · Who has access: **Anyone** → Deploy → copy the **Web app URL**.
   *When you change Code.gs later: Deploy → Manage deployments → ✏️ → Version: New version.*

### 2) Website (GitHub Pages)
1. New GitHub repo → upload the contents of this folder (web files at the repo root).
2. Edit `config.js` and paste the Web app URL into `API_URL` (or skip and type it once on the login screen).
3. Repo **Settings → Pages → Deploy from a branch → main / (root)**. Your site: `https://<user>.github.io/<repo>/`.

### 3) First sign-in
Open the site → sign in with OWNER_EMAIL + temporary PIN → you're forced to choose your own PIN.
Then **Users** → add managers/staff with temporary PINs (they must change it at first login).

## Install on phones
- **Android/Chrome:** menu → *Install app*.  **iPhone/Safari:** Share → *Add to Home Screen*.

## Roles
| | Staff | Manager | Owner |
|---|---|---|---|
| Add payments + attach receipts | ✔ | ✔ | ✔ |
| See entries | own only | all | all |
| Edit / cancel vouchers, bulk upload, vendors, dashboard (all data) | – | ✔ | ✔ |
| Users, settings, categories, audit log | – | – | ✔ |

Permissions are enforced **on the server** (Apps Script), not just hidden in the page.

## Good to know
- Receipts are compressed on the phone (~200–400 KB), stored in Drive folder *Cash Voucher Receipts*, and shown only to people allowed to see that voucher.
- Offline: payments entered without internet are saved on the device and uploaded automatically when back online (duplicates are prevented).
- Apps Script is ~1–3 s per request and has daily quotas — plenty for one property.
- Don't edit the Vouchers/Users sheets by hand unless you know the columns; use the app. Reading/filtering/charting the Sheet yourself is always fine.
- Back up: File → Make a copy of the Sheet occasionally (and the Receipts folder in Drive).

## Tests (optional)
`node test/test-backend.js` — runs Code.gs against a mock of Google services (48 checks).
`test/run-e2e.sh` — headless-browser run of the whole app (needs Python Playwright).
