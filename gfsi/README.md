# GFSI Credit Memo System — setup guide

This folder holds the whole system: the rep form (`index.html`, served by the portal), the Google Apps Script backend (`apps-script/`), and the shared source in `src/`. After editing anything in `src/`, run `./build.sh` to regenerate `apps-script/Parsers.html` and `apps-script/Packet.html`.

What's in this folder:

| File | Goes where | What it does |
|---|---|---|
| `index.html` (this folder) | The sales portal, at `/gfsi/` | The rep form. Multiple orders per submission, live credit math, approved-promo picker, guideline warnings. |
| `apps-script/Code.gs` | Google Apps Script (bound to a new private Sheet) | The backend: saves requests, emails the manager, builds and emails PDF memos, matches CCVs, computes budgets. |
| `apps-script/Review.html` | Same Apps Script project | The page the manager lands on from the approval email (approve all, or approve/reject each order). |
| `apps-script/Dashboard.html` | Same Apps Script project | Your dashboard: budgets, memo statuses, CCV import and matching, promo import. |
| `apps-script/MemoPdf.html` | Same Apps Script project | The credit memo PDF layout. |
| `apps-script/Parsers.html` | Same Apps Script project | Reads AAFES CCV files, Dick's recap sheet and the old form sheet. |
| `apps-script/Packet.html` | Same Apps Script project | Builds the combined CCV + credit memo PDF sent to Kathleen. |
| `apps-script/appsscript.json` | Same Apps Script project (manifest) | Time zone, web app settings. |

---

## 1. Create the backend (about 15 minutes, one time)

1. In Google Drive, create a new blank Google Sheet named **GFSI Credit Memos**. Keep it private. Only you, and anyone you choose, should have access.
2. In that sheet, go to **Extensions → Apps Script**.
3. In the Apps Script editor:
   - Replace the contents of `Code.gs` with this folder's `apps-script/Code.gs`.
   - Click **+ → HTML** five times and create `Dashboard`, `Review`, `MemoPdf`, `Parsers` and `Packet` (no `.html`; the editor adds it). Paste each file's contents in.
   - Click **Project Settings (⚙)**, tick **Show "appsscript.json" manifest file in editor**, then go back to the editor and replace `appsscript.json` with this folder's copy.
   - Save (Ctrl/Cmd+S).
