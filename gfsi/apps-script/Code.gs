/**
 * GFSI Credit Memo System — Google Apps Script backend.
 * Bound to the private "GFSI Credit Memos" Google Sheet.
 *
 * Web app (Deploy > New deployment > Web app; Execute as: Me; Who has access: Anyone):
 *   GET  ?action=promos             -> JSON list of approved promos for the rep form
 *   POST {action:'submit', ...}     -> creates pending memos, emails manager
 *   GET  ?page=review&b=..&t=..     -> manager's approve/reject page (link from email)
 * Spreadsheet menu "GFSI" -> Open dashboard (you only).
 */

var BRANDS = ['Champion', 'Under Armour', 'Comfort Wash'];
var RATES = { PR: 0.10, MD: 0.125 };
var TYPE_LABEL = { PR: 'Custom Promotion (10%)', MD: 'Markdown (12.5%)' };

var SHEETS = {
  Memos: ['CM#', 'Batch ID', 'Submitted', 'Rep Name', 'Rep Email', 'CC Emails', 'Store', 'Facility #', 'Type', 'Brand',
    'Gender', 'Order #', 'Styles (JSON)', 'Shipped Date', 'Promo ID', 'Promo Title', 'Promo Start', 'Promo Approved?',
    'Warnings', 'Comments', 'Photo Links', 'Amount', 'Status', 'Decided At', 'Decision Note', 'Issue Date', 'PDF Link',
    'CCV #s', 'CCV Date', 'CCV Amount', 'Match Status', 'Adjusted Amount', 'Match Note', 'Source', 'Packet Sent', 'Packet File', 'Packet Link'],
  CCVs: ['CCV #', 'CCV Date', 'Amount', 'Vendor #', 'AAFES Facility #', 'Facility Name', 'Return Auth', 'Comments',
    'Items', 'Matched CM#', 'Match Note', 'Imported At', 'Kind', 'Due To', 'Kind Source', 'Raw Text'],
  Promos: ['Promo ID', 'Year', 'Store', 'Facility #', 'Event', 'Event Date', 'Date Text', 'Rep', 'Display', 'Lines (JSON)',
    'Planned Champion', 'Planned Under Armour', 'Planned Comfort Wash', 'Open Champion', 'Open Under Armour',
    'Open Comfort Wash', 'Source', 'Imported At'],
  'Facility Map': ['AAFES Facility #', 'AAFES Name', 'Facility #', 'Store', 'Source', 'Updated At'],
  Settings: ['Key', 'Value', 'Notes'],
  Log: ['When', 'What', 'Detail']
};
var NUMERIC = { Memos: ['Amount', 'CCV Amount', 'Adjusted Amount'], CCVs: ['Amount'],
  Promos: ['Year', 'Planned Champion', 'Planned Under Armour', 'Planned Comfort Wash', 'Open Champion', 'Open Under Armour', 'Open Comfort Wash'] };

var DEFAULT_SETTINGS = [
  ['MANAGER_EMAIL', '', 'Approves every credit memo request'],
  ['ADMIN_EMAIL', '', 'You — gets unapproved-promo alerts and a copy of issued memos'],
  ['BUDGET_Champion', 10000, 'Budget per fiscal year (promos + markdowns), by CCV date'],
  ['BUDGET_Under Armour', 16000, ''],
  ['BUDGET_Comfort Wash', 2000, ''],
  ['BUDGET_INCLUDES_MARKDOWNS', 'TRUE', 'FALSE = only custom promos count against the brand budget'],
  ['FISCAL_YEAR_START_MONTH', 4, 'Budget year runs from the 1st of this month (4 = April 1 – March 31)'],
  ['PLANNED_PROMO_LOOKBACK_DAYS', 180, 'Approved promos with no memo stop counting this many days after the event'],
  ['MATCH_TOLERANCE', 1.00, 'CCV differences smaller than this are auto-accepted (memo adjusted)'],
  ['VALID_DAYS', 90, 'Printed on the memo'],
  ['CCV_GRACE_DAYS', 100, 'CCVs accepted up to this many days after issue'],
  ['EXPIRING_WARN_DAYS', 80, 'Dashboard flags memos with no CCV after this many days'],
  ['VENDOR_Champion', '11765201', 'Vendor code printed on Champion memos'],
  ['VENDOR_Under Armour', '64432501', ''],
  ['VENDOR_Comfort Wash', '64432501', ''],
  ['GO_LIVE_DATE', '2027-01-01', 'First day memos were issued in this system. CCVs before this (and CCVs naming unknown CM#s in the months after) are filed as "Old system"'],
  ['CARRY_IN_Champion', 0, 'Spent/committed under the OLD system in the budget year that contains GO_LIVE_DATE (CCVs received + old memos still outstanding)'],
  ['CARRY_IN_Under Armour', 0, ''],
  ['CARRY_IN_Comfort Wash', 0, ''],
  ['PACKET_TO', '', 'Matched CCV + credit memo packets are emailed here (fill in on this tab — kept out of the public code)'],
  ['PACKET_CC', '', 'CC on packet emails (comma-separated)'],
  ['PACKET_FILE_NAME', '{ccv}_{cm}.pdf', '{ccv} = full CCV number (WWACVX…), {ccvDigits} = without WWACVX, {cm} = PR/MD number'],
  ['PACKET_EMAIL_MODE', 'batch', 'batch = one email with all packets + a summary spreadsheet; each = one email per packet'],
  ['PORTAL_KEY', '', 'Optional: if set, the rep form must send this key'],
  ['DRIVE_FOLDER_ID', '', 'Filled in by Setup'],
  ['WEB_APP_URL', '', 'Paste the web app URL here after deploying']
];

// ======================================================================
// Setup & menu
// ======================================================================
function onOpen() {
  SpreadsheetApp.getUi().createMenu('GFSI')
    .addItem('Open dashboard', 'openDashboard')
    .addSeparator()
    .addItem('Run setup', 'setup')
    .addToUi();
}

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var props = PropertiesService.getScriptProperties();
  props.setProperty('SPREADSHEET_ID', ss.getId());
  if (!props.getProperty('SECRET')) props.setProperty('SECRET', Utilities.getUuid() + Utilities.getUuid());
  Object.keys(SHEETS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var hdr = SHEETS[name];
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, hdr.length).setValues([hdr]).setFontWeight('bold').setBackground('#e8eef7');
      sh.setFrozenRows(1);
      if (name !== 'Settings' && name !== 'Log') sh.getRange(2, 1, sh.getMaxRows() - 1, hdr.length).setNumberFormat('@');
      (NUMERIC[name] || []).forEach(function (h) {
        sh.getRange(2, hdr.indexOf(h) + 1, sh.getMaxRows() - 1, 1).setNumberFormat('0.00');
      });
    } else {
      // upgrade: append any columns added in a newer version
      var have = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
      hdr.filter(function (h) { return have.indexOf(h) < 0; }).forEach(function (h) {
        var col = sh.getLastColumn() + 1;
        sh.getRange(1, col).setValue(h).setFontWeight('bold').setBackground('#e8eef7');
        if (sh.getMaxRows() > 1) sh.getRange(2, col, sh.getMaxRows() - 1, 1).setNumberFormat('@');
      });
    }
  });
  var set = ss.getSheetByName('Settings');
  var have = set.getDataRange().getValues().map(function (r) { return r[0]; });
  DEFAULT_SETTINGS.forEach(function (row) { if (have.indexOf(row[0]) < 0) set.appendRow(row); });
  // upgrade older installs to the new defaults (only if still at the old default)
  set.getDataRange().getValues().forEach(function (r, i) {
    if (r[0] === 'BUDGET_INCLUDES_MARKDOWNS' && /also count/.test(String(r[2]))) set.getRange(i + 1, 2, 1, 2).setValues([['TRUE', 'FALSE = only custom promos count against the brand budget']]);
    if (r[0] === 'VENDOR_Comfort Wash' && /CONFIRM/.test(String(r[2]))) set.getRange(i + 1, 3).setValue('');
    if (r[0] === 'PACKET_FILE_NAME' && r[1] === 'CCV{ccvDigits}_{cm}.pdf') set.getRange(i + 1, 2, 1, 2).setValues([['{ccv}_{cm}.pdf', '{ccv} = full CCV number (WWACVX…), {ccvDigits} = without WWACVX, {cm} = PR/MD number']]);
    if (r[0] === 'PACKET_EMAIL_MODE' && /^each = one email per packet; batch/.test(String(r[2]))) set.getRange(i + 1, 2, 1, 2).setValues([['batch', 'batch = one email with all packets + a summary spreadsheet; each = one email per packet']]);
  });
  var cfg = getSettings_();
  if (!cfg.DRIVE_FOLDER_ID) {
    var folder = DriveApp.createFolder('GFSI Credit Memos');
    folder.createFolder('Photos');
    setSetting_('DRIVE_FOLDER_ID', folder.getId());
  }
  if (!cfg.ADMIN_EMAIL) setSetting_('ADMIN_EMAIL', Session.getEffectiveUser().getEmail());
  var s1 = ss.getSheetByName('Sheet1');
  if (s1 && s1.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s1);
  log_('setup', 'ok');
  try { SpreadsheetApp.getUi().alert('Setup done. Fill in MANAGER_EMAIL on the Settings tab, then deploy the web app (see README).'); } catch (e) {}
}

function openDashboard() {
  var html = HtmlService.createTemplateFromFile('Dashboard').evaluate().setWidth(1400).setHeight(880);
  SpreadsheetApp.getUi().showModalDialog(html, 'GFSI Credit Memos');
}

function include(name) { return HtmlService.createHtmlOutputFromFile(name).getContent(); }

