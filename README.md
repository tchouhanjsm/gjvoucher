# Cash Payment Vouchers (static, no Google Apps Script)

A free, serverless version of the GAS cash-voucher app. Runs entirely in the browser and is hosted on GitHub Pages.

## Features
- 6-digit PIN lock (first run sets it; 5 wrong tries = 15 min lock; auto-lock after 15 min idle)
- Multi-row same-day payment entry, vendor autocomplete
- Register with search, vendor/date filters, cancelled toggle, CSV export
- Edit / cancel vouchers, audit log
- A5 print voucher with amount in Indian words (Lakh / Crore)
- Reports by vendor and by day (printable)
- Vendor master, property name/address, voucher start number
- JSON backup / restore, works offline (PWA-style cache)

## Deploy free on GitHub Pages
1. Create a new repo (e.g. `cash-voucher-web`) and upload these files to the root.
2. Repo → **Settings → Pages** → Source: *Deploy from a branch* → `main` / `/ (root)` → Save.
3. Open `https://<your-username>.github.io/cash-voucher-web/`.

## Important notes
- **Data is stored in the browser (localStorage), per device.** Use *Settings → Download backup* regularly and restore on another device.
- The PIN is a screen lock, not server security. Don't put sensitive secrets in the repo.
- No voucher data is ever stored in the repo, so a public repo is safe. Check GitHub's current plan rules if you want a private repo with Pages.
