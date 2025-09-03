# AC Pay Calculator — iPhone (PWA)

This is a **static web app** (no backend) that you can host on **GitHub Pages**. Once opened in Safari on your iPhone, tap **Share → Add to Home Screen** to install it. It works **offline** after the first load.

## What it does
- Contract pay tables (2023–2026) + projected 2027–2031 (+8%, +4%, +4%, +4%, hold 2031).
- Automatic **Sep 30** table switch + **Nov 10** step bump logic.
- **Tie Year/Step** toggle (2025→Step 1, 2026→Step 2, …).
- **XLR** toggle (+$2.46/hr on A320; FO steps 1–2 excluded).
- **ESOP** slider 2–10% (after-tax), **cap $30,000**; company match = 30% taxed then added to net.
- Pension (yrs 1–2: 6%; yrs 3–5: 6.5%; yrs 6+: 7%) pro‑rated by day from DOH = 2024‑08‑07.
- 2025 CRA federal/provincial brackets + BPAs, CPP/QPP (CPP2), EI (QC EI when in QC). Health = $58.80/mo.

## One-time deploy on GitHub Pages (3–5 min)
1. Create a new repo on GitHub, e.g. **ac-pay-calculator**.
2. **Upload everything** in this folder (keep `icons/` and file names intact).
3. Create an empty file named **.nojekyll** (already included here).
4. Go to **Settings → Pages**:   - **Source:** *Deploy from a branch*   - **Branch:** `main` → `/ (root)` → **Save**
5. Wait ~60–90 seconds. The published URL will appear on that page.

## Install on your iPhone
1. Open the GitHub Pages URL in **Safari**.
2. Tap **Share** → **Add to Home Screen** → **Add**.
3. Launch from your Home Screen (runs full-screen, offline-capable).

## Local preview (optional)
```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

## Files
- `index.html` — UI + iOS PWA meta.
- `app.js` — calculator logic.
- `manifest.webmanifest` — PWA manifest.
- `sw.js` — service worker for offline caching.
- `icons/…` — app icons (192/512 and Apple 180).

> Need Ontario surtax/Health Premium, QC credits to the dollar, or tweaks to assumptions? Open an issue or ping me and I’ll wire them in.