// ======================================================================
// Web app entry points
// ======================================================================
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.page === 'review') {
    var t = HtmlService.createTemplateFromFile('Review');
    t.batchId = String(p.b || '').replace(/[^\w-]/g, ''); t.token = String(p.t || '').replace(/[^\w-]/g, '');
    t.ok = verify_(t.batchId, t.token);
    t.data = t.ok ? JSON.stringify(getBatchForReview_(t.batchId)).replace(/</g, '\\u003c') : 'null';
    return t.evaluate().setTitle('Review credit memo request')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  if (p.action === 'promos') return json_({ ok: true, promos: getPromosForForm_() });
  if (p.action === 'ping') return json_({ ok: true });
  return json_({ ok: false, error: 'Unknown request' });
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.action === 'submit') return json_(submitBatch_(body));
    return json_({ ok: false, error: 'Unknown action' });
  } catch (err) {
    log_('doPost error', String(err && err.stack || err));
    return json_({ ok: false, error: 'Server error: ' + err.message });
  }
}

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

// ======================================================================
// Rep submission
// ======================================================================
function submitBatch_(b) {
  var cfg = getSettings_();
  if (cfg.PORTAL_KEY && b.key !== cfg.PORTAL_KEY) return { ok: false, error: 'This form is not authorized. Please contact the office.' };
  var errs = [];
  var rep = b.rep || {};
  if (!clean_(rep.name)) errs.push('Rep name is required.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean_(rep.email))) errs.push('A valid rep email is required.');
  if (!clean_(b.store)) errs.push('Store name is required.');
  var facility = String(b.facility || '').replace(/\D/g, '');
  if (!b.nonAafes && facility.length !== 7) errs.push('Facility # must be 7 digits (or tick "Non-AAFES account").');
  var orders = b.orders || [];
  if (!orders.length) errs.push('Add at least one order.');
  if (orders.length > 25) errs.push('Please submit 25 orders or fewer at a time.');
  if (errs.length) return { ok: false, errors: errs };

  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var memos = readTable_('Memos');
    var live = {};
    memos.rows.forEach(function (m) { if (m['Status'] !== 'Rejected' && m['Status'] !== 'Void') live[m['CM#']] = true; });
    var promos = readTable_('Promos').rows;
    var promoById = {}; promos.forEach(function (p) { promoById[p['Promo ID']] = p; });
    var budget = computeBudget_(fyStartFor_(new Date(), cfg), memos.rows, promos, cfg, readTable_('CCVs').rows);

    var batchId = 'B' + Utilities.formatDate(new Date(), 'America/New_York', 'yyMMddHHmmss') + Math.floor(Math.random() * 90 + 10);
    var built = [], seen = {}, orderErrs = [];
    orders.forEach(function (o, i) {
      var label = 'Order ' + (i + 1);
      var type = o.type === 'MD' ? 'MD' : 'PR';
      var orderNo = String(o.orderNo || '').replace(/\D/g, '');
      var brand = BRANDS.indexOf(o.brand) >= 0 ? o.brand : '';
      var styles = (o.styles || []).map(function (s) {
        return { style: clean_(s.style).toUpperCase(), qty: Number(s.qty) || 0, cost: Number(s.cost) || 0, shippedQty: Number(s.shippedQty) || 0 };
      }).filter(function (s) { return s.style || s.qty || s.cost; });
      if (!orderNo) orderErrs.push(label + ': order # is required.');
      if (!brand) orderErrs.push(label + ': choose a brand.');
      if (!styles.length) orderErrs.push(label + ': add at least one style.');
      styles.forEach(function (s, j) {
        if (!s.style || s.qty <= 0 || s.cost <= 0) orderErrs.push(label + ', style line ' + (j + 1) + ': style, quantity and cost are all required.');
      });
      var cm = type + orderNo;
      if (orderNo && live[cm]) orderErrs.push(label + ': a credit memo ' + cm + ' already exists for this order.');
      if (orderNo && seen[cm]) orderErrs.push(label + ': order ' + orderNo + ' is listed twice.');
      seen[cm] = true;
      var gross = styles.reduce(function (t, s) { return t + s.qty * s.cost; }, 0);
      var amount = round2_(gross * RATES[type]);
      var warnings = [];
      var promo = type === 'PR' && o.promoId ? promoById[o.promoId] : null;
      if (type === 'PR') {
        if (!promo) warnings.push('PROMO NOT ON APPROVED LIST' + (o.promoTitle ? ': "' + clean_(o.promoTitle) + '"' : ''));
        else {
          if (promo['Facility #'] && facility && promo['Facility #'] !== facility) warnings.push('Approved promo is for facility ' + promo['Facility #'] + ' (' + promo['Store'] + '), not ' + facility);
          var lines = safeJson_(promo['Lines (JSON)'], []).filter(function (l) { return l.brand === brand; });
          if (!lines.length) warnings.push('Approved promo has no ' + brand + ' styles listed');
          else {
            var approvedStyles = lines.map(function (l) { return String(l.style).toUpperCase(); }).join('/');
            var off = styles.filter(function (s) { return approvedStyles.indexOf(s.style) < 0; }).map(function (s) { return s.style; });
            if (off.length) warnings.push('Style(s) not on approved promo: ' + off.join(', '));
            var plannedOpen = Number(promo['Open ' + brand]) || 0;
            if (plannedOpen && amount > plannedOpen + 0.005) warnings.push('Credit $' + fmt_(amount) + ' is more than the approved ' + brand + ' amount ($' + fmt_(plannedOpen) + ')');
          }
        }
        var start = o.promoStart || (promo && promo['Event Date']);
        if (start && daysBetween_(new Date(start), new Date()) > Number(cfg.VALID_DAYS || 90)) warnings.push('Promo started more than ' + (cfg.VALID_DAYS || 90) + ' days ago');
      } else {
        if (!o.shipped) warnings.push('No shipped date given (guideline: 6+ months on floor)');
        else if (daysBetween_(new Date(o.shipped), new Date()) < 182) warnings.push('Shipped less than 6 months ago (' + o.shipped + ')');
        styles.forEach(function (s) {
          if (s.shippedQty && s.qty < 0.25 * s.shippedQty) warnings.push(s.style + ': only ' + s.qty + ' of ' + s.shippedQty + ' left (<25% — needs manager OK)');
        });
        if (!(o.photos || []).length) warnings.push('No display photos attached');
      }
      if (type === 'PR' || String(cfg.BUDGET_INCLUDES_MARKDOWNS).toUpperCase() !== 'FALSE') {
        var bb = budget[brand];
        if (bb) {
          var credit = promo && !budget._promoUsed[promo['Promo ID'] + '|' + brand] ? Number(promo['Open ' + brand]) || 0 : 0;
          var remainingAfter = bb.remaining + credit - amount;
          if (remainingAfter < 0) warnings.push(brand + ' budget would be over by $' + fmt_(-remainingAfter));
          bb.remaining = remainingAfter;
          if (promo) budget._promoUsed[promo['Promo ID'] + '|' + brand] = true;
        }
      }
      built.push({ o: o, type: type, cm: cm, orderNo: orderNo, brand: brand, styles: styles, amount: amount, warnings: warnings, promo: promo });
    });
    if (orderErrs.length) return { ok: false, errors: orderErrs };

    var folder = DriveApp.getFolderById(cfg.DRIVE_FOLDER_ID);
    var photoFolder = folder.getFoldersByName('Photos').hasNext() ? folder.getFoldersByName('Photos').next() : folder.createFolder('Photos');
    var now = new Date().toISOString();
    var newRows = built.map(function (x) {
      var links = (x.o.photos || []).slice(0, 6).map(function (ph, k) {
        var blob = Utilities.newBlob(Utilities.base64Decode(ph.data), ph.type || 'image/jpeg', x.cm + '-' + (k + 1) + '-' + (ph.name || 'photo.jpg'));
        return photoFolder.createFile(blob).getUrl();
      });
      return {
        'CM#': x.cm, 'Batch ID': batchId, 'Submitted': now, 'Rep Name': clean_(rep.name), 'Rep Email': clean_(rep.email).toLowerCase(),
        'CC Emails': clean_(b.cc), 'Store': clean_(b.store).toUpperCase(), 'Facility #': b.nonAafes ? '' : facility,
        'Type': x.type, 'Brand': x.brand, 'Gender': clean_(x.o.gender), 'Order #': x.orderNo,
        'Styles (JSON)': JSON.stringify(x.styles), 'Shipped Date': x.o.shipped || '',
        'Promo ID': x.promo ? x.promo['Promo ID'] : '', 'Promo Title': x.promo ? x.promo['Event'] : clean_(x.o.promoTitle).toUpperCase(),
        'Promo Start': x.o.promoStart || (x.promo ? x.promo['Event Date'] : ''),
        'Promo Approved?': x.type === 'PR' ? (x.promo ? 'Y' : 'N') : '', 'Warnings': x.warnings.join('\n'),
        'Comments': clean_(x.o.comments), 'Photo Links': links.join('\n'), 'Amount': x.amount, 'Status': 'Pending', 'Source': 'portal'
      };
    });
    appendRows_('Memos', newRows);
    log_('submit', batchId + ' ' + newRows.map(function (r) { return r['CM#']; }).join(','));
  } finally { lock.releaseLock(); }

  sendApprovalEmail_(batchId, newRows, cfg);
  var unapproved = newRows.filter(function (r) { return r['Promo Approved?'] === 'N'; });
  if (unapproved.length && cfg.ADMIN_EMAIL) {
    MailApp.sendEmail({
      to: cfg.ADMIN_EMAIL,
      subject: 'Heads-up: unapproved promo submitted — ' + newRows[0]['Store'] + ' (' + newRows[0]['Rep Name'] + ')',
      htmlBody: '<p>' + esc_(newRows[0]['Rep Name']) + ' requested credit memos for a promo that is not on the approved list:</p><ul>' +
        unapproved.map(function (r) { return '<li>' + r['CM#'] + ' — ' + esc_(r['Brand']) + ' — "' + esc_(r['Promo Title'] || '(no title)') + '" — $' + fmt_(r['Amount']) + '</li>'; }).join('') +
        '</ul><p>The manager has been asked to approve them as usual. If he approved this promo, you can add it from the dashboard (Promos tab → Add promo).</p>'
    });
  }
  return { ok: true, batchId: batchId, memos: newRows.map(function (r) { return { cm: r['CM#'], amount: r['Amount'], warnings: r['Warnings'] ? r['Warnings'].split('\n') : [] }; }) };
}

