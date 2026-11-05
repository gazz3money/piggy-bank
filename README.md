# Piggy Bank

A family ledger for the kids' earnings and spending. It is not linked to any bank. It runs as a web page, so it works on both parents' phones (saved to the home screen like an app) and on the Apolosign wall calendar in Chrome.

## What it does

- A balance card for each kid, plus a total for all kids.
- Tap a kid to see their full history by month, with a running balance.
- Add an entry as **Earned** or **Spent**, with an amount, a note, and a date. Quick buttons fill in common notes such as Allowance, Chores, or Candy.
- Tap any entry to fix it or delete it.
- **Wall display** (🖥️ button): big, view-only balances and recent entries, sized for the Apolosign. It updates by itself when someone adds an entry on a phone.
- **Parent PIN** (optional): devices without the PIN can only view. Each parent enters the PIN once on their phone.
- Changes show up on every device within a second or two.

## One-time setup (about 10 minutes)

### 1. Firebase (the free database)

1. Go to https://console.firebase.google.com and sign in with a Google account.
2. Click **Create a project**, name it `piggy-bank`, and turn Google Analytics off.
3. In the left menu, open **Build › Firestore Database** and click **Create database**. Pick a location near you and choose **Start in production mode**.
4. Open the **Rules** tab, replace everything with the contents of `firestore.rules`, and click **Publish**.
5. Click the gear icon › **Project settings**. Under **Your apps**, click the **</>** (web) icon, name it `piggy-bank`, and register it. Skip Firebase Hosting.
6. Copy the `firebaseConfig` block it shows you (apiKey, authDomain, projectId and so on) and send it to Claude, or paste it into `firebase-config.js`. These values are meant to be public, so they are safe to share.

The free Spark plan is far more than a family ledger will ever use.

### 2. GitHub Pages (the free web hosting)

1. Create a new **public** repository named `piggy-bank` on GitHub. Your family data is not stored in it.
2. Add these files to it (Claude can push them once the repo is attached).
3. In the repo, open **Settings › Pages**, set **Source** to `Deploy from a branch`, pick `main` and `/ (root)`, and save.
4. After a minute the app is live at `https://<your-github-name>.github.io/piggy-bank/`.

### 3. First run

1. On your phone, open the app link and tap **Start a family ledger**.
2. Add each kid (with a starting balance if they already have savings).
3. Optional: in **Settings**, set a parent PIN.
4. In **Settings › Share with family**, send the family link to your wife's phone (or let her scan the QR code). She opens it, then adds it to her home screen.
   - iPhone: Share › Add to Home Screen.
   - Android: ⋮ menu › Add to Home screen.
5. On the Apolosign, open Chrome and go to the **wall link** from Settings. Bookmark it or add it to the home screen.

## Privacy note

Each family's data sits under a long random code that only appears in your family link. The database won't list families, so someone needs that link to see the ledger. Treat the link like a house key and share it only with family. The PIN stops view-only devices (like the wall screen or a kid's tablet) from changing entries.

## Files

| File | What it is |
| --- | --- |
| `index.html`, `style.css`, `app.js` | The app |
| `firebase-config.js` | Your Firebase settings (empty = demo mode on one device) |
| `firestore.rules` | Database security rules to paste into Firebase |
| `manifest.json`, `sw.js`, `icons/` | Lets phones install it like an app |