4. In the function dropdown at the top, choose **setup** and click **Run**. Google will ask you to authorize the script; approve it. (You may see "Google hasn't verified this app". Click **Advanced → Go to … (unsafe)**. It's your own script.)
5. Back in the Sheet, you'll now have tabs **Memos, CCVs, Promos, Settings, Log**, plus a **GFSI** menu. A Drive folder called **GFSI Credit Memos** has been created for the PDFs and photos.
6. On the **Settings** tab, fill in:
   - `MANAGER_EMAIL`: Dick's email.
   - `ADMIN_EMAIL`: already set to you.
   - Budgets, tolerance ($1.00), and the 90/100-day windows are pre-filled. Change them any time.
   - `PACKET_TO` and `PACKET_CC`: who gets the matched CCV packets. Fill these in here; they're deliberately not in the code, because this repo is public.

## 2. Deploy the web app

1. In Apps Script, go to **Deploy → New deployment → ⚙ Select type → Web app**.
2. Set **Execute as: Me** and **Who has access: Anyone**, then click **Deploy**.
3. Copy the **Web app URL** (it ends in `/exec`).
4. Paste it into the **Settings** tab as `WEB_APP_URL`.

> **Updating from an earlier version:** paste in the new files, then run **setup** once more. It adds any new columns (e.g. CCV "Kind") without touching your data.

> **When you change the code later:** use **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. The URL stays the same. If you use "New deployment" instead, the URL changes.

## 3. Connect the portal form

The form is already on the portal at **`gfsi/index.html`**. It uses the portal login, so the rep's name and email come from their login, and it links back to the AAFES hub.
1. Open `gfsi/index.html` and, near the top of the main script, set:
   ```js
   var GFSI_CONFIG = { API_URL: 'https://script.google.com/macros/s/XXXX/exec', PORTAL_KEY: '' };
   ```
2. Commit. GitHub Pages updates within a minute or two.
3. Until `API_URL` is set, the form runs in **demo mode**: it shows a banner, uses sample promos, and sends nothing.
4. The hub card is still hidden. To show it on the AAFES hub, uncomment the **Credit Requests** block in `aafes-hub.html`. It already points to `gfsi/index.html`.

> This folder is public (GitHub Pages). Nothing secret is in it: email recipients, budgets and all data live in your private Google Sheet, and approval links are signed with a key stored only in Apps Script.

## 4. Load your data

Open the dashboard from the Sheet: **GFSI → Open dashboard**.

- **Promos tab:** drop in Dick's `CUSTOM PROMOS … RECAP.xlsx`. You get a preview of what was read, then click **Replace 2026 promos**. Do the same whenever he sends an updated one; promos you added by hand are kept.
- Load **both** of Dick's recaps: the current 2026 one (reps can still request memos in January for late-2026 promos) and the 2027 one once he has it.
- Old credit memos are **not** brought in; see *Going live on January 1* below.
- **CCVs tab:** see the routine below.

## 5. Test before go-live

1. Temporarily set `MANAGER_EMAIL` to your own address.
2. Submit a request from the portal with a fake order # (e.g. `99999991`).
3. Check that the approval email arrives. Click **Review & approve**, approve it, and confirm the PDF arrives.
4. Open the dashboard and confirm the memo appears, then **Void** it.
5. Set `MANAGER_EMAIL` back to Dick and switch the old Google Form off.

## Going live on January 1 (no old memos)

Memos issued before go-live live only in the old system. Three settings on the **Settings** tab handle the overlap:

- **`GO_LIVE_DATE`** (`2027-01-01`). CCVs for old memos will keep arriving until about mid-April. Any CCV **dated before** this date, or one that names a **CM# this system has never seen** in the ~4 months after it (and isn't a strong match for a new memo), is filed under **CCVs → "Old system — recorded only"**. It isn't matched, isn't flagged and isn't counted in the budget. If one gets filed there by mistake, click **This is ours**. If an unmatched CCV turns out to be old, click **Old system**.
- **`CARRY_IN_Champion` / `CARRY_IN_Under Armour` / `CARRY_IN_Comfort Wash`**. The budget year (April 1 – March 31) is already three-quarters done at go-live, so enter what each brand spent or committed under the old system since April 1:
  - CCVs received, **plus** old memos still outstanding.
  - It shows as **"Before go-live (old system)"** on the Overview and only applies to the Apr 2026 – Mar 2027 year.
  - Because old-system CCVs are left out of the budget, nothing is counted twice. If some old memos expire without a CCV, lower the carry-in.
- **Duplicate orders.** The form blocks a second memo for an order *in this system*, but it can't see orders already credited in the old one. During the first few months, the manager should watch for repeat order numbers.

---

## Day-to-day

**Reps:** fill in the form on the portal. They can add as many orders for one store as they like; each order becomes its own memo (`PR` or `MD` + order #, same as today).

**Manager:** gets one email per submission. The email has a summary and ⚠ flags (unapproved promo, over budget, under 25% remaining, shipped < 6 months, late promo). He clicks **Review & approve**, then **Approve all** or decides per order (a rejection needs a reason, which goes to the rep). Approved memos are emailed as PDFs to the rep (plus any CC), with Dick and you copied.

**You: CCVs (weekly or whenever):**
1. AAFES Partners → **Universal Search**: Date **30 DAYS**, Invoice Number `*WWACV*`, Search.
2. Tick all → **Download** (you get `Universal Search.zip`).
3. Dashboard → **CCVs** → drop the zip. The preview shows what each CCV will match, then click **Import**. Re-importing the same CCVs is harmless; duplicates are skipped.

What happens on import:
- **Matched:** the CCV amount equals the memo.
- **Matched (adjusted):** off by less than $1.00. The memo is recorded at the CCV amount.
- **Reversal needed:** off by $1.00 or more. Open the memo and click **Copy note to store** for a ready-to-send message.
- **Reversed — awaiting new CCV:** AAFES has issued the reversal (printed as a "DUE VENDOR CHARGE VOUCHER", recorded as a negative amount), which cancels out the wrong CCV. When the corrected CCV comes in, all the CCVs for that CM# are netted and the memo flips to **Matched** on its own. You can also mark it **Resolved** by hand.
- **Not ours (recorded only):** CCVs with no CM#/RA# and nothing about a promo or markdown, such as returns, RMAs and shipping damage. They're kept in their own list on the CCVs tab so you can show why no credit memo exists for them, but they never count toward matching, budgets or the "unmatched" badge. If one is misjudged, click **Not ours** / **This is ours** to move it.
- **Unmatched CCVs** are listed at the top of the CCVs tab. These are CCVs with no CM#/RA# on them, or with a CM# that isn't in the system. See *Matching CCVs by hand* below.

### Matching CCVs by hand

Stores often leave the CM# off. For every unmatched CCV, the dashboard ranks your open memos as **Strong / Likely / Possible** matches and says why, using:
- the **amount** (exact, or within $1)
- the **order #** appearing anywhere on the CCV, even split up like "1018 7155"
- the **store**, by name, or by the AAFES 10-digit facility # once it has learned it
- the **brand**, from the vendor # (a Champion CCV won't be suggested for a UA memo)
- the **date window** (the CCV must come after the memo, within ~100 days)
- promo vs. markdown wording

Ways to link:
- Click **Link** next to a suggestion.
- Or type in the **Find memo** box (CM#, store or amount) and pick from the list.
- Or click **Link N strong matches** to accept all the obvious ones at once. You'll see the list first.
- You can also work from the memo side: open a memo in **Credit memos**, and any unmatched CCVs that might belong to it are listed there with a **Link** button.

Every link, automatic or manual, teaches the system which AAFES facility # belongs to which of your stores. That makes the next round of suggestions sharper. The mapping is on the **Facility Map** tab of the Sheet; if one is wrong, fix it there, or just link the next CCV correctly (your latest manual link wins). Manual links survive re-importing the same zip. **unlink** undoes one.
- Memos with no CCV are flagged **Expiring** after 80 days and **Expired** after 100.

**Sending matched CCVs to Kathleen:**
As soon as a CCV is matched to its memo, the memo appears under **CCVs → Ready to send to Kathleen**. That includes memos adjusted by a few cents, memos resolved by hand, and reversed memos once the corrected CCV is in.
1. Click **Preview** to check a packet. A copy is saved to *CCV Packets/Previews* in Drive and opened.
2. Untick anything you want to hold back, then click **Email N packets**.
3. You can also send one from the memo itself (**Email CCV packet to Kathleen**).

What each packet contains:
- One PDF per memo: the CCV page(s), re-printed from AAFES's own text exactly as AAFES lays them out, followed by the credit memo.
- If the memo was adjusted to the CCV amount, the memo page shows the adjusted amount, with a small "Adjusted to match CCV (originally $…)" line.
- A reversed-and-reissued memo includes all its CCVs in date order (original, reversal, new one), and the file is named after the final CCV.

How it's sent:
- Files are named with the full CCV number and the CM#, e.g. `WWACVX110060670_PR10207133.pdf` (setting `PACKET_FILE_NAME`; `{ccv}`, `{ccvDigits}` and `{cm}` are available).
- **One email** to `PACKET_TO`, CC `PACKET_CC`, with every packet attached plus a **summary spreadsheet** (`CCV summary YYYY-MM-DD.xlsx`). The spreadsheet has one row per packet: file, CCV #(s), CCV date, CM#, type, brand, store, facility #s, order #, rep, memo date, promo, memo amount, CCV amount, difference and final credit, with totals at the bottom. The email body has the same list with a total.
- Very large batches are split into emails of 40 packets each, each with its own summary.
- Set `PACKET_EMAIL_MODE` to `each` if you ever want one email per packet instead.
- Sent packets and summaries are saved in the Drive folder *CCV Packets*, and the memo records when it was sent. **Send packet again…** on the memo puts it back on the list.

**Budget (Overview tab), per brand, per budget year (April 1 – March 31):**
- **CCVs received:** every CCV *dated* in that budget year and linked to a memo, promos and markdowns alike. Reversals count as negatives. This is the "actual" figure, and it follows the CCV date, not the memo date.
- **Plus money that has no CCV yet.** There's no CCV date to go by, so this counts toward the **current** budget year:
  - open memos (issued, under 100 days, no CCV)
  - memos awaiting approval
  - memos reversed and awaiting a new CCV
  - approved promos with no memo yet for that brand
- **Year-end rollover:** a memo issued in March whose CCV lands in April moves into the new year's actuals once the CCV arrives.
- **Past budget years** show CCV actuals only.
- **Unmatched CCVs** dated in the year are shown in a note at the top of the Overview. They aren't counted until you link them, because until then nobody knows which brand they belong to.
- **Promos and memos:** once any memo is requested against a promo for a brand, that promo's planned amount for the brand stops counting and the memo counts instead. Lines Dick has marked **Y** under "Submitted on Google Forms?" are treated as already used. Approved promos that never got a memo stop counting 180 days after the event (`PLANNED_PROMO_LOOKBACK_DAYS`).
- Settings: `FISCAL_YEAR_START_MONTH` (4 = April) and `BUDGET_INCLUDES_MARKDOWNS` (TRUE).

**Unapproved promos:** reps can still submit them. The manager sees a red "not on approved list" flag and you get an email. If it was approved last minute, either upload Dick's updated sheet (matching requests link up automatically by store + event name) or add it on the Promos tab → **Add a promo by hand**. You can also link a memo to an existing promo from its row in Credit memos.

## Good to know

- **Who can see what.** The form page is public (it's on GitHub Pages), but it can only *submit requests*, and nothing is issued without Dick's approval. It can also read the list of approved promo names and styles, but no dollar amounts. The Sheet, the dashboard, the PDFs and the photos stay private to your Google account. If random submissions ever become a problem, set `PORTAL_KEY` on the Settings tab and the same value in the form config.
- **Approval links** are signed, so they can't be guessed or altered. Opening one never approves anything by itself; it takes a button click. That matters because email virus-scanners sometimes "click" links automatically.
- **Email limits.** A regular Gmail account can email about 100 recipients a day from a script, and Workspace accounts get 1,500. At ~330 memos a year you're far under either.
- **Everything is in the Sheet.** You can filter, sort or export the Memos/CCVs tabs like any spreadsheet. Avoid renaming or reordering the header row.
- **Log tab** records every submission, decision and import, for troubleshooting.