function sendApprovalEmail_(batchId, rows, cfg) {
  if (!cfg.MANAGER_EMAIL) { log_('email', 'MANAGER_EMAIL not set'); return; }
  var url = (cfg.WEB_APP_URL || ScriptApp.getService().getUrl()) + '?page=review&b=' + encodeURIComponent(batchId) + '&t=' + sign_(batchId);
  var total = rows.reduce(function (t, r) { return t + Number(r['Amount']); }, 0);
  var anyWarn = rows.some(function (r) { return r['Warnings']; });
  var tr = rows.map(function (r) {
    var w = r['Warnings'] ? '<div style="color:#9a5b00;font-size:12px;margin-top:4px">⚠ ' + esc_(r['Warnings']).replace(/\n/g, '<br>⚠ ') + '</div>' : '';
    return '<tr><td style="padding:8px;border-bottom:1px solid #eee"><b>' + r['CM#'] + '</b><br><span style="color:#666;font-size:12px">' +
      (r['Type'] === 'PR' ? 'Promo: ' + esc_(r['Promo Title'] || '—') : 'Markdown') + '</span>' + w + '</td>' +
      '<td style="padding:8px;border-bottom:1px solid #eee">' + esc_(r['Brand']) + ' ' + esc_(r['Gender']) + '</td>' +
      '<td style="padding:8px;border-bottom:1px solid #eee;text-align:right">$' + fmt_(r['Amount']) + '</td></tr>';
  }).join('');
  var html = '<div style="font-family:Arial,sans-serif;max-width:640px">' +
    '<p><b>' + esc_(rows[0]['Rep Name']) + '</b> requested ' + rows.length + ' credit memo' + (rows.length > 1 ? 's' : '') +
    ' for <b>' + esc_(rows[0]['Store']) + '</b>' + (rows[0]['Facility #'] ? ' (' + rows[0]['Facility #'] + ')' : '') + '.</p>' +
    (anyWarn ? '<p style="background:#fff4e0;padding:8px;border-radius:4px;color:#7a4a00">⚠ Some items need a closer look — see the notes below.</p>' : '') +
    '<table style="border-collapse:collapse;width:100%;font-size:14px">' + tr +
    '<tr><td colspan="2" style="padding:8px;text-align:right"><b>Total</b></td><td style="padding:8px;text-align:right"><b>$' + fmt_(total) + '</b></td></tr></table>' +
    '<p style="margin:24px 0"><a href="' + url + '" style="background:#1f4e8c;color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none;font-weight:bold">Review &amp; approve</a></p>' +
    '<p style="color:#888;font-size:12px">You can approve all at once or approve/reject each order on the next page.</p></div>';
  MailApp.sendEmail({
    to: cfg.MANAGER_EMAIL,
    subject: (anyWarn ? '⚠ ' : '') + 'Credit memo approval: ' + rows[0]['Store'] + ' — ' + rows.length + ' order' + (rows.length > 1 ? 's' : '') + ', $' + fmt_(total) + ' (' + rows[0]['Rep Name'] + ')',
    htmlBody: html
  });
}

// ======================================================================
// Manager review / approval
// ======================================================================
function getBatchForReview_(batchId) {
  return readTable_('Memos').rows.filter(function (m) { return m['Batch ID'] === batchId; }).map(memoView_);
}

function memoView_(m) {
  return {
    cm: m['CM#'], status: m['Status'], rep: m['Rep Name'], store: m['Store'], facility: m['Facility #'], type: m['Type'],
    brand: m['Brand'], gender: m['Gender'], orderNo: m['Order #'], styles: safeJson_(m['Styles (JSON)'], []),
    shipped: m['Shipped Date'], promoTitle: m['Promo Title'], promoApproved: m['Promo Approved?'], promoStart: m['Promo Start'],
    warnings: m['Warnings'] ? String(m['Warnings']).split('\n') : [], comments: m['Comments'],
    photos: m['Photo Links'] ? String(m['Photo Links']).split('\n') : [], amount: Number(m['Amount']), submitted: m['Submitted'],
    pdf: m['PDF Link'], decidedAt: m['Decided At'], note: m['Decision Note']
  };
}

/** Called from Review.html. decisions: [{cm, approve:true|false, note}] */
function decideBatch(batchId, token, decisions) {
  if (!verify_(batchId, token)) throw new Error('This approval link is not valid.');
  var cfg = getSettings_();
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  var results = [];
  try {
    var t = readTable_('Memos');
    decisions.forEach(function (d) {
      var idx = t.rows.findIndex(function (m) { return m['CM#'] === d.cm && m['Batch ID'] === batchId; });
      if (idx < 0) { results.push({ cm: d.cm, ok: false, msg: 'not found' }); return; }
      var m = t.rows[idx];
      if (m['Status'] !== 'Pending') { results.push({ cm: d.cm, ok: true, msg: 'already ' + m['Status'].toLowerCase() }); return; }
      var upd = { 'Status': d.approve ? 'Approved' : 'Rejected', 'Decided At': new Date().toISOString(), 'Decision Note': clean_(d.note) };
      if (d.approve) {
        upd['Issue Date'] = Utilities.formatDate(new Date(), 'America/New_York', 'yyyy-MM-dd');
        var merged = Object.assign({}, m, upd);
        var pdf = makeMemoPdf_(merged, cfg);
        upd['PDF Link'] = pdf.getUrl();
        emailMemo_(merged, pdf, cfg);
      } else {
        emailRejection_(Object.assign({}, m, upd), cfg);
      }
      updateRow_('Memos', t, idx, upd);
      results.push({ cm: d.cm, ok: true, msg: d.approve ? 'approved — memo emailed' : 'rejected — rep notified' });
    });
  } finally { lock.releaseLock(); }
  log_('decide', batchId + ' ' + JSON.stringify(results));
  return results;
}

function makeMemoPdf_(m, cfg) {
  return DriveApp.getFolderById(cfg.DRIVE_FOLDER_ID).createFile(memoPdfBlob_(m, cfg));
}

/** opts.adjusted: show the CCV-adjusted amount (memo corrected by a few cents) */
function memoPdfBlob_(m, cfg, opts) {
  opts = opts || {};
  var t = HtmlService.createTemplateFromFile('MemoPdf');
  var issue = new Date(m['Issue Date'] + 'T12:00:00');
  var validThru = new Date(issue.getTime() + Number(cfg.VALID_DAYS || 90) * 86400000);
  t.m = {
    cm: m['CM#'], brand: m['Brand'], gender: m['Gender'], rep: m['Rep Name'], store: m['Store'], facility: m['Facility #'] || 'N/A',
    typeLabel: TYPE_LABEL[m['Type']], rate: m['Type'] === 'MD' ? '12.5%' : '10%', vendor: cfg['VENDOR_' + m['Brand']] || '', orderNo: m['Order #'],
    shipped: m['Shipped Date'] ? Utilities.formatDate(new Date(m['Shipped Date'] + 'T12:00:00'), 'America/New_York', 'MMMM d, yyyy') : '',
    promo: m['Type'] === 'PR' ? m['Promo Title'] : '', styles: safeJson_(m['Styles (JSON)'], []), amount: fmt_(m['Amount']),
    issued: Utilities.formatDate(issue, 'America/New_York', 'MMMM d, yyyy'),
    validThru: Utilities.formatDate(validThru, 'America/New_York', 'MMMM d, yyyy'),
    comments: m['Comments'], validDays: cfg.VALID_DAYS || 90, adjustedFrom: ''
  };
  if (opts.adjusted && m['Adjusted Amount'] !== '' && m['Adjusted Amount'] != null && Number(m['Adjusted Amount']) !== Number(m['Amount'])) {
    t.m.adjustedFrom = fmt_(m['Amount']); t.m.amount = fmt_(m['Adjusted Amount']);
  }
  return t.evaluate().getBlob().getAs('application/pdf').setName(m['CM#'] + '.pdf');
}

// ======================================================================
// CCV packets (CCV page(s) + credit memo, one PDF) emailed to Kathleen
// ======================================================================
function packetEligible_(m) {
  return m['Status'] === 'Approved' && !!m['CCV #s'] && /^Matched|^Resolved/.test(String(m['Match Status'] || ''));
}

