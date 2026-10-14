# Finance — Money Manager (Google Sheet + Apps Script + GitHub Pages)

```
backend/Code.gs   → Apps Script (paste in the Sheet's script editor)
site/             → index.html (login) · home.html · analysis.html · accounts.html · categories.html
                    common.js · store.js · common.css
```

## Setup
1. New Google Sheet → **Extensions → Apps Script** → paste `backend/Code.gs`.
2. Run **`setupSheets`** (tabs: Users, Transactions, Accounts, Category, Analysis + default accounts/categories).
3. Edit username / name / password inside `createUser` → run **`createUser`** (run again to reset a password).
4. **Deploy → New deployment → Web app** → Execute as *Me*, Access *Anyone* → copy URL.
5. Paste URL in `site/common.js` → `API_URL`; upload all `site/` files to GitHub Pages.

**Updating from the earlier (Paisa) version:** paste the new Code.gs → run `setupSheets` again (adds the `Current_Balance` column + rebuilds Analysis) → Deploy → Manage deployments → pencil → *New version* → Deploy. Then upload the new `site/` files.

## Sheet tabs
| Tab | Columns |
|---|---|
| Users | Username, Name, Password (hashed), Status |
| Transactions | ID, Time, Type, Amount, Category, Account, To_Account, Notes |
| Accounts | ID, Name, Opening_Balance, **Current_Balance (live formula)**, Icon, Note |
| Category | ID, Name, Type (Income/Expense/Investment), Icon, Budget, Note |
| Analysis | Built by script. Change **B1 (FROM) / B2 (TO)**: Income / Expense / Investment overview (total + by category) and the **date-wise table (J:M)** recalculate. Default = current month |

Keep Transactions columns in the default order (Time, Type, Amount, Category = B:E) — the Analysis category tables read that range.
Rows pasted by hand without an ID → run **`fillMissingIds`** once. `refreshBalanceFormulas` re-writes the Current_Balance formulas if you ever clear them.

## App
- **Home:** month bar (‹ › or tap the month), totals, date-wise list. `+` adds a transaction.
- **Analysis:** Month / Year / Custom range → Income, Expense, Invest totals + net, bar chart, day-wise (month/custom ≤ 62 days) or month-wise (year) totals, category-wise with budget. Tap a month in Year view to open its days. Transfers are not counted as income/expense.
- **Accounts / Categories:** add + edit (renaming updates old transactions). Category type can't change after creation.
- **Fewer API calls:** each visited month is cached on the device for 5 minutes (month switching = no call while fresh); accounts/categories are cached too. Profile icon → **Refresh** forces a fresh load.
- **Add / edit / delete are instant:** shown immediately, saved in the background. If the save fails the row shows **⚠ Not saved** with the reason (tap → Retry / edit / delete). Offline changes stay queued (also after closing the app) and sync when you're back online.
- Cache is per device: add on phone → press Refresh on laptop (or wait 5 min).