/** Everything the dashboard needs to build one packet. */
function getPacketJob(cm) {
  var cfg = getSettings_();
  var m = readTable_('Memos').rows.filter(function (x) { return x['CM#'] === cm && x['Status'] !== 'Rejected'; })[0];
  if (!m) throw new Error('Memo not found: ' + cm);
  if (!packetEligible_(m)) throw new Error(cm + ' is not fully matched yet.');
  var ccvs = readTable_('CCVs').rows.filter(function (c) { return c['Matched CM#'] === cm; })
    .sort(function (a, b) { return String(a['CCV Date']).localeCompare(String(b['CCV Date'])) || String(a['CCV #']).localeCompare(String(b['CCV #'])); });
  var main = ccvs.filter(function (c) { return Number(c['Amount']) > 0; }).pop() || ccvs[ccvs.length - 1];
  var blob = memoPdfBlob_(m, cfg, { adjusted: true });
  return {
    cm: cm, store: m['Store'], amount: Number(m['Adjusted Amount'] !== '' && m['Adjusted Amount'] != null ? m['Adjusted Amount'] : m['Amount']),
    mainCcv: main ? main['CCV #'] : '', fileTemplate: cfg.PACKET_FILE_NAME || '{ccv}_{cm}.pdf',
    summary: { cm: cm, type: m['Type'], brand: m['Brand'], store: m['Store'], facility: m['Facility #'], orderNo: m['Order #'], rep: m['Rep Name'],
      issueDate: m['Issue Date'], promo: m['Type'] === 'PR' ? m['Promo Title'] : '', memoAmount: Number(m['Amount']),
      ccvAmount: ccvs.reduce(function (t, c) { return t + (Number(c['Amount']) || 0); }, 0),
      finalAmount: Number(m['Adjusted Amount'] !== '' && m['Adjusted Amount'] != null ? m['Adjusted Amount'] : m['Amount']),
      ccvNumbers: ccvs.map(function (c) { return c['CCV #']; }).join(', '), ccvDate: main ? main['CCV Date'] : '',
      aafesFacility: main ? main['AAFES Facility #'] : '' },
    ccvs: ccvs.map(function (c) {
      return { ccvNumber: c['CCV #'], raw: c['Raw Text'] || '', ccvDate: c['CCV Date'], amount: Number(c['Amount']), dueTo: c['Due To'],
        vendorNumber: c['Vendor #'], returnAuth: c['Return Auth'], comments: c['Comments'], itemsText: c['Items'],
        facilityNumber: c['AAFES Facility #'], facilityName: c['Facility Name'] };
    }),
    memoPdfB64: Utilities.base64Encode(blob.getBytes())
  };
}

/** packets: [{cm, fileName, b64}] built in the dashboard; summary: {fileName, b64} .xlsx (batch mode). */
function sendPackets(packets, summary) {
  var cfg = getSettings_();
  if (!cfg.PACKET_TO) throw new Error('PACKET_TO is not set on the Settings tab.');
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var t = readTable_('Memos');
    var root = DriveApp.getFolderById(cfg.DRIVE_FOLDER_ID);
    var it = root.getFoldersByName('CCV Packets'), folder = it.hasNext() ? it.next() : root.createFolder('CCV Packets');
    var cc = String(cfg.PACKET_CC || '').split(/[,;\s]+/).filter(Boolean).join(',');
    var recipients = 1 + (cc ? cc.split(',').length : 0);
    var mode = String(cfg.PACKET_EMAIL_MODE || 'batch').toLowerCase();
    var quota = MailApp.getRemainingDailyQuota();
    var note = '';
    if (mode === 'each' && packets.length * recipients > quota) { mode = 'batch'; note = 'Not enough email quota left today to send them one by one, so they went in one email.'; }
    if (recipients > quota) throw new Error('Google\'s daily email limit is used up — try again tomorrow.');
    var items = packets.map(function (p) {
      var idx = t.rows.findIndex(function (m) { return m['CM#'] === p.cm && m['Status'] !== 'Rejected'; });
      if (idx < 0) throw new Error('Memo not found: ' + p.cm);
      var blob = Utilities.newBlob(Utilities.base64Decode(p.b64), 'application/pdf', p.fileName);
      var file = folder.createFile(blob);
      return { p: p, idx: idx, m: t.rows[idx], blob: blob, file: file };
    });
    function line(x) {
      var amt = x.m['Adjusted Amount'] !== '' && x.m['Adjusted Amount'] != null ? x.m['Adjusted Amount'] : x.m['Amount'];
      return { text: x.p.fileName + ' — ' + x.m['Store'] + ' — ' + x.m['Brand'] + ' — $' + fmt_(amt), amt: Number(amt) };
    }
    var summaryBlob = null, summaryFile = null;
    if (mode === 'batch' && summary && summary.b64) {
      summaryBlob = Utilities.newBlob(Utilities.base64Decode(summary.b64), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', summary.fileName);
      summaryFile = folder.createFile(summaryBlob);
    }
    if (mode === 'batch') {
      var total = items.reduce(function (s, x) { return s + line(x).amt; }, 0);
      MailApp.sendEmail({ to: cfg.PACKET_TO, cc: cc,
        subject: 'CCVs & credit memos — ' + items.length + ' attached — $' + fmt_(total),
        htmlBody: '<div style="font-family:Arial,sans-serif"><p>Hi Kathleen,</p><p>Attached are ' + items.length + ' CCV' + (items.length > 1 ? 's' : '') + ' with the matching credit memo' + (items.length > 1 ? 's' : '') +
          (summaryBlob ? ', plus a summary spreadsheet' : '') + ':</p>' +
          '<table style="border-collapse:collapse;font-size:13px">' + items.map(function (x) {
            var amt = line(x).amt;
            return '<tr><td style="padding:3px 10px 3px 0">' + esc_(x.p.fileName) + '</td><td style="padding:3px 10px">' + esc_(x.m['Store']) + '</td><td style="padding:3px 10px">' + esc_(x.m['Brand']) + '</td><td style="padding:3px 0;text-align:right">$' + fmt_(amt) + '</td></tr>';
          }).join('') + '<tr><td colspan="3" style="padding:6px 10px 0 0;text-align:right"><b>Total</b></td><td style="padding:6px 0 0;text-align:right"><b>$' + fmt_(total) + '</b></td></tr></table>' +
          '<p>Thank you!</p></div>',
        attachments: (summaryBlob ? [summaryBlob] : []).concat(items.map(function (x) { return x.blob; })) });
    } else {
      items.forEach(function (x) {
        MailApp.sendEmail({ to: cfg.PACKET_TO, cc: cc,
          subject: x.p.fileName.replace(/\.pdf$/i, '') + ' — ' + x.m['Store'],
          htmlBody: '<div style="font-family:Arial,sans-serif"><p>Hi Kathleen,</p><p>Attached is the CCV with its matching credit memo: ' + esc_(line(x).text) + '.</p><p>Thank you!</p></div>',
          attachments: [x.blob] });
      });
    }
    var now = new Date().toISOString();
    items.forEach(function (x) { updateRow_('Memos', t, x.idx, { 'Packet Sent': now, 'Packet File': x.p.fileName, 'Packet Link': x.file.getUrl() }); });
    log_('sendPackets', mode + ' ' + items.map(function (x) { return x.p.fileName; }).join(', ') + (summaryFile ? ' + ' + summary.fileName : ''));
    return { sent: items.length, mode: mode, note: note, summaryLink: summaryFile ? summaryFile.getUrl() : '' };
  } finally { lock.releaseLock(); }
}

/** Save a preview copy to Drive (CCV Packets/Previews) and return its link. */
function savePacketPreview(fileName, b64) {
  var cfg = getSettings_();
  var root = DriveApp.getFolderById(cfg.DRIVE_FOLDER_ID);
  var it = root.getFoldersByName('CCV Packets'), folder = it.hasNext() ? it.next() : root.createFolder('CCV Packets');
  var it2 = folder.getFoldersByName('Previews'), pv = it2.hasNext() ? it2.next() : folder.createFolder('Previews');
  return pv.createFile(Utilities.newBlob(Utilities.base64Decode(b64), 'application/pdf', 'PREVIEW ' + fileName)).getUrl();
}

/** Clear the "sent" mark so a packet shows as ready again (e.g. to re-send after a correction). */
function resetPacket(cm) {
  var t = readTable_('Memos');
  var i = t.rows.findIndex(function (m) { return m['CM#'] === cm && m['Status'] !== 'Rejected'; });
  if (i < 0) throw new Error('Memo not found');
  updateRow_('Memos', t, i, { 'Packet Sent': '' });
  return true;
}

function emailMemo_(m, pdfFile, cfg) {
  var to = [m['Rep Email']].concat(String(m['CC Emails'] || '').split(/[,;\s]+/)).filter(Boolean).join(',');
  var cc = [cfg.MANAGER_EMAIL, cfg.ADMIN_EMAIL].filter(Boolean).join(',');
  MailApp.sendEmail({
    to: to, cc: cc,
    subject: 'Credit memo ' + m['CM#'] + ' approved — ' + m['Store'] + ' — $' + fmt_(m['Amount']),
    htmlBody: '<div style="font-family:Arial,sans-serif"><p>Credit memo <b>' + m['CM#'] + '</b> for <b>' + esc_(m['Store']) + '</b> (' +
      esc_(m['Brand']) + ', $' + fmt_(m['Amount']) + ') has been approved. The PDF is attached.</p>' +
      '<p>Please give it to the store. <b>The store must put CM# ' + m['CM#'] + ' on the CCV</b>, and the CCV must be for exactly $' + fmt_(m['Amount']) + '.</p>' +
      '<p style="color:#666">Valid for ' + (cfg.VALID_DAYS || 90) + ' days from today.</p>' +
      (m['Decision Note'] ? '<p>Manager note: ' + esc_(m['Decision Note']) + '</p>' : '') + '</div>',
    attachments: [pdfFile.getBlob()]
  });
}

function emailRejection_(m, cfg) {
  MailApp.sendEmail({
    to: m['Rep Email'], cc: cfg.ADMIN_EMAIL || '',
    subject: 'Credit memo request not approved — ' + m['CM#'] + ' (' + m['Store'] + ')',
    htmlBody: '<div style="font-family:Arial,sans-serif"><p>Your credit memo request <b>' + m['CM#'] + '</b> for ' + esc_(m['Store']) +
      ' ($' + fmt_(m['Amount']) + ') was not approved.</p>' + (m['Decision Note'] ? '<p>Reason: ' + esc_(m['Decision Note']) + '</p>' : '') +
      '<p>If you fix the issue you can submit it again from the sales portal.</p></div>'
  });
}

// ======================================================================
// Budget
// ======================================================================
/**
 * Budget for the fiscal year starting April 1 of `fyStart` (month set by FISCAL_YEAR_START_MONTH).
 *  - ccvd:    every CCV dated inside the fiscal year, linked to a memo (reversals count negative).
 *  - open / pending / planned: money not yet CCV'd. There's no CCV date yet, so it counts toward
 *    the CURRENT fiscal year only (viewing a past year shows actuals only).
 */
function fyStartFor_(d, cfg) {
  var sm = Number((cfg || {}).FISCAL_YEAR_START_MONTH || 4);
  var s = Utilities.formatDate(d, 'America/New_York', 'yyyy-MM').split('-');
  return (+s[1] >= sm) ? +s[0] : +s[0] - 1;
}
function fyRange_(fyStart, cfg) {
  var sm = Number((cfg || {}).FISCAL_YEAR_START_MONTH || 4);
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  return { from: fyStart + '-' + pad(sm) + '-01', to: (fyStart + 1) + '-' + pad(sm) + '-01' };   // [from, to)
}
function goLiveIso_(cfg) {
  var v = cfg.GO_LIVE_DATE;
  if (v instanceof Date) return Utilities.formatDate(v, 'America/New_York', 'yyyy-MM-dd');
  v = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
}
function computeBudget_(fyStart, memos, promos, cfg, ccvs) {
  var incMD = String(cfg.BUDGET_INCLUDES_MARKDOWNS).toUpperCase() !== 'FALSE';
  var grace = Number(cfg.CCV_GRACE_DAYS || 100), lookback = Number(cfg.PLANNED_PROMO_LOOKBACK_DAYS || 180);
  var today = new Date(), range = fyRange_(fyStart, cfg);
  var isCurrent = fyStartFor_(today, cfg) === fyStart;
  var inFY = function (iso) { return iso && iso >= range.from && iso < range.to; };
  var out = { _promoUsed: {}, _meta: { fyStart: fyStart, from: range.from, to: range.to, isCurrent: isCurrent, includesMarkdowns: incMD, unmatchedCCVs: 0, unmatchedCount: 0 } };
  BRANDS.forEach(function (b) {
    out[b] = { budget: Number(cfg['BUDGET_' + b]) || 0, carryIn: 0, ccvd: 0, open: 0, pending: 0, planned: 0, committed: 0, remaining: 0 };
  });
  var goLive = goLiveIso_(cfg);
  if (goLive && inFY(goLive)) BRANDS.forEach(function (b) { out[b].carryIn = Number(cfg['CARRY_IN_' + b]) || 0; });
  out._meta.goLive = goLive;
  var byCm = {};
  memos.forEach(function (m) { if (m['Status'] !== 'Rejected') byCm[m['CM#']] = m; });
  // Actuals: CCVs by CCV date
  (ccvs || []).forEach(function (c) {
    if (c['Kind'] === 'Not ours' || c['Kind'] === 'Old system' || !inFY(String(c['CCV Date']))) return;
    var m = c['Matched CM#'] && byCm[c['Matched CM#']];
    if (!m) { out._meta.unmatchedCCVs += Number(c['Amount']) || 0; out._meta.unmatchedCount++; return; }
    if (m['Type'] === 'MD' && !incMD) return;
    if (out[m['Brand']]) out[m['Brand']].ccvd += Number(c['Amount']) || 0;
  });
  memos.forEach(function (m) {
    if (m['Status'] === 'Rejected' || m['Status'] === 'Void') return;
    if (m['Promo ID']) out._promoUsed[m['Promo ID'] + '|' + m['Brand']] = true;
    var B = out[m['Brand']]; if (!B || !isCurrent) return;
    if (m['Type'] === 'MD' && !incMD) return;
    var when = m['Issue Date'] || String(m['Submitted'] || '').slice(0, 10);
    if (m['Status'] === 'Pending') { B.pending += Number(m['Amount']) || 0; return; }
    if (m['Match Status'] === 'Reversed — awaiting new CCV') { B.open += Number(m['Amount']) || 0; return; }
    if (m['CCV #s'] || m['Match Status'] === 'Expired' || m['Match Status'] === 'Resolved') return;
    if (when && daysBetween_(new Date(when + 'T12:00:00'), today) <= grace) B.open += Number(m['Amount']) || 0;
  });
  // Approved promos with no memo yet for that brand (current year only; skip events long past)
  if (isCurrent) promos.forEach(function (p) {
    var ev = String(p['Event Date'] || '');
    if (ev) { if (ev >= range.to) return; if (ev < range.from && daysBetween_(new Date(ev + 'T12:00:00'), today) > lookback) return; }
    else if (Number(p['Year']) < Number(range.from.slice(0, 4))) return;
    BRANDS.forEach(function (b) {
      if (out._promoUsed[p['Promo ID'] + '|' + b]) return;
      out[b].planned += Number(p['Open ' + b]) || 0;
    });
  });
  out._meta.unmatchedCCVs = round2_(out._meta.unmatchedCCVs);
  BRANDS.forEach(function (b) {
    var B = out[b];
    ['carryIn', 'ccvd', 'open', 'pending', 'planned'].forEach(function (k) { B[k] = round2_(B[k]); });
    B.committed = round2_(B.carryIn + B.ccvd + B.open + B.pending + B.planned);
    B.remaining = round2_(B.budget - B.committed);
  });
  return out;
}

// ======================================================================
// Promos for the rep form
// ======================================================================
function getPromosForForm_() {
  var year = new Date().getFullYear();
  return readTable_('Promos').rows.filter(function (p) { return Number(p['Year']) >= year - 1; }).map(function (p) {
    var lines = safeJson_(p['Lines (JSON)'], []);
    var brands = {};
    lines.forEach(function (l) { var a = brands[l.brand] = brands[l.brand] || []; if (l.style && a.indexOf(l.style) < 0) a.push(l.style); });
    return { id: p['Promo ID'], year: Number(p['Year']), store: p['Store'], facility: p['Facility #'], event: p['Event'],
      eventDate: p['Event Date'], dateText: p['Date Text'], rep: p['Rep'], brands: brands };
  });
}

// ======================================================================
// Dashboard API (called via google.script.run from Dashboard.html — spreadsheet users only)
// ======================================================================
function getDashboardData(year) {
  var cfg = getSettings_();
  year = Number(year) || fyStartFor_(new Date(), cfg);
  var memos = readTable_('Memos').rows, promos = readTable_('Promos').rows, ccvs = readTable_('CCVs').rows;
  var budget = computeBudget_(year, memos, promos, cfg, ccvs);
  var suggestions = suggestionsFor_(ccvs, memos, cfg);
  var budgetMeta = budget._meta;
  delete budget._promoUsed; delete budget._meta;
  var today = new Date(), warn = Number(cfg.EXPIRING_WARN_DAYS || 80), grace = Number(cfg.CCV_GRACE_DAYS || 100);
  var used = {};
  memos.forEach(function (m) { if (m['Promo ID'] && m['Status'] !== 'Rejected' && m['Status'] !== 'Void') used[m['Promo ID'] + '|' + m['Brand']] = m['CM#']; });
  return {
    year: year, budget: budget, budgetMeta: budgetMeta, currentFY: fyStartFor_(new Date(), cfg), brands: BRANDS, suggestions: suggestions,
    settings: { packetTo: cfg.PACKET_TO, packetCc: cfg.PACKET_CC, packetMode: cfg.PACKET_EMAIL_MODE || 'batch', packetFile: cfg.PACKET_FILE_NAME || '{ccv}_{cm}.pdf', goLive: goLiveIso_(cfg), tolerance: Number(cfg.MATCH_TOLERANCE || 1), grace: grace, warn: warn, managerEmail: cfg.MANAGER_EMAIL, webAppUrl: cfg.WEB_APP_URL },
    memos: memos.map(function (m) {
      var v = memoView_(m);
      v.issueDate = m['Issue Date'] || ''; v.ccvs = m['CCV #s'] || ''; v.ccvDate = m['CCV Date'] || '';
      v.ccvAmount = m['CCV Amount'] === '' ? null : Number(m['CCV Amount']); v.match = m['Match Status'] || '';
      v.adjusted = m['Adjusted Amount'] === '' ? null : Number(m['Adjusted Amount']); v.matchNote = m['Match Note'] || ''; v.source = m['Source'];
      v.promoId = m['Promo ID'];
      v.packetSent = m['Packet Sent'] || ''; v.packetFile = m['Packet File'] || ''; v.packetLink = m['Packet Link'] || '';
      v.packetReady = packetEligible_(m) && !v.packetSent;
      var age = v.issueDate ? daysBetween_(new Date(v.issueDate + 'T12:00:00'), today) : null;
      v.age = age;
      v.state = m['Status'] !== 'Approved' ? m['Status']
        : v.match === 'Reversal needed' ? 'Reversal needed'
        : v.ccvs ? (v.match || 'Matched')
        : age != null && age > grace ? 'Expired'
        : age != null && age > warn ? 'Expiring' : 'Open';
      return v;
    }),
    ccvs: ccvs.map(function (c) {
      return { ccv: c['CCV #'], date: c['CCV Date'], amount: Number(c['Amount']), vendor: c['Vendor #'], facility: c['AAFES Facility #'],
        facilityName: c['Facility Name'], returnAuth: c['Return Auth'], comments: c['Comments'], cm: c['Matched CM#'], note: c['Match Note'], imported: c['Imported At'],
        kind: c['Kind'] || 'Credit memo', dueTo: c['Due To'] || '', items: c['Items'], vendorNo: c['Vendor #'] };
    }),
    promos: promos.map(function (p) {
      var o = { id: p['Promo ID'], year: Number(p['Year']), store: p['Store'], facility: p['Facility #'], event: p['Event'],
        eventDate: p['Event Date'], dateText: p['Date Text'], rep: p['Rep'], display: p['Display'], source: p['Source'],
        lines: safeJson_(p['Lines (JSON)'], []), planned: {}, open: {}, memo: {} };
      BRANDS.forEach(function (b) { o.planned[b] = Number(p['Planned ' + b]) || 0; o.open[b] = Number(p['Open ' + b]) || 0; o.memo[b] = used[o.id + '|' + b] || ''; });
      return o;
    })
  };
}

/** Replace recap-sourced promos for that year with freshly parsed events (manual promos are kept). */
function importPromos(parsed, fileName) {
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var t = readTable_('Promos');
    var year = Number(parsed.year);
    var keep = t.rows.filter(function (p) { return !(Number(p['Year']) === year && p['Source'] !== 'manual'); });
    var now = new Date().toISOString();
    var fresh = parsed.events.map(function (e) {
      var r = { 'Promo ID': e.id, 'Year': year, 'Store': e.store, 'Facility #': e.facility, 'Event': e.event, 'Event Date': e.eventDate,
        'Date Text': e.eventDateText, 'Rep': e.rep, 'Display': e.display, 'Lines (JSON)': JSON.stringify(e.lines),
        'Source': 'recap: ' + (fileName || ''), 'Imported At': now };
      BRANDS.forEach(function (b) { r['Planned ' + b] = e.planned[b] || 0; r['Open ' + b] = e.plannedOpen[b] || 0; });
      return r;
    });
    // a manual promo with the same ID is superseded by the recap version
    var freshIds = {}; fresh.forEach(function (r) { freshIds[r['Promo ID']] = 1; });
    keep = keep.filter(function (p) { return !freshIds[p['Promo ID']]; });
    rewriteTable_('Promos', keep.concat(fresh));
    // link earlier "unapproved" requests whose title now matches an approved event at the same facility/store
    var linked = relinkUnapprovedPromos_();
    log_('importPromos', fileName + ': ' + fresh.length + ' events; relinked ' + linked);
    return { imported: fresh.length, relinked: linked };
  } finally { lock.releaseLock(); }
}

function addManualPromo(p) {
  var year = Number(p.year) || new Date().getFullYear();
  var id = [norm_(p.store), norm_(p.event), year].join('|');
  var lines = [];
  BRANDS.forEach(function (b) {
    var amt = Number((p.amounts || {})[b]) || 0;
    if (amt) lines.push({ brand: b, style: clean_((p.styles || {})[b]).toUpperCase(), sold: round2_(amt * 10), planned: amt, submitted: false });
  });
  var r = { 'Promo ID': id, 'Year': year, 'Store': clean_(p.store).toUpperCase(), 'Facility #': String(p.facility || '').replace(/\D/g, ''),
    'Event': clean_(p.event).toUpperCase(), 'Event Date': p.eventDate || '', 'Date Text': '', 'Rep': clean_(p.rep), 'Display': '',
    'Lines (JSON)': JSON.stringify(lines), 'Source': 'manual', 'Imported At': new Date().toISOString() };
  BRANDS.forEach(function (b) { var a = Number((p.amounts || {})[b]) || 0; r['Planned ' + b] = a; r['Open ' + b] = a; });
  var t = readTable_('Promos');
  var idx = t.rows.findIndex(function (x) { return x['Promo ID'] === id; });
  if (idx >= 0) updateRow_('Promos', t, idx, r); else appendRows_('Promos', [r]);
  if (p.linkCm) linkMemoToPromo(p.linkCm, id);
  return id;
}

function linkMemoToPromo(cm, promoId) {
  var t = readTable_('Memos');
  var idx = t.rows.findIndex(function (m) { return m['CM#'] === cm; });
  if (idx < 0) throw new Error('Memo not found: ' + cm);
  var p = readTable_('Promos').rows.filter(function (x) { return x['Promo ID'] === promoId; })[0];
  updateRow_('Memos', t, idx, { 'Promo ID': promoId, 'Promo Approved?': 'Y', 'Promo Title': p ? p['Event'] : t.rows[idx]['Promo Title'] });
  return true;
}

function relinkUnapprovedPromos_() {
  var promos = readTable_('Promos').rows, t = readTable_('Memos'), n = 0;
  t.rows.forEach(function (m, i) {
    if (m['Type'] !== 'PR' || m['Promo ID']) return;
    var title = norm_(m['Promo Title']).replace(/^CUSTOMPROMO/, '');
    if (!title) return;
    var hit = promos.filter(function (p) {
      var sameStore = (p['Facility #'] && p['Facility #'] === m['Facility #']) || norm_(p['Store']) === norm_(m['Store']);
      return sameStore && (norm_(p['Event']) === title || norm_(p['Event']).indexOf(title) >= 0 || title.indexOf(norm_(p['Event'])) >= 0);
    });
    if (hit.length === 1) { updateRow_('Memos', t, i, { 'Promo ID': hit[0]['Promo ID'], 'Promo Approved?': 'Y' }); n++; }
  });
  return n;
}

/** Import old Google Form responses so CCVs for older memos can be matched. */
function importHistory(list) {
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var existing = {}; readTable_('Memos').rows.forEach(function (m) { existing[m['CM#']] = 1; });
    var rows = list.filter(function (h) { return !existing[h.cm]; }).map(function (h) {
      var issue = String(h.submittedAt || '').slice(0, 10);
      return { 'CM#': h.cm, 'Batch ID': 'HISTORY', 'Submitted': h.submittedAt, 'Rep Name': h.repName, 'Rep Email': h.repEmail,
        'Store': String(h.store).toUpperCase(), 'Facility #': h.facility, 'Type': h.type, 'Brand': h.brand, 'Gender': h.gender,
        'Order #': h.orderNo, 'Styles (JSON)': JSON.stringify(h.styles), 'Shipped Date': h.shipped, 'Promo Title': String(h.promoTitle || '').toUpperCase(),
        'Promo Start': h.promoStart, 'Promo Approved?': h.type === 'PR' ? 'N' : '', 'Comments': h.comments, 'Amount': h.amount,
        'Status': /approved/i.test(h.status) ? 'Approved' : /reject|denied/i.test(h.status) ? 'Rejected' : h.status,
        'Issue Date': issue, 'PDF Link': h.pdfUrl, 'Source': 'history' };
    });
    appendRows_('Memos', rows);
    var linked = relinkUnapprovedPromos_();
    var rematched = rematchAll_();
    log_('importHistory', rows.length + ' rows');
    return { imported: rows.length, skipped: list.length - rows.length, relinked: linked, rematched: rematched };
  } finally { lock.releaseLock(); }
}

// ======================================================================
// CCV import & matching
// ======================================================================
/** ccvList: parsed CCV objects from GFSIParsers.parseCCVText */
function importCCVs(ccvList) {
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var have = {}; readTable_('CCVs').rows.forEach(function (c) { have[c['CCV #']] = 1; });
    var now = new Date().toISOString(), fresh = [], dup = 0;
    ccvList.forEach(function (c) {
      if (!c.ccvNumber || have[c.ccvNumber]) { dup++; return; }
      have[c.ccvNumber] = 1;
      fresh.push({ 'CCV #': c.ccvNumber, 'CCV Date': c.ccvDate, 'Amount': c.amount, 'Vendor #': c.vendorNumber,
        'AAFES Facility #': c.facilityNumber, 'Facility Name': c.facilityName, 'Return Auth': c.returnAuth, 'Comments': c.comments,
        'Items': (c.items || []).map(function (i) { return i.description + ' x' + i.qty + ' @' + i.unitCost; }).join('; '),
        'Matched CM#': '', 'Match Note': JSON.stringify(c.cmCandidates || []), 'Imported At': now,
        'Kind': c.kind || (c.cmCandidates && c.cmCandidates.length ? (c.amount < 0 ? 'Reversal' : 'Credit memo') : 'Not ours'),
        'Due To': c.dueTo || (c.amount < 0 ? 'VENDOR' : 'AAFES'), 'Kind Source': 'auto', 'Raw Text': String(c.raw || '').slice(0, 20000) });
    });
    appendRows_('CCVs', fresh);
    var res = rematchAll_();
    log_('importCCVs', fresh.length + ' new, ' + dup + ' duplicates');
    return { added: fresh.length, duplicates: dup, matched: res.matched, unmatched: res.unmatched, reversals: res.reversals, notOurs: res.notOurs,
      awaiting: res.awaiting, oldSystem: res.oldSystem, newIds: fresh.map(function (f) { return f['CCV #']; }) };
  } finally { lock.releaseLock(); }
}

/** Manually tie a CCV to a CM# (or '' to unlink). */
function linkCCV(ccvNo, cm) {
  var t = readTable_('CCVs');
  var i = t.rows.findIndex(function (c) { return c['CCV #'] === ccvNo; });
  if (i < 0) throw new Error('CCV not found');
  cm = cm ? String(cm).toUpperCase().replace(/\s/g, '') : '';
  if (cm && !readTable_('Memos').rows.some(function (m) { return m['CM#'] === cm && m['Status'] !== 'Rejected'; })) throw new Error('No memo ' + cm + ' in the system.');
  var patch = { 'Matched CM#': cm, 'Match Note': cm ? 'manual' : 'unlinked' };
  if (cm && (t.rows[i]['Kind'] === 'Not ours' || t.rows[i]['Kind'] === 'Old system')) { patch['Kind'] = Number(t.rows[i]['Amount']) < 0 ? 'Reversal' : 'Credit memo'; patch['Kind Source'] = 'manual'; }
  updateRow_('CCVs', t, i, patch);
  if (cm) learnFromLink_(t.rows[i], cm);
  log_('linkCCV', ccvNo + ' -> ' + (cm || '(unlinked)'));
  return rematchAll_();
}

/** Link several CCVs at once: pairs = [{ccv, cm}] */
function linkCCVs(pairs) {
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    var t = readTable_('CCVs'), cms = {};
    readTable_('Memos').rows.forEach(function (m) { if (m['Status'] !== 'Rejected') cms[m['CM#']] = 1; });
    var n = 0;
    pairs.forEach(function (p) {
      var i = t.rows.findIndex(function (c) { return c['CCV #'] === p.ccv; });
      if (i < 0 || !cms[p.cm]) return;
      updateRow_('CCVs', t, i, { 'Matched CM#': p.cm, 'Match Note': 'manual (suggested)' }); n++;
      learnFromLink_(t.rows[i], p.cm);
    });
    log_('linkCCVs', JSON.stringify(pairs));
    var r = rematchAll_(); r.linked = n; return r;
  } finally { lock.releaseLock(); }
}

// ======================================================================
// Match suggestions for CCVs with no usable CM#
// ======================================================================
var STORE_STOP = { MAIN: 1, STORE: 1, MCS: 1, MCSS: 1, EXCHANGE: 1, PX: 1, BX: 1, AFB: 1, FT: 1, FORT: 1, BASE: 1, THE: 1, AND: 1 };
function storeTokens_(s) {
  return clean_(s).toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').split(' ').filter(function (w) { return w.length >= 3 && !STORE_STOP[w]; });
}
function readFacilityMap_() {
  var map = {};
  try { readTable_('Facility Map').rows.forEach(function (r) { map[String(r['AAFES Facility #'])] = r; }); } catch (e) {}
  return map;
}
function learnFromLink_(ccvRow, cm) {
  var m = readTable_('Memos').rows.filter(function (x) { return x['CM#'] === cm && x['Status'] !== 'Rejected'; })[0];
  if (m && ccvRow['AAFES Facility #']) learnFacilities_([{ aafes: String(ccvRow['AAFES Facility #']), aafesName: ccvRow['Facility Name'], facility: m['Facility #'], store: m['Store'], source: 'manual' }]);
}

/** Remember which AAFES 10-digit facility belongs to which of our stores (learned from every match). */
function learnFacilities_(pairs) {
  if (!pairs.length) return;
  var sh; try { sh = sheet_('Facility Map'); } catch (e) { return; }
  var t = readTable_('Facility Map'), byKey = {}, now = new Date().toISOString(), add = [];
  t.rows.forEach(function (r, i) { byKey[String(r['AAFES Facility #'])] = i; });
  pairs.forEach(function (p) {
    if (!p.aafes || (!p.facility && !p.store)) return;
    var i = byKey[p.aafes];
    if (i == null) { byKey[p.aafes] = -1; add.push({ 'AAFES Facility #': p.aafes, 'AAFES Name': p.aafesName, 'Facility #': p.facility, 'Store': p.store, 'Source': p.source, 'Updated At': now }); }
    else if (i >= 0 && p.source === 'manual') updateRow_('Facility Map', t, i, { 'AAFES Name': p.aafesName, 'Facility #': p.facility, 'Store': p.store, 'Source': 'manual', 'Updated At': now });
  });
  appendRows_('Facility Map', add);
}

/** Score open memos against one CCV. Returns [{cm, score, reasons:[]}] best first. */
function scoreMemosForCCV_(c, memos, cfg, facMap, claimed) {
  var tol = Number(cfg.MATCH_TOLERANCE || 1), grace = Number(cfg.CCV_GRACE_DAYS || 100);
  var amt = Math.abs(Number(c.amount || c['Amount']) || 0);
  var ccvDate = c.date || c['CCV Date'];
  var text = [c.returnAuth || c['Return Auth'], c.comments || c['Comments'], c.items || c['Items']].join(' ').toUpperCase();
  var digits = text.replace(/[^0-9 ]/g, ' ').replace(/(\d)\s+(?=\d)/g, '$1');   // "1018  7155" -> "10187155"
  var aafes = String(c.facility || c['AAFES Facility #'] || '');
  var mapped = facMap[aafes];
  var ccvTok = storeTokens_(c.facilityName || c['Facility Name']);
  var vend = String(c.vendor || c['Vendor #'] || '').replace(/\D/g, '').replace(/^0+/, '');
  var isRev = (c.kind || c['Kind']) === 'Reversal' || Number(c.amount || c['Amount']) < 0;
  var out = [];
  memos.forEach(function (m) {
    if (m['Status'] !== 'Approved') return;
    if (claimed[m['CM#']] && !isRev && m['Match Status'] !== 'Reversed — awaiting new CCV' && m['Match Status'] !== 'Reversal needed') return;
    var issue = m['Issue Date'] || String(m['Submitted'] || '').slice(0, 10);
    var score = 0, why = [];
    if (issue && ccvDate) {
      var gap = daysBetween_(new Date(issue + 'T12:00:00'), new Date(ccvDate + 'T12:00:00'));
      if (gap < -7 || gap > grace + 60) return;               // CCV can't predate the memo, or come far too late
      if (gap <= grace) { score += 10; } else why.push(gap + ' days after issue');
    }
    var mAmt = Number(m['Amount']) || 0, d = Math.abs(amt - mAmt);
    if (d < 0.005) { score += 45; why.unshift('exact amount'); }
    else if (d < tol) { score += 35; why.unshift('amount within $' + fmt_(d)); }
    else if (mAmt && d / mAmt <= 0.05) { score += 10; why.push('amount off $' + fmt_(d)); }
    var ord = String(m['Order #'] || '');
    if (ord.length >= 6 && digits.indexOf(ord) >= 0) { score += 45; why.unshift('order # ' + ord + ' on CCV'); }
    else if (ord.length >= 6 && digits.indexOf(ord.slice(-5)) >= 0) { score += 12; why.push('ends in ' + ord.slice(-5)); }
    if (mapped && ((mapped['Facility #'] && String(mapped['Facility #']) === String(m['Facility #'])) || norm_(mapped['Store']) === norm_(m['Store']))) { score += 30; why.push('same store (learned)'); }
    else {
      var mt = storeTokens_(m['Store']), shared = mt.filter(function (w) { return ccvTok.indexOf(w) >= 0; });
      if (shared.length) { score += 20; why.push('store name: ' + shared.join(' ')); }
    }
    var want = String(cfg['VENDOR_' + m['Brand']] || '').replace(/\D/g, '').replace(/^0+/, '');
    if (vend && want) { if (vend === want) score += 8; else { score -= 25; why.push('different vendor/brand'); } }
    if (/MARK\s*-?\s*DOWN|12\.5/.test(text)) score += m['Type'] === 'MD' ? 6 : -6;
    if (/PROMO|REBATE|\b10\s*%/.test(text)) score += m['Type'] === 'PR' ? 6 : -6;
    if (score >= 30) out.push({ cm: m['CM#'], score: score, reasons: why, store: m['Store'], amount: mAmt, issueDate: issue, brand: m['Brand'], type: m['Type'] });
  });
  out.sort(function (a, b) { return b.score - a.score; });
  return out.slice(0, 5);
}

/** Suggestions for every unmatched (non "Not ours") CCV. */
function suggestionsFor_(ccvs, memos, cfg) {
  var facMap = readFacilityMap_(), claimed = {};
  ccvs.forEach(function (c) { if (c['Matched CM#']) claimed[c['Matched CM#']] = 1; });
  var out = {};
  ccvs.forEach(function (c) {
    if (c['Matched CM#'] || c['Kind'] === 'Not ours' || c['Kind'] === 'Old system') return;
    var list = scoreMemosForCCV_(c, memos, cfg, facMap, claimed);
    if (list.length) {
      list[0].confident = list[0].score >= 75 && (!list[1] || list[1].score <= list[0].score - 25);
      out[c['CCV #']] = list;
    }
  });
  return out;
}

/** Mark a CCV as 'Not ours' (return/RMA) or 'Old system' (memo from before go-live) — both recorded only — or back to 'Credit memo'. */
function setCCVKind(ccvNo, kind) {
  if (['Not ours', 'Old system', 'Credit memo', 'Reversal'].indexOf(kind) < 0) throw new Error('Bad kind');
  var t = readTable_('CCVs');
  var i = t.rows.findIndex(function (c) { return c['CCV #'] === ccvNo; });
  if (i < 0) throw new Error('CCV not found');
  if (kind === 'Credit memo' && (Number(t.rows[i]['Amount']) < 0 || t.rows[i]['Due To'] === 'VENDOR')) kind = 'Reversal';
  var patch = { 'Kind': kind, 'Kind Source': 'manual' };
  if (kind === 'Not ours' || kind === 'Old system') patch['Matched CM#'] = '';
  updateRow_('CCVs', t, i, patch);
  return rematchAll_();
}

/** Resolve a memo manually: status one of 'Resolved', 'Expired', 'Void', or '' (re-open). */
function setMemoState(cm, state, note) {
  var t = readTable_('Memos');
  var i = t.rows.findIndex(function (m) { return m['CM#'] === cm; });
  if (i < 0) throw new Error('Memo not found');
  var upd = { 'Match Note': clean_(note) };
  if (state === 'Void') upd['Status'] = 'Void';
  else upd['Match Status'] = state;
  updateRow_('Memos', t, i, upd);
  log_('setMemoState', cm + ' -> ' + state + ' ' + (note || ''));
  return true;
}

function resendMemo(cm) {
  var cfg = getSettings_();
  var m = readTable_('Memos').rows.filter(function (x) { return x['CM#'] === cm; })[0];
  if (!m || m['Status'] !== 'Approved') throw new Error('Only approved memos can be re-sent.');
  var id = (String(m['PDF Link']).match(/[-\w]{25,}/) || [])[0];
  var file = id ? DriveApp.getFileById(id) : makeMemoPdf_(m, cfg);
  emailMemo_(m, file, cfg);
  return true;
}

/** Recompute every CCV→memo link and each memo's match status. Idempotent. */
function rematchAll_() {
  var cfg = getSettings_();
  var tol = Number(cfg.MATCH_TOLERANCE || 1), grace = Number(cfg.CCV_GRACE_DAYS || 100);
  var ct = readTable_('CCVs'), mt = readTable_('Memos');
  var byCm = {}; mt.rows.forEach(function (m, i) { if (m['Status'] !== 'Rejected') byCm[m['CM#']] = i; });
  var perMemo = {}, unmatched = 0, notOurs = 0, oldSystem = 0;
  var goLive = goLiveIso_(cfg), oldWindowEnd = '';
  if (goLive) { var gl = new Date(goLive + 'T12:00:00'); gl.setDate(gl.getDate() + grace + 30); oldWindowEnd = Utilities.formatDate(gl, 'America/New_York', 'yyyy-MM-dd'); }
  var facMap = null, claimed = {};
  ct.rows.forEach(function (c) { if (c['Matched CM#']) claimed[c['Matched CM#']] = 1; });
  ct.rows.forEach(function (c, i) {
    if (c['Kind'] === 'Not ours') { notOurs++; if (c['Matched CM#']) updateRow_('CCVs', ct, i, { 'Matched CM#': '' }); return; }
    if (c['Kind'] === 'Old system') { oldSystem++; if (c['Matched CM#']) updateRow_('CCVs', ct, i, { 'Matched CM#': '' }); return; }
    var cm = c['Matched CM#'];
    if (!cm || byCm[cm] == null) {
      cm = '';
      if (c['Match Note'] !== 'unlinked') {
        var cands = safeJson_(c['Match Note'], null) || (c['Return Auth'] ? extractCm_(c['Return Auth'] + ' ' + c['Comments']) : []);
        for (var k = 0; k < cands.length; k++) if (byCm[cands[k]] != null) { cm = cands[k]; break; }
      }
      if (cm !== c['Matched CM#']) updateRow_('CCVs', ct, i, { 'Matched CM#': cm });
    }
    if (!cm && goLive && c['Kind Source'] !== 'manual' && c['Match Note'] !== 'unlinked') {
      // Leftovers from the old system: dated before go-live, or naming a CM# we don't have, shortly after go-live
      var d = String(c['CCV Date'] || ''), named = (safeJson_(c['Match Note'], null) || extractCm_(c['Return Auth'] + ' ' + c['Comments'])).length > 0;
      var old = d && d < goLive;
      if (!old && named && d && d <= oldWindowEnd) {
        facMap = facMap || readFacilityMap_();
        var sg = scoreMemosForCCV_(c, mt.rows, cfg, facMap, claimed);
        old = !(sg.length && sg[0].score >= 75);
      }
      if (old) { updateRow_('CCVs', ct, i, { 'Kind': 'Old system', 'Kind Source': 'auto' }); oldSystem++; return; }
    }
    if (cm) (perMemo[cm] = perMemo[cm] || []).push(c); else unmatched++;
  });
  var learn = [];
  mt.rows.forEach(function (m) {
    (perMemo[m['CM#']] || []).forEach(function (c) {
      if (c['AAFES Facility #'] && (m['Facility #'] || m['Store'])) learn.push({ aafes: String(c['AAFES Facility #']), aafesName: c['Facility Name'], facility: m['Facility #'], store: m['Store'],
        source: 'auto' });
    });
  });
  learnFacilities_(learn);
  var matched = 0, reversals = 0, awaiting = 0;
  mt.rows.forEach(function (m, i) {
    var list = perMemo[m['CM#']];
    var manual = m['Match Status'] === 'Resolved' || m['Match Status'] === 'Expired';
    if (!list) {
      if (m['CCV #s'] && !manual) updateRow_('Memos', mt, i, { 'CCV #s': '', 'CCV Date': '', 'CCV Amount': '', 'Match Status': '', 'Adjusted Amount': '' });
      return;
    }
    list.sort(function (a, b) { return String(a['CCV Date']).localeCompare(String(b['CCV Date'])); });
    var net = round2_(list.reduce(function (t, c) { return t + Number(c['Amount'] || 0); }, 0));
    var diff = round2_(net - Number(m['Amount']));
    var status, adj = '', notes = [];
    var hasReversal = list.some(function (c) { return c['Kind'] === 'Reversal' || Number(c['Amount']) < 0; });
    if (hasReversal && Math.abs(net) < tol && Math.abs(Number(m['Amount'])) >= tol) {
      status = 'Reversed — awaiting new CCV'; awaiting++;
      notes.push('Store reversed the CCV; waiting for a new CCV for $' + fmt_(m['Amount']));
    } else if (Math.abs(diff) < tol) { status = diff === 0 ? 'Matched' : 'Matched (adjusted)'; if (diff !== 0) adj = net; matched++; }
    else { status = 'Reversal needed'; reversals++; notes.push('CCV total $' + fmt_(net) + ' vs memo $' + fmt_(m['Amount']) + ' (off by $' + fmt_(diff) + ')'); }
    if (manual && status === 'Reversal needed') status = m['Match Status'];
    var last = list[list.length - 1];
    if (m['Issue Date'] && last['CCV Date'] && daysBetween_(new Date(m['Issue Date'] + 'T12:00:00'), new Date(last['CCV Date'] + 'T12:00:00')) > grace) notes.push('CCV came in after ' + grace + ' days');
    var vend = String(last['Vendor #'] || '').replace(/\D/g, '').replace(/^0+/, '');
    var want = String(cfg['VENDOR_' + m['Brand']] || '').replace(/\D/g, '').replace(/^0+/, '');
    if (vend && want && vend !== want) notes.push('CCV vendor # ' + last['Vendor #'] + ' does not match ' + m['Brand']);
    var upd = { 'CCV #s': list.map(function (c) { return c['CCV #']; }).join(', '), 'CCV Date': last['CCV Date'], 'CCV Amount': net,
      'Match Status': status, 'Adjusted Amount': adj };
    if (!manual) upd['Match Note'] = notes.join('; ');
    updateRow_('Memos', mt, i, upd);
  });
  return { matched: matched, unmatched: unmatched, reversals: reversals, awaiting: awaiting, notOurs: notOurs, oldSystem: oldSystem };
}

function extractCm_(s) {
  var out = [], re = /\b(PR|MD)\s*[-#]?\s*(\d[\d\s]{4,11}\d)\b/gi, m;
  while ((m = re.exec(s))) out.push((m[1] + m[2].replace(/\s/g, '')).toUpperCase());
  return out;
}

// ======================================================================
// Sheet "ORM"
// ======================================================================
function ss_() { var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID'); return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet(); }
function sheet_(name) { var s = ss_().getSheetByName(name); if (!s) throw new Error('Missing tab "' + name + '" — run GFSI > Run setup.'); return s; }

function readTable_(name) {
  var sh = sheet_(name), vals = sh.getDataRange().getValues();
  var hdr = vals.shift() || [];
  var rows = vals.filter(function (r) { return r.join('') !== ''; }).map(function (r) {
    var o = {}; hdr.forEach(function (h, i) { var v = r[i]; o[h] = v instanceof Date ? Utilities.formatDate(v, 'America/New_York', 'yyyy-MM-dd') : v; }); return o;
  });
  return { sheet: sh, hdr: hdr, rows: rows };
}
function toRow_(hdr, o) { return hdr.map(function (h) { return o[h] == null ? '' : o[h]; }); }
function appendRows_(name, objs) {
  if (!objs.length) return;
  var sh = sheet_(name), hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  sh.getRange(sh.getLastRow() + 1, 1, objs.length, hdr.length).setValues(objs.map(function (o) { return toRow_(hdr, o); }));
}
function updateRow_(name, table, idx, patch) {
  Object.keys(patch).forEach(function (k) { table.rows[idx][k] = patch[k]; });
  table.sheet.getRange(idx + 2, 1, 1, table.hdr.length).setValues([toRow_(table.hdr, table.rows[idx])]);
}
function rewriteTable_(name, objs) {
  var sh = sheet_(name), hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, hdr.length).clearContent();
  if (objs.length) sh.getRange(2, 1, objs.length, hdr.length).setValues(objs.map(function (o) { return toRow_(hdr, o); }));
}

function getSettings_() {
  var o = {};
  try { sheet_('Settings').getDataRange().getValues().slice(1).forEach(function (r) { if (r[0]) o[r[0]] = r[1]; }); } catch (e) {}
  return o;
}
function setSetting_(k, v) {
  var sh = sheet_('Settings'), vals = sh.getDataRange().getValues();
  for (var i = 1; i < vals.length; i++) if (vals[i][0] === k) { sh.getRange(i + 1, 2).setValue(v); return; }
  sh.appendRow([k, v, '']);
}
function log_(what, detail) { try { sheet_('Log').appendRow([new Date(), what, String(detail).slice(0, 4000)]); } catch (e) {} }

// ======================================================================
// Utils
// ======================================================================
function sign_(s) {
  var secret = PropertiesService.getScriptProperties().getProperty('SECRET');
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(String(s), secret)).replace(/=+$/, '').slice(0, 32);
}
function verify_(s, t) { return !!s && !!t && sign_(s) === t; }
function clean_(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
function norm_(s) { return clean_(s).toUpperCase().replace(/[^A-Z0-9]+/g, ''); }
function round2_(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function fmt_(n) { return Number(n || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function esc_(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function safeJson_(s, d) { try { return s ? JSON.parse(s) : d; } catch (e) { return d; } }
function daysBetween_(a, b) { return Math.round((dayOf_(b) - dayOf_(a)) / 86400000); }
function dayOf_(d) { var s = Utilities.formatDate(d, 'America/New_York', 'yyyy-MM-dd').split('-'); return Date.UTC(+s[0], +s[1] - 1, +s[2]); }
