// ==========================================================
// NEXCOM ORDERING ENGINE
// Shared by souvenirs.html and navy-pride.html.
// Each shell page sets window.NEXCOM_CONFIG before loading this
// file — that's the only thing that differs between the two.
//
// Expected NEXCOM_CONFIG shape:
// {
//   customerLabel: 'Souvenirs',        // display name
//   prefix: 'SVN',                     // SKU prefix, also used as cart/PO tag
//   orderType: 'souvenirs',            // matches a future Post.gs processXOrder()
//   poTypeCode: 'V',                   // single char for generatePONumber(), must
//                                      // not collide with existing M/W/S/A codes
//   productsCsvUrl: '',                // published Google Sheet CSV — see README.
//                                      // Leave blank to run on embedded DEMO data.
//   colorsJsonUrl: 'garment-colors.json',
//   artAccount: 'Souvenir',            // art list comes live from the NEXCOM script:
//                                      // this rep's approved art requests for this
//                                      // account + the whole Art Library. (artCsvUrl
//                                      // is only used when artAccount isn't set.)
//   artCsvUrl: 'art-index.csv',        // old demo list, see art-index-template.csv
//   orderSubmissionUrl: '',            // same Apps Script POST endpoint as apparel.html
//   logo: 'nex-logo.jpg'
// }
// ==========================================================

// Role shown next to the person's name in the top bar. Blank role on the login sheet = a sales rep.
function portalRoleLabel(role) {
    var r = String(role || '').trim(), k = r.toLowerCase();
    if (!k || k === 'user') return 'Sales Rep';
    return { 'admin': 'Admin', 'art admin': 'Art Admin', 'art': 'Art', 'licensing': 'Licensing' }[k] || r;
}
function portalRoleTag(role, onDark) {
    var t = portalRoleLabel(role).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    return '<span class="portal-role-tag" style="display:inline-block;margin-left:7px;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:700;letter-spacing:.2px;vertical-align:1px;' +
        (onDark ? 'background:rgba(255,255,255,.25);color:#fff;' : 'background:#f1eaf7;color:#764ba2;') + '">' + t + '</span>';
}

var CFG = window.NEXCOM_CONFIG || {};
var colorData = {};
var artIndex = [];
var gridGroups = {};      // garmentType -> { label, tiers: { 'range-loc': record } }
var hardgoods = [];       // flat list
var categories = [];      // ordered list of hardgood categories present
var cart = [];

var SIZE_ORDER = ['S', 'M', 'L', 'XL', '2XL'];

// ---------------------------------------------------------
// Auth guard — same pattern as the hub pages. Gates on the
// NEXCOM program, not on Souvenirs/Navy Pride individually;
// both sub-catalogs share one program-level permission today.
// ---------------------------------------------------------
function requireAuth() {
    var authData = sessionStorage.getItem('salesPortalAuth');
    if (!authData) { window.location.href = 'login.html'; return null; }
    try {
        var auth = JSON.parse(authData);
        var isAdmin = auth.role === 'Admin';
        var programs = auth.programs || [];
        if (!isAdmin && programs.indexOf('NEXCOM') === -1) {
            window.location.href = 'index.html';
            return null;
        }
        return auth;
    } catch (e) {
        sessionStorage.removeItem('salesPortalAuth');
        window.location.href = 'login.html';
        return null;
    }
}

function renderTopBar(auth) {
    var bar = '<div style="position:fixed;top:20px;right:20px;background:white;padding:10px 20px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.2);display:flex;gap:10px;align-items:center;z-index:1000;">' +
        '<span style="color:#666;font-size:14px;">👤 ' + auth.name + portalRoleTag(auth.role) + '</span>' +
        '<a href="nexcom-hub.html" style="background:#667eea;color:white;padding:6px 12px;border-radius:4px;text-decoration:none;font-size:14px;font-weight:600;">⇄ NEXCOM Hub</a>' +
        '<a href="nexcom-orders.html" style="background:#764ba2;color:white;padding:6px 12px;border-radius:4px;text-decoration:none;font-size:14px;font-weight:600;">📋 My Orders</a>' +
        '<button onclick="logoutNexcom()" style="background:#dc3545;color:white;border:none;padding:6px 12px;border-radius:4px;cursor:pointer;font-weight:600;">Logout</button>' +
        '</div>';
    $('body').append(bar);
}
function logoutNexcom() {
    if (confirm('Are you sure you want to log out?')) {
        sessionStorage.removeItem('salesPortalAuth');
        window.location.href = 'login.html';
    }
}

// ---------------------------------------------------------
// CSV parsing (quoted-field aware — descriptions contain
// inch marks as escaped quotes, e.g. "SVN 8"" OREO...")
// ---------------------------------------------------------
function parseCSV(text) {
    var rows = [];
    var row = [];
    var field = '';
    var inQuotes = false;
    for (var i = 0; i < text.length; i++) {
        var c = text[i], next = text[i + 1];
        if (inQuotes) {
            if (c === '"' && next === '"') { field += '"'; i++; }
            else if (c === '"') { inQuotes = false; }
            else { field += c; }
        } else {
            if (c === '"') { inQuotes = true; }
            else if (c === ',') { row.push(field); field = ''; }
            else if (c === '\n' || c === '\r') {
                if (c === '\r' && next === '\n') i++;
                row.push(field); field = '';
                if (row.length > 1 || row[0] !== '') rows.push(row);
                row = [];
            } else { field += c; }
        }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
}

// ---------------------------------------------------------
// Load products, colors, and art index. All three fall back
// to small embedded demo data when a URL isn't configured yet,
// so this same file also serves as a working preview.
// ---------------------------------------------------------
function loadEverything() {
    // Defaults set eagerly, up front — real data (if it loads) overwrites
    // these; any failure mode (404, CSP block, timeout, malformed JSON)
    // just leaves the safe default in place instead of an empty {}/[].
    colorData = DEMO_COLOR_DATA;
    artIndex = DEMO_ART_INDEX;

    // Products render on their own timeline — the tab bar and every card
    // depend only on this, not on colors or art, so there's no reason to
    // make them wait on each other (and doing so was the previous bug).
    var productsTask = CFG.productsCsvUrl
        ? $.get(CFG.productsCsvUrl).then(function (text) { buildProducts(parseCSV(text)); })
        : $.Deferred(function (d) { buildProducts(DEMO_PRODUCT_ROWS); d.resolve(); }).promise();
    productsTask.always(function () { renderCatalog(); });

    // Colors and art load in parallel, independently. Note: .then(success, failure)
    // here, not .done().fail() — jQuery's .fail() runs as a side effect but does NOT
    // change the underlying request's rejected state, so a fast 404 on this fetch was
    // previously short-circuiting $.when() before the (slower) products fetch finished.
    // .then(success, failure) genuinely recovers to a resolved state when the failure
    // handler doesn't rethrow, which is what "fall back to demo data" actually needs.
    var sideTasks = [];
    if (CFG.colorsJsonUrl) {
        sideTasks.push($.getJSON(CFG.colorsJsonUrl).then(
            function (json) { colorData = json; },
            function () { console.warn('garment-colors.json failed to load — using embedded demo colors instead.'); }
        ));
    }
    if (CFG.artAccount && CFG.orderSubmissionUrl) {
        artIndex = [];
        sideTasks.push(loadPortalArt());
    } else if (CFG.artCsvUrl) {
        sideTasks.push($.get(CFG.artCsvUrl).then(
            function (text) { artIndex = buildArtIndex(parseCSV(text)); },
            function () { console.warn('art-index.csv failed to load — using embedded demo art list instead.'); }
        ));
    }
    if (sideTasks.length) {
        $.when.apply($, sideTasks).always(function () {
            // Colors/art may land after the catalog's first paint (e.g. a big
            // product list is still the slowest fetch) — refresh whichever tab
            // is currently open so real colors/art show without a manual click.
            var active = $('.cat-tab.active').attr('data-cat') || 'APPAREL';
            if ($('.cat-tab').length) selectCategory(active);
        });
    }
}

function buildProducts(rows) {
    gridGroups = {};
    hardgoods = [];
    var seenCategories = {};
    categories = [];

    for (var i = 1; i < rows.length; i++) { // skip header
        var c = rows[i];
        if (!c || !c[0]) continue;
        var rec = {
            baseSKU: c[0], description: c[1],
            images: [c[2], c[3], c[4]].filter(Boolean),
            prices: { S: c[5], M: c[6], L: c[7], XL: c[8], '2XL': c[9] },
            keywords: c[10], isCustom: c[11] === 'YES',
            category: c[12], productType: c[13],
            garmentType: c[14], colorRange: c[15], locCount: c[16],
            colorAttribute: c[17], requiresArt: c[18] === 'YES',
            skus: { S: c[19], M: c[20], L: c[21], XL: c[22], '2XL': c[23] }
        };

        if (rec.productType === 'GRID_TEE') {
            var g = gridGroups[rec.garmentType] || (gridGroups[rec.garmentType] = { label: garmentLabel(rec.garmentType), tiers: {} });
            g.tiers[rec.colorRange + '-' + rec.locCount] = rec;
        } else {
            hardgoods.push(rec);
            if (!seenCategories[rec.category]) { seenCategories[rec.category] = true; categories.push(rec.category); }
        }
    }
}

function garmentLabel(key) {
    var labels = { TEE: 'Core Cotton Tee', LS: 'Long Sleeve Tee', MW: 'Moisture Wick Tee', FLC: 'Fleece Crewneck', HDY: 'Fleece Hoodie', MTNK: "Men's Tank", LTNK: "Ladies Tank" };
    return labels[key] || key;
}

// ---------------------------------------------------------
// Art from the portal: approved art requests first, then the Art Library.
// ---------------------------------------------------------
var artLoadState = 'idle';   // idle | loading | ready | failed
function loadPortalArt() {
    var auth = {};
    try { auth = JSON.parse(sessionStorage.getItem('salesPortalAuth')) || {}; } catch (e) {}
    artLoadState = 'loading';
    var d = $.Deferred();
    fetch(CFG.orderSubmissionUrl, { method: 'POST', body: JSON.stringify({ action: 'artOrderList', account: CFG.artAccount, email: auth.email, token: auth.token || '' }) })
        .then(function (r) { return r.json(); })
        .then(function (r) {
            if (r && r.sessionExpired) { sessionStorage.removeItem('salesPortalAuth'); window.location.href = 'login.html'; return; }
            if (!r || !r.success) throw new Error((r && r.message) || 'failed');
            var mine = r.scope !== 'all';
            artIndex = (r.requests || []).map(function (a) {
                return { id: a.art, label: a.label, source: 'request', requestId: a.requestId, sketch: a.sketch, status: a.status,
                         rep: a.rep || '', thumbId: a.thumbId || '',
                         keywords: (a.label + ' ' + a.requestId + ' ' + (a.rep || '')).toLowerCase(),
                         tag: (mine ? 'Your request ' : (a.rep ? a.rep + ' · ' : 'Request ')) + a.requestId + (a.status === 'Ordered' ? ' · reorder' : '') };
            }).concat((r.library || []).map(function (a) {
                return { id: a.art, label: a.label || '', source: 'library', thumbId: a.thumbId || '', requestId: '',
                         keywords: ((a.label || '') + ' ' + (a.folder || '')).toLowerCase(), tag: 'Art Library' + (a.folder ? ' · ' + a.folder : '') };
            }));
            artLoadState = 'ready';
            d.resolve();
        })
        .catch(function (e) {
            console.warn('Could not load the art list: ' + e.message);
            artLoadState = 'failed';
            d.resolve();
        });
    return d.promise();
}

// Small pictures, fetched in batches as they're needed (same as Browse art on the request form).
var thumbCache = {}, thumbWanted = [], thumbTimer = null, thumbPending = {};
function thumbFor(id) {
    if (!id) return '';
    if (thumbCache[id] !== undefined) return thumbCache[id];
    if (!thumbPending[id]) { thumbPending[id] = true; thumbWanted.push(id); clearTimeout(thumbTimer); thumbTimer = setTimeout(fetchThumbs, 80); }
    return '';
}
function fetchThumbs() {
    var auth = {};
    try { auth = JSON.parse(sessionStorage.getItem('salesPortalAuth')) || {}; } catch (e) {}
    while (thumbWanted.length) {
        (function (ids) {
            fetch(CFG.orderSubmissionUrl, { method: 'POST', body: JSON.stringify({ action: 'artLibraryThumbs', ids: ids, email: auth.email, token: auth.token || '' }) })
                .then(function (r) { return r.json(); })
                .then(function (r) {
                    var got = (r && r.thumbs) || {};
                    ids.forEach(function (id) { if (id in got) thumbCache[id] = got[id] || ''; delete thumbPending[id]; });
                    paintThumbs();
                })
                .catch(function () { ids.forEach(function (id) { delete thumbPending[id]; }); });
        })(thumbWanted.splice(0, 20));
    }
}
function thumbStyle(id, fallbackBg) {
    var t = thumbFor(id);
    return t ? 'background:#fff url(\'' + t + '\') center/contain no-repeat;' : 'background:' + (fallbackBg || '#888') + ';';
}
function paintThumbs() {
    $('[data-thumb]').each(function () {
        var t = thumbCache[$(this).attr('data-thumb')];
        if (t) $(this).css({ background: '#fff url(\'' + t + '\') center/contain no-repeat' }).text('');
    });
}

function buildArtIndex(rows) {
    var out = [];
    for (var i = 1; i < rows.length; i++) {
        var c = rows[i];
        if (!c || !c[0]) continue;
        out.push({ id: c[0], label: c[1] || '', thumbUrl: c[2] || '', keywords: (c[3] || '').toLowerCase() });
    }
    return out;
}

// ---------------------------------------------------------
// Catalog rendering
// ---------------------------------------------------------
function renderCatalog() {
    var tabs = ['APPAREL'].concat(categories);
    var tabHtml = tabs.map(function (t, i) {
        return '<button class="cat-tab' + (i === 0 ? ' active' : '') + '" data-cat="' + t + '" onclick="selectCategory(\'' + t + '\')">' + categoryLabel(t) + '</button>';
    }).join('');
    $('#catTabs').html(tabHtml);
    selectCategory('APPAREL');
    buildRinIndex();
    ensureRinFinder();
}

function categoryLabel(cat) {
    var labels = { APPAREL: 'Apparel', CAPS: 'Caps', PLUSH: 'Plush', LANYARDS: 'Lanyards', 'ID HOLDERS': 'ID Holders', DECALS: 'Decals', MAGNETS: 'Magnets', STICKERS: 'Stickers', 'WINDOW CLINGS': 'Window Clings', 'SACK / TOTE': 'Sack / Tote', 'KEY CHAINS': 'Key Chains', 'PLAYING CARDS': 'Playing Cards', CUBE: 'Cube', ORNAMENTS: 'Ornaments', GLASSWARE: 'Glassware' };
    return labels[cat] || cat;
}

function selectCategory(cat) {
    $('.cat-tab').removeClass('active');
    $('.cat-tab[data-cat="' + cat + '"]').addClass('active');
    var html = '';
    if (cat === 'APPAREL') {
        Object.keys(gridGroups).forEach(function (garmentType) {
            html += renderGridCard(garmentType, gridGroups[garmentType]);
        });
    } else {
        hardgoods.filter(function (h) { return h.category === cat; }).forEach(function (h, idx) {
            html += renderHardgoodCard(h, cat + '-' + idx);
        });
    }
    $('#catalog').html(html || '<p style="text-align:center;color:#888;">No products in this category yet.</p>');
    // Wire up interactive bits after DOM insert
    Object.keys(gridGroups).forEach(function (g) { if (cat === 'APPAREL') initGridCard(g); });
    if (cat !== 'APPAREL') {
        hardgoods.filter(function (h) { return h.category === cat; }).forEach(function (h, idx) { initHardgoodCard(h, cat + '-' + idx); });
    }
}

// ---- Grid tee card (tier pills + swatches + art combo + size grid) ----
function renderGridCard(garmentType, group) {
    var tierKeys = Object.keys(group.tiers);
    var pills = tierKeys.map(function (k, i) {
        var t = group.tiers[k];
        return '<div class="tier-btn' + (i === 0 ? ' active' : '') + '" data-key="' + k + '" onclick="selectTier(\'' + garmentType + '\',\'' + k + '\')">' +
            t.colorRange + ' Color, ' + t.locCount + ' Loc<span class="tier-price" id="tp-' + garmentType + '-' + k + '">' + priceLabel(t) + '</span></div>';
    }).join('');

    var sizeInputs = SIZE_ORDER.map(function (sz) {
        return '<div class="size-item"><div class="size-label">' + sz + '</div><input type="number" min="0" value="0" class="size-qty-input" id="qty-' + garmentType + '-' + sz + '">' +
            '<div class="size-rin" id="rin-' + garmentType + '-' + sz + '"></div></div>';
    }).join('');

    return '<div class="sku-card" data-garment="' + garmentType + '">' +
        '<div class="product-name">' + group.label + '</div>' +
        '<div class="product-desc">' + CFG.prefix + ' Custom Print</div>' +
        '<div class="rin-line" id="rinLine-' + garmentType + '"></div>' +
        '<div class="section-label">Print Complexity / Locations<span class="selected-value" id="tierLabel-' + garmentType + '"></span></div>' +
        '<div class="tier-row" id="tierRow-' + garmentType + '">' + pills + '</div>' +
        '<div class="section-label">Garment Color<span class="selected-value" id="colorLabel-' + garmentType + '">Select a color</span></div>' +
        '<div class="swatch-grid" id="swatchGrid-' + garmentType + '"></div>' +
        '<div class="section-label">Artwork<span class="selected-value" id="artLabel-' + garmentType + '">Select a design</span></div>' +
        '<div class="art-picker-layout">' +
        '  <div class="art-combo"><input type="text" class="art-input" id="artInput-' + garmentType + '" placeholder="Type a design name or art #…" autocomplete="off"><span class="art-combo-icon">🔍</span><div class="art-dropdown" id="artDropdown-' + garmentType + '"></div><div class="art-error" id="artError-' + garmentType + '">That doesn\'t match an approved design.</div></div>' +
        '  <div class="art-preview" id="artPreview-' + garmentType + '"><div class="art-preview-thumb" id="artPreviewThumb-' + garmentType + '">🖼️</div><div style="min-width:0;"><div class="art-preview-empty" id="artPreviewEmpty-' + garmentType + '">No design previewed yet</div><div id="artPreviewText-' + garmentType + '" style="display:none;"><div class="art-preview-id" id="artPreviewId-' + garmentType + '"></div><div class="art-preview-desc" id="artPreviewDesc-' + garmentType + '"></div><div class="art-preview-status" id="artPreviewStatus-' + garmentType + '"></div></div></div></div>' +
        '</div>' +
        '<div class="section-label" style="margin-top:14px;">Quantities</div>' +
        '<div class="size-grid">' + sizeInputs + '</div>' +
        '<button class="add-btn" onclick="addGridToCart(\'' + garmentType + '\')">Add to Cart</button>' +
        '</div>';
}

function priceLabel(tierRec) {
    var p = costFor(tierRec.baseSKU, 'S', tierRec.skus.S, tierRec.prices.S);
    return p ? ('$' + p.toFixed(2) + ' ea') : 'TBD';
}

var gridState = {}; // garmentType -> { tierKey, color, art }

function initGridCard(garmentType) {
    var group = gridGroups[garmentType];
    var tierKeys = Object.keys(group.tiers);
    gridState[garmentType] = { tierKey: tierKeys[0], color: null, art: null };
    renderSwatchesFor(garmentType);
    initArtComboFor(garmentType);
    updateTierLabel(garmentType);
}

function selectTier(garmentType, key) {
    gridState[garmentType].tierKey = key;
    $('#tierRow-' + garmentType + ' .tier-btn').removeClass('active');
    $('#tierRow-' + garmentType + ' .tier-btn[data-key="' + key + '"]').addClass('active');
    updateTierLabel(garmentType);
}
function updateTierLabel(garmentType) {
    var t = gridGroups[garmentType].tiers[gridState[garmentType].tierKey];
    $('#tierLabel-' + garmentType).text(t.colorRange + ' Color, ' + t.locCount + ' Loc');
    updateGridRins(garmentType);
}

function renderSwatchesFor(garmentType) {
    var list = (colorData[garmentType] && colorData[garmentType].colors) || [];
    var html = list.map(function (c) {
        return '<div class="swatch" data-name="' + c.name + '" onclick="selectColor(\'' + garmentType + '\',\'' + c.name.replace(/'/g, "\\'") + '\')">' +
            '<div class="swatch-chip" style="background:' + c.hex + '"></div><div class="swatch-name">' + c.name + '</div></div>';
    }).join('');
    $('#swatchGrid-' + garmentType).html(html || '<p style="font-size:12px;color:#999;">No color list loaded for this garment yet.</p>');
}
function selectColor(garmentType, name) {
    gridState[garmentType].color = name;
    $('#swatchGrid-' + garmentType + ' .swatch').removeClass('selected');
    $('#swatchGrid-' + garmentType + ' .swatch[data-name="' + name + '"]').addClass('selected');
    $('#colorLabel-' + garmentType).text(name);
}

// ---- Reusable art combobox (keyed per garmentType/hardgood id) ----
var artComboState = {};
function initArtComboFor(key) {
    artComboState[key] = { filtered: [], highlight: -1, confirmed: null };
    var input = $('#artInput-' + key);
    input.on('input', function () {
        artComboState[key].confirmed = null;
        if (gridState[key]) gridState[key].art = null;
        if (hardgoodState[key]) hardgoodState[key].art = null;
        input.removeClass('confirmed invalid');
        $('#artError-' + key).hide();
        var q = input.val().trim().toLowerCase();
        if (!q) { $('#artDropdown-' + key).hide(); showArtPreview(key, null, false); return; }
        var words = q.split(/\s+/);
        var matches = artIndex.filter(function (a) {
            var hay = a.id.toLowerCase() + ' ' + a.label.toLowerCase() + ' ' + a.keywords;
            return words.every(function (w) { return hay.indexOf(w) !== -1; });
        }).slice(0, 60);
        artComboState[key].filtered = matches;
        artComboState[key].highlight = matches.length ? 0 : -1;
        renderArtDropdown(key);
        showArtPreview(key, matches[0] || null, false);
    });
    input.on('keydown', function (e) {
        var st = artComboState[key];
        if ($('#artDropdown-' + key).css('display') !== 'block') return;
        if (e.key === 'ArrowDown') { e.preventDefault(); st.highlight = Math.min(st.highlight + 1, st.filtered.length - 1); renderArtDropdown(key); showArtPreview(key, st.filtered[st.highlight], false); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); st.highlight = Math.max(st.highlight - 1, 0); renderArtDropdown(key); showArtPreview(key, st.filtered[st.highlight], false); }
        else if (e.key === 'Enter') { e.preventDefault(); if (st.filtered[st.highlight]) selectArt(key, st.filtered[st.highlight]); }
        else if (e.key === 'Escape') { $('#artDropdown-' + key).hide(); }
    });
    input.on('blur', function () {
        setTimeout(function () {
            if (document.activeElement === input[0]) return;   // clicked back in and typing again
            $('#artDropdown-' + key).hide();
            if (artComboState[key].confirmed) return;
            var typed = input.val().trim().toLowerCase();
            if (!typed) return;
            // Typing an art # exactly (or the full "ID — Label" text) counts as picking it
            var exact = artIndex.filter(function (a) {
                return a.id.toLowerCase() === typed || (a.id + ' — ' + a.label).toLowerCase() === typed;
            });
            if (exact.length) { selectArt(key, exact[0]); return; }   // approved requests are listed first
            input.addClass('invalid'); $('#artError-' + key).show();
        }, 150);
    });

    // Picking from the list: mousedown (not click) with preventDefault, so the
    // input never blurs mid-click, and hovering only moves the highlight
    // instead of redrawing the list out from under the mouse.
    var dd = $('#artDropdown-' + key);
    dd.on('mousedown', '.art-option', function (e) {
        e.preventDefault();
        var art = artComboState[key].filtered[parseInt($(this).attr('data-i'), 10)];
        if (art) selectArt(key, art);
    });
    dd.on('mouseenter', '.art-option', function () {
        var i = parseInt($(this).attr('data-i'), 10);
        artComboState[key].highlight = i;
        dd.find('.art-option').removeClass('highlighted');
        $(this).addClass('highlighted');
        showArtPreview(key, artComboState[key].filtered[i], false);
    });
}
function renderArtDropdown(key) {
    var st = artComboState[key];
    var dd = $('#artDropdown-' + key);
    if (!st.filtered.length) {
        var msg = artLoadState === 'loading' ? 'Loading the art list…' :
                  artLoadState === 'failed' ? 'Couldn’t load the art list. Refresh the page to try again.' : 'No approved designs match that.';
        dd.html('<div class="art-empty">' + msg + '</div>').show(); return;
    }
    var esc = function (t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
    var lastSource = null;
    var html = st.filtered.map(function (a, i) {
        var head = '';
        if (a.source && a.source !== lastSource) {
            head = '<div class="art-group">' + (a.source === 'request' ? 'Approved art requests' : 'Art Library: proven designs') + '</div>';
            lastSource = a.source;
        }
        var t = thumbFor(a.thumbId);
        return head + '<div class="art-option' + (i === st.highlight ? ' highlighted' : '') + '" data-i="' + i + '">' +
            '<div class="art-option-thumb" data-thumb="' + esc(a.thumbId || '') + '" style="' + thumbStyle(a.thumbId) + '">' + (t ? '' : '🖼️') + '</div>' +
            '<div class="art-option-text"><div class="art-id">' + esc(a.id) + '</div><div class="art-desc">' + esc(a.label) + '</div>' +
            (a.tag ? '<div class="art-tag' + (a.source === 'request' ? ' req' : '') + '">' + esc(a.tag) + '</div>' : '') + '</div></div>';
    }).join('');
    dd.html(html).show();
}
function artHover(key, i) { artComboState[key].highlight = i; renderArtDropdown(key); showArtPreview(key, artComboState[key].filtered[i], false); }
function artPick(key, i) { selectArt(key, artComboState[key].filtered[i]); }
function showArtPreview(key, art, locked) {
    var panel = $('#artPreview-' + key), thumb = $('#artPreviewThumb-' + key), empty = $('#artPreviewEmpty-' + key), text = $('#artPreviewText-' + key), status = $('#artPreviewStatus-' + key);
    if (!art) { panel.removeClass('locked zoomable').removeData('art').removeAttr('title'); thumb.css('background', '#ddd').text('🖼️'); empty.show(); text.hide(); status.text(''); return; }
    panel.data('art', art).addClass('zoomable').attr('title', 'Click to see this design larger');
    empty.hide(); text.show();
    var t = thumbFor(art.thumbId);
    thumb.attr('data-thumb', art.thumbId || '');
    if (t) thumb.css({ background: '#fff url(\'' + t + '\') center/contain no-repeat' }).text('');
    else thumb.css('background', '#607D8B').text('🖼️');
    $('#artPreviewId-' + key).text(art.id);
    $('#artPreviewDesc-' + key).text(art.label);
    panel.toggleClass('locked', locked);
    status.text(locked ? 'Selected' : 'Previewing');
}
// ---------------------------------------------------------
// Larger view of a design: click the preview box under the Artwork search.
// Shows the small picture right away, then swaps in a bigger one.
// ---------------------------------------------------------
var artZoomCache = {}, artZoomId = null;
function ensureArtZoom() {
    if ($('#artZoom').length) return;
    $('head').append('<style>' +
        '.art-preview.zoomable { cursor: zoom-in; position: relative; }' +
        '.art-preview.zoomable:hover { border-color: #764ba2; }' +
        '.art-preview.zoomable::after { content: "🔍"; position: absolute; right: 6px; bottom: 5px; font-size: 11px; opacity: .7; }' +
        '#artZoom { position: fixed; inset: 0; background: rgba(20,20,30,.72); z-index: 3000; display: none; align-items: center; justify-content: center; padding: 20px; }' +
        '#artZoom.open { display: flex; }' +
        '#artZoom .az-box { background: #fff; border-radius: 12px; width: 100%; max-width: 820px; max-height: 92vh; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 10px 40px rgba(0,0,0,.35); }' +
        '#artZoom .az-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid #eee; }' +
        '#artZoom .az-title { font-weight: 700; font-size: 15px; } #artZoom .az-sub { font-size: 12px; color: #666; }' +
        '#artZoom .az-close { border: none; background: none; font-size: 20px; cursor: pointer; color: #777; line-height: 1; }' +
        '#artZoom .az-img { flex: 1; min-height: 240px; background: #f4f4f4; display: flex; align-items: center; justify-content: center; }' +
        '#artZoom .az-img img { max-width: 100%; max-height: calc(92vh - 110px); object-fit: contain; display: block; }' +
        '#artZoom .az-img img.lowres { width: 320px; max-width: 80%; image-rendering: auto; filter: blur(.3px); opacity: .85; }' +
        '#artZoom .az-note { padding: 8px 16px; font-size: 12px; color: #777; border-top: 1px solid #eee; min-height: 32px; }' +
        '</style>');
    $('body').append('<div id="artZoom" role="dialog" aria-modal="true"><div class="az-box">' +
        '<div class="az-head"><div><div class="az-title" id="azTitle"></div><div class="az-sub" id="azSub"></div></div>' +
        '<button type="button" class="az-close" aria-label="Close">✕</button></div>' +
        '<div class="az-img" id="azImg"></div><div class="az-note" id="azNote"></div></div></div>');
    $('#artZoom').on('click', function (e) { if (e.target === this || $(e.target).closest('.az-close').length) closeArtZoom(); });
    $(document).on('keydown', function (e) { if (e.key === 'Escape') closeArtZoom(); });
}
function closeArtZoom() { $('#artZoom').removeClass('open'); artZoomId = null; }
function openArtZoom(art) {
    ensureArtZoom();
    var esc = function (t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
    $('#azTitle').text(art.id);
    $('#azSub').text([art.label, art.tag].filter(Boolean).join(' · '));
    var small = thumbFor(art.thumbId);
    $('#azImg').html(small ? '<img class="lowres" src="' + esc(small) + '" alt="">' : '<span style="font-size:48px;color:#bbb;">🖼️</span>');
    $('#artZoom').addClass('open');
    artZoomId = art.thumbId || '';
    if (!art.thumbId || !CFG.orderSubmissionUrl) { $('#azNote').text(small ? '' : 'No picture is available for this design.'); return; }
    var show = function (r) {
        if (artZoomId !== art.thumbId) return;   // closed, or switched to another design
        if (r && r.url) { $('#azImg').html('<img src="' + esc(r.url) + '" alt="' + esc(art.id) + '">'); $('#azNote').text(''); }
        else $('#azNote').text(small ? 'A larger picture isn’t available for this design, so this is the small one.' : 'No picture is available for this design.');
    };
    if (artZoomCache[art.thumbId]) return show(artZoomCache[art.thumbId]);
    $('#azNote').text('Loading a larger picture…');
    var auth = {};
    try { auth = JSON.parse(sessionStorage.getItem('salesPortalAuth')) || {}; } catch (e) {}
    fetch(CFG.orderSubmissionUrl, { method: 'POST', body: JSON.stringify({ action: 'artLibraryPreview', id: art.thumbId, email: auth.email, token: auth.token || '' }) })
        .then(function (r) { return r.json(); })
        .then(function (r) { if (r && r.success && r.url) artZoomCache[art.thumbId] = r; show(r); })
        .catch(function () { show(null); });
}
$(document).on('click', '.art-preview.zoomable', function () { var art = $(this).data('art'); if (art) openArtZoom(art); });

function selectArt(key, art) {
    artComboState[key].confirmed = art;
    if (gridState[key]) gridState[key].art = art;
    if (hardgoodState[key]) hardgoodState[key].art = art;
    var input = $('#artInput-' + key);
    input.val(art.id + ' — ' + art.label).addClass('confirmed').removeClass('invalid');
    $('#artError-' + key).hide();
    $('#artLabel-' + key).text(art.id + ' — ' + art.label);
    $('#artDropdown-' + key).hide();
    showArtPreview(key, art, true);
}

// ---------------------------------------------------------
// RINs on the cards, and "Find an item by RIN or SKU" under the rep details
// ---------------------------------------------------------
function rinEsc(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function parentRinFor(style) {
    var data = window.RIN_DATA || {}, d = data[style];
    return d && d.p ? String(d.p) : '';
}
/** One line under the product name: parent RIN, or the RIN for a one-size item. */
function rinLineHtml(style, sizes) {
    var parent = parentRinFor(style);
    var one = sizes.length === 1 ? rinFor(style, sizes[0].size, sizes[0].sku) : '';
    var sku = sizes.length === 1 ? sizes[0].sku : style;
    if (!parent && !one) return '<div class="rin-line"><span class="rin-none">RIN not assigned yet</span> · SKU <b>' + rinEsc(sku) + '</b></div>';
    return '<div class="rin-line">' + (one ? 'RIN <b>' + rinEsc(one) + '</b>' : 'Parent RIN <b>' + rinEsc(parent) + '</b>') +
        ' · SKU <b>' + rinEsc(sku) + '</b></div>';
}
/** Apparel: the RIN under each size box follows the selected print tier. */
function updateGridRins(garmentType) {
    var st = gridState[garmentType], tier = st && gridGroups[garmentType].tiers[st.tierKey];
    if (!tier) return;
    var any = false;
    SIZE_ORDER.forEach(function (sz) {
        var rin = tier.skus[sz] ? rinFor(tier.baseSKU, sz, tier.skus[sz]) : '';
        if (rin) any = true;
        $('#rin-' + garmentType + '-' + sz).text(rin).attr('title', rin ? 'RIN ' + rin + ' · SKU ' + tier.skus[sz] : '');
    });
    var parent = parentRinFor(tier.baseSKU);
    $('#rinLine-' + garmentType).html(parent || any
        ? 'Parent RIN <b>' + rinEsc(parent || '—') + '</b> · Style <b>' + rinEsc(tier.baseSKU) + '</b>' + (any ? ' <span class="rin-none">· size RINs below</span>' : '')
        : '<span class="rin-none">RIN not assigned yet</span> · Style <b>' + rinEsc(tier.baseSKU) + '</b>');
}

var rinIndex = [];
function buildRinIndex() {
    rinIndex = [];
    Object.keys(gridGroups).forEach(function (g) {
        var group = gridGroups[g];
        Object.keys(group.tiers).forEach(function (k) {
            var t = group.tiers[k];
            SIZE_ORDER.forEach(function (sz) {
                if (!t.skus[sz]) return;
                rinIndex.push({ kind: 'grid', cat: 'APPAREL', garmentType: g, tierKey: k, size: sz, sku: t.skus[sz],
                                rin: rinFor(t.baseSKU, sz, t.skus[sz]),
                                label: group.label + ', ' + t.colorRange + ' Color ' + t.locCount + ' Loc', sizeLabel: sz });
            });
        });
    });
    var byCat = {};
    hardgoods.forEach(function (h) {
        var idx = byCat[h.category] = (byCat[h.category] === undefined ? 0 : byCat[h.category] + 1);
        var sku = h.skus.OS || h.baseSKU;
        rinIndex.push({ kind: 'hg', cat: h.category, key: h.category + '-' + idx, size: 'OS', sku: sku,
                        rin: rinFor(h.baseSKU, 'OS', sku), label: h.description || h.baseSKU, sizeLabel: '' });
    });
}

function ensureRinFinder() {
    if (!$('#rinFind').length) {
        $('head').append('<style>' +
            '.rin-line { font-size: 12px; color: #555; margin: -8px 0 10px; } .rin-line b { font-family: Menlo, Consolas, monospace; font-weight: 600; color: #333; }' +
            '.rin-none { color: #999; font-style: italic; }' +
            '.size-rin { font-family: Menlo, Consolas, monospace; font-size: 9.5px; color: #777; margin-top: 3px; letter-spacing: -.3px; min-height: 12px; white-space: nowrap; overflow: hidden; text-overflow: clip; }' +
            '.rin-find { background: white; margin: -6px 30px 20px; padding: 14px 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.08); }' +
            '.rin-find label { display: block; font-size: 12px; font-weight: 700; color: #555; margin-bottom: 6px; }' +
            '.rf-wrap { position: relative; max-width: 560px; }' +
            '#rinFind { width: 100%; box-sizing: border-box; padding: 9px 12px; border: 2px solid #ddd; border-radius: 6px; font-size: 14px; }' +
            '#rinFind:focus { outline: none; border-color: #764ba2; }' +
            '.rf-list { position: absolute; top: calc(100% + 4px); left: 0; right: 0; background: white; border: 1px solid #ddd; border-radius: 6px; box-shadow: 0 4px 12px rgba(0,0,0,.15); z-index: 50; display: none; max-height: 320px; overflow-y: auto; }' +
            '.rf-opt { padding: 8px 10px; cursor: pointer; border-bottom: 1px solid #f2f2f2; font-size: 13px; }' +
            '.rf-opt:hover, .rf-opt.hl { background: #f1eaf7; }' +
            '.rf-opt .rf-rin { font-family: Menlo, Consolas, monospace; font-weight: 700; color: #222; }' +
            '.rf-opt .rf-sub { font-size: 11.5px; color: #777; }' +
            '.rf-empty { padding: 9px 10px; font-size: 12.5px; color: #888; font-style: italic; }' +
            '.rf-hint { font-size: 11.5px; color: #888; margin-top: 6px; }' +
            '.rin-flash { animation: rinFlash 1.6s ease-out; } @keyframes rinFlash { 0%,40% { box-shadow: 0 0 0 3px #764ba2; } 100% { box-shadow: 0 0 0 0 transparent; } }' +
            '@media (max-width: 480px) { .rin-find { margin-left: 14px; margin-right: 14px; } .size-rin { font-size: 8px; letter-spacing: -.5px; } }' +
            '</style>');
        $('.rep-info-bar').after('<div class="rin-find"><label for="rinFind">Find an item by RIN or SKU</label>' +
            '<div class="rf-wrap"><input type="text" id="rinFind" autocomplete="off" inputmode="search"><div class="rf-list" id="rinFindList"></div></div>' +
            '<div class="rf-hint" id="rinFindHint"></div></div>');
        var st = { list: [], hl: -1 };
        var $in = $('#rinFind'), $dd = $('#rinFindList');
        var show = function () {
            if (!st.list.length) { $dd.html('<div class="rf-empty">No item has that RIN or SKU.</div>').show(); return; }
            $dd.html(st.list.map(function (e, i) {
                return '<div class="rf-opt' + (i === st.hl ? ' hl' : '') + '" data-i="' + i + '"><span class="rf-rin">' + rinEsc(e.rin || e.sku) + '</span> ' +
                    rinEsc(e.label) + (e.sizeLabel ? ' · <b>' + rinEsc(e.sizeLabel) + '</b>' : '') +
                    '<div class="rf-sub">' + (e.rin ? 'SKU ' + rinEsc(e.sku) : 'No RIN yet') + ' · ' + rinEsc(categoryLabel(e.cat)) + '</div></div>';
            }).join('')).show();
        };
        $in.on('input', function () {
            var q = $.trim($in.val()).toUpperCase().replace(/^RIN\s*/, '');
            if (q.length < 2) { $dd.hide(); return; }
            var digits = /^\d+$/.test(q);
            st.list = rinIndex.filter(function (e) {
                return digits ? (e.rin && e.rin.indexOf(q) !== -1) || e.sku.toUpperCase().indexOf(q) !== -1
                              : e.sku.toUpperCase().indexOf(q) !== -1;
            }).sort(function (a, b) {   // exact matches first
                var ea = a.rin === q || a.sku.toUpperCase() === q, eb = b.rin === q || b.sku.toUpperCase() === q;
                return ea === eb ? 0 : ea ? -1 : 1;
            }).slice(0, 12);
            st.hl = st.list.length ? 0 : -1;
            show();
        });
        $in.on('keydown', function (e) {
            if ($dd.css('display') !== 'block') return;
            if (e.key === 'ArrowDown') { e.preventDefault(); st.hl = Math.min(st.hl + 1, st.list.length - 1); show(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); st.hl = Math.max(st.hl - 1, 0); show(); }
            else if (e.key === 'Enter') { e.preventDefault(); if (st.list[st.hl]) goToRinEntry(st.list[st.hl]); }
            else if (e.key === 'Escape') { $dd.hide(); }
        });
        $in.on('blur', function () { setTimeout(function () { $dd.hide(); }, 150); });
        $dd.on('mousedown', '.rf-opt', function (e) { e.preventDefault(); goToRinEntry(st.list[+$(this).attr('data-i')]); });
    }
    var hasRins = rinIndex.some(function (e) { return e.rin; });
    $('#rinFind').attr('placeholder', hasRins ? 'Type a RIN (e.g. 20421639) or a SKU' : 'Type a SKU (e.g. ' + ((rinIndex[0] || {}).sku || 'LNPTEE1-2-1-S') + ')');
    $('#rinFindHint').text(hasRins ? 'Picks the item, print and size for you. Then choose the color and art, and add it to the cart.'
                                   : 'RINs haven’t been assigned to these items yet, so search by SKU for now.');
}

/** Jump to the item: open its tab, pick the print tier, and put the cursor in its quantity box. */
function goToRinEntry(e) {
    if (!e) return;
    $('#rinFindList').hide();
    $('#rinFind').val((e.rin || e.sku) + ' — ' + e.label + (e.sizeLabel ? ', ' + e.sizeLabel : '')).blur();
    selectCategory(e.cat);
    var $card, $qty;
    if (e.kind === 'grid') {
        selectTier(e.garmentType, e.tierKey);
        $card = $('.sku-card[data-garment="' + e.garmentType + '"]');
        $qty = $('#qty-' + e.garmentType + '-' + e.size);
    } else {
        $card = $('.sku-card[data-hg="' + e.key + '"]');
        $qty = $('#qty-' + e.key);
    }
    if (!$card.length) return;
    $card[0].scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    $card.removeClass('rin-flash'); void $card[0].offsetWidth; $card.addClass('rin-flash');
    $qty.closest('.size-item').removeClass('rin-flash'); void $card[0].offsetWidth; $qty.closest('.size-item').addClass('rin-flash');
    setTimeout(function () { $qty.trigger('focus').trigger('select'); }, 450);
}

// Unit cost for an item and size: the order template's Unit Cost (rin-data.js,
// same as art-request orders), else the price column on the products sheet.
function costFor(style, size, sku, sheetPrice) {
    var c = rinEntry(style, size, sku);
    if (c && c[2] != null && c[2] !== '') return Number(c[2]) || 0;
    return parseFloat(sheetPrice) || 0;
}

// NEXCOM's RIN for an item and size, from rin-data.js (the order template).
// Blank when the item has no RIN yet (e.g. Local Navy Pride today).
function rinFor(style, size, sku) {
    var hit = rinEntry(style, size, sku);
    return hit ? String(hit[1] || '') : '';
}
/** The template row [size, RIN, unit cost, vendor SKU] for an item and size, or null. */
function rinEntry(style, size, sku) {
    var data = window.RIN_DATA || {}, d = data[style];
    if (!d) { var k = Object.keys(data).filter(function (x) { return x.toUpperCase() === String(style || '').toUpperCase(); })[0]; d = k && data[k]; }
    if (!d || !d.r) return null;
    var want = String(sku || '').toUpperCase(), sz = String(size || '').toUpperCase();
    if (sz === '2XL' || sz === 'XX') sz = 'XXL';
    if (sz === 'OS') sz = '';
    var hit = d.r.filter(function (x) { return want && String(x[3] || '').toUpperCase() === want; })[0] ||
              d.r.filter(function (x) { return String(x[0] || '').toUpperCase() === sz; })[0] ||
              (d.r.length === 1 ? d.r[0] : null);
    return hit || null;
}

function addGridToCart(garmentType) {
    var st = gridState[garmentType];
    var tier = gridGroups[garmentType].tiers[st.tierKey];
    if (!st.color) { alert('Please select a garment color.'); return; }
    if (tier.requiresArt !== false && !st.art) { alert('Please select artwork.'); return; }
    var addedAny = false;
    SIZE_ORDER.forEach(function (sz) {
        var qty = parseInt($('#qty-' + garmentType + '-' + sz).val()) || 0;
        if (qty > 0 && tier.skus[sz]) {
            cart.push({
                productName: garmentLabel(garmentType) + ' — ' + tier.colorRange + ' Color/' + tier.locCount + ' Loc',
                sku: tier.skus[sz], rin: rinFor(tier.baseSKU, sz, tier.skus[sz]), size: sz, quantity: qty,
                category: 'APPAREL', isCustom: true,
                style: tier.baseSKU, styleDesc: tier.description,
                color: st.color, artId: st.art ? st.art.id : '', artLabel: st.art ? st.art.label : '',
                artRequestId: st.art && st.art.requestId ? st.art.requestId : '',
                cost: costFor(tier.baseSKU, sz, tier.skus[sz], tier.prices[sz])
            });
            addedAny = true;
            $('#qty-' + garmentType + '-' + sz).val(0);
        }
    });
    if (!addedAny) { alert('Please enter at least one quantity.'); return; }
    updateCartBadge();
    flashAdded(garmentType);
}

// ---- Hardgood card ----
var hardgoodState = {};
function renderHardgoodCard(rec, key) {
    var hasColor = !!rec.colorAttribute;
    var colorBlock = hasColor
        ? '<div class="section-label">' + (colorData[rec.colorAttribute] ? colorData[rec.colorAttribute].attribute : 'Color') + '<span class="selected-value" id="colorLabel-' + key + '">Select a color</span></div><div class="swatch-grid" id="swatchGrid-' + key + '"></div>'
        : '';
    var artBlock = rec.requiresArt
        ? '<div class="section-label">Artwork<span class="selected-value" id="artLabel-' + key + '">Select a design</span></div>' +
          '<div class="art-picker-layout">' +
          '  <div class="art-combo"><input type="text" class="art-input" id="artInput-' + key + '" placeholder="Type a design name or art #…" autocomplete="off"><span class="art-combo-icon">🔍</span><div class="art-dropdown" id="artDropdown-' + key + '"></div><div class="art-error" id="artError-' + key + '">That doesn\'t match an approved design.</div></div>' +
          '  <div class="art-preview" id="artPreview-' + key + '"><div class="art-preview-thumb" id="artPreviewThumb-' + key + '">🖼️</div><div style="min-width:0;"><div class="art-preview-empty" id="artPreviewEmpty-' + key + '">No design previewed yet</div><div id="artPreviewText-' + key + '" style="display:none;"><div class="art-preview-id" id="artPreviewId-' + key + '"></div><div class="art-preview-desc" id="artPreviewDesc-' + key + '"></div><div class="art-preview-status" id="artPreviewStatus-' + key + '"></div></div></div></div>' +
          '</div>'
        : '';
    return '<div class="sku-card" data-hg="' + key + '">' +
        '<div class="product-name">' + rec.baseSKU + '</div>' +
        '<div class="product-desc">' + rec.description + '</div>' +
        rinLineHtml(rec.baseSKU, [{ size: 'OS', sku: rec.skus.OS || rec.baseSKU }]) +
        colorBlock + artBlock +
        '<div class="section-label" style="margin-top:14px;">Quantity</div>' +
        '<div class="size-grid" style="grid-template-columns:120px;"><div class="size-item"><div class="size-label">QTY</div><input type="number" min="0" value="0" class="size-qty-input" id="qty-' + key + '"></div></div>' +
        '<button class="add-btn" onclick="addHardgoodToCart(\'' + key + '\')">Add to Cart</button>' +
        '</div>';
}
function initHardgoodCard(rec, key) {
    hardgoodState[key] = { color: null, art: null, rec: rec };
    if (rec.colorAttribute) {
        var list = (colorData[rec.colorAttribute] && colorData[rec.colorAttribute].colors) || [];
        var html = list.map(function (c) {
            return '<div class="swatch" data-name="' + c.name + '" onclick="selectHardgoodColor(\'' + key + '\',\'' + c.name.replace(/'/g, "\\'") + '\')">' +
                '<div class="swatch-chip" style="background:' + c.hex + '"></div><div class="swatch-name">' + c.name + '</div></div>';
        }).join('');
        $('#swatchGrid-' + key).html(html);
    }
    if (rec.requiresArt) initArtComboFor(key);
}
function selectHardgoodColor(key, name) {
    hardgoodState[key].color = name;
    $('#swatchGrid-' + key + ' .swatch').removeClass('selected');
    $('#swatchGrid-' + key + ' .swatch[data-name="' + name + '"]').addClass('selected');
    $('#colorLabel-' + key).text(name);
}
function addHardgoodToCart(key) {
    var st = hardgoodState[key];
    var rec = st.rec;
    if (rec.colorAttribute && !st.color) { alert('Please select a color.'); return; }
    if (rec.requiresArt && !st.art) { alert('Please select artwork.'); return; }
    var qty = parseInt($('#qty-' + key).val()) || 0;
    if (qty === 0) { alert('Please enter a quantity.'); return; }
    cart.push({
        productName: rec.baseSKU, sku: rec.skus.OS || rec.baseSKU, rin: rinFor(rec.baseSKU, 'OS', rec.skus.OS || rec.baseSKU), size: 'OS', quantity: qty,
        category: rec.category, isCustom: rec.requiresArt,
        style: rec.baseSKU, styleDesc: rec.description,
        color: st.color || '', artId: st.art ? st.art.id : '', artLabel: st.art ? st.art.label : '',
        artRequestId: st.art && st.art.requestId ? st.art.requestId : '',
        cost: costFor(rec.baseSKU, 'OS', rec.skus.OS || rec.baseSKU, rec.prices.OS || rec.prices.S)
    });
    $('#qty-' + key).val(0);
    updateCartBadge();
    flashAdded(key);
}

function flashAdded(key) {
    var btn = $('.sku-card [onclick*="' + key + '"].add-btn, .sku-card [data-garment="' + key + '"] .add-btn');
    var text = btn.text();
    btn.text('✓ Added').css('background', '#2e7d32');
    setTimeout(function () { btn.text(text).css('background', ''); }, 1000);
}

// ---------------------------------------------------------
// Cart drawer
// ---------------------------------------------------------
function updateCartBadge() {
    var totalQty = cart.reduce(function (s, i) { return s + i.quantity; }, 0);
    $('#cartBadge').text(totalQty).toggle(totalQty > 0);
}
function openCart() { renderCartDrawer(); $('#cartDrawer').addClass('open'); $('#cartOverlay').addClass('open'); }
function closeCart() { $('#cartDrawer').removeClass('open'); $('#cartOverlay').removeClass('open'); }
function removeCartItem(i) { cart.splice(i, 1); renderCartDrawer(); updateCartBadge(); }

function renderCartDrawer() {
    if (!cart.length) { $('#cartItems').html('<p style="color:#888;text-align:center;">Your cart is empty.</p>'); $('#cartTotalQty').text(0); return; }
    var html = cart.map(function (item, i) {
        return '<div class="cart-line">' +
            '<div><b>' + item.productName + '</b><br>' +
            '<span style="font-size:11px;color:#666;">' + (item.rin ? 'RIN: ' + item.rin + ' · ' : '') + 'SKU: ' + item.sku + ' · Size: ' + item.size + (item.color ? ' · Color: ' + item.color : '') + (item.artId ? ' · Art: ' + item.artId : '') + '</span></div>' +
            '<div style="display:flex;align-items:center;gap:10px;"><span style="text-align:right;">×' + item.quantity +
            '<br><span style="font-size:11px;color:#666;">' + (item.cost ? '$' + (item.cost * item.quantity).toFixed(2) : 'no price') + '</span></span><button onclick="removeCartItem(' + i + ')" style="background:none;border:none;color:#c62828;cursor:pointer;font-size:16px;">✕</button></div>' +
            '</div>';
    }).join('');
    $('#cartItems').html(html);
    $('#cartTotalQty').text(cart.reduce(function (s, i) { return s + i.quantity; }, 0) + ' · $' +
        cart.reduce(function (s, i) { return s + (i.cost || 0) * i.quantity; }, 0).toFixed(2));
}

// ---------------------------------------------------------
// Submit — mirrors apparel.html's hidden-form POST pattern.
// Backend note: Post.gs needs a process<CFG.orderType>Order()
// function analogous to processApparelOrder(), using
// generatePONumber(..., CFG.poTypeCode) to keep POs separate
// from AAFES and from the other NEXCOM sub-catalog.
// ---------------------------------------------------------
function submitOrder() {
    var required = ['repName', 'repEmail', 'facilityId', 'locationName', 'beginShipDate', 'shipByDate'];
    for (var i = 0; i < required.length; i++) {
        if (!$('#' + required[i]).val()) { alert('Please fill out all required header fields before submitting.'); closeCart(); return; }
    }
    if (!cart.length) { alert('Your cart is empty!'); return; }

    var authData = JSON.parse(sessionStorage.getItem('salesPortalAuth'));
    var orderData = {
        orderType: CFG.orderType,
        poTypeCode: CFG.poTypeCode,
        repName: $('#repName').val(),
        repEmail: $('#repEmail').val(),
        repNumber: authData.repNumber || '',
        facilityId: $('#facilityId').val(),
        locationName: $('#locationName').val(),
        beginShipDate: $('#beginShipDate').val(),
        shipByDate: $('#shipByDate').val(),
        orderDate: new Date().toISOString(),
        items: cart
    };

    if (!CFG.orderSubmissionUrl) {
        console.warn('CFG.orderSubmissionUrl is not set — printing order payload instead of submitting.', orderData);
        alert('Demo mode: no orderSubmissionUrl configured yet. Order payload logged to console instead of submitted.');
        return;
    }

    var btn = $('.submit-order-btn').prop('disabled', true).text('Submitting...');
    var totalItems = cart.reduce(function (s, i) { return s + i.quantity; }, 0);
    orderData.action = 'nexcomOrder';
    orderData.email = authData.email;
    orderData.token = authData.token || '';

    // JSON through the relay to the NEXCOM script (NexcomOrders.gs).
    fetch(CFG.orderSubmissionUrl, { method: 'POST', body: JSON.stringify(orderData) })
        .then(function (r) { return r.json(); })
        .then(function (r) {
            btn.prop('disabled', false).text('Submit Order');
            if (r && r.sessionExpired) {
                alert('Your login has expired. Please log in again. Your cart was not submitted.');
                sessionStorage.removeItem('salesPortalAuth');
                window.location.href = 'login.html';
                return;
            }
            if (!r || !r.success) {
                alert('❌ The order was not submitted.\n\n' + ((r && r.message) || 'Unknown error.') + '\n\nYour cart is still here.');
                return;
            }
            alert('✅ Order submitted!\n\nPO Number: ' + r.poNumber + '\nStore: ' + (r.store || '') +
                  '\nTotal items: ' + totalItems + '\n\nA confirmation email is on its way to ' + orderData.repEmail + '.');
            cart = [];
            updateCartBadge();
            closeCart();
        })
        .catch(function () {
            btn.prop('disabled', false).text('Submit Order');
            alert('❌ Could not reach the server. Your cart is still here. Please try again.');
        });
}

// ---------------------------------------------------------
// Boot
// ---------------------------------------------------------
$(document).ready(function () {
    var auth = requireAuth();
    if (!auth) return;
    renderTopBar(auth);
    $('#repName').val(auth.name);
    $('#repEmail').val(auth.email);
    $('#pageTitle').text(CFG.customerLabel);
    document.title = CFG.customerLabel + ' - NEXCOM Ordering';
    if (CFG.logo) $('#programLogo').attr('src', CFG.logo);
    loadEverything();
});

// ===========================================================
// Embedded demo data — used only when productsCsvUrl /
// colorsJsonUrl / artCsvUrl are left blank in NEXCOM_CONFIG.
// Real CSV rows use the exact souvenirs-products.csv schema.
// ===========================================================
var DEMO_PRODUCT_ROWS = [
    ['baseSKU','description','image1','image2','image3','price_S_OS','price_M','price_L','price_XL','price_2XL','keywords','isCustom','category','productType','garmentType','colorRange','locCount','colorAttribute','requiresArt','sku_S_OS','sku_M','sku_L','sku_XL','sku_2XL'],
    ['SVNTEE1-2-1','SVN 1-2 Color 1 Loc Core Cotton Tee','','','','8.95','8.95','8.95','8.95','9.95','tee','YES','APPAREL','GRID_TEE','TEE','1-2','1','','YES','SVNTEE1-2-1-S','SVNTEE1-2-1-M','SVNTEE1-2-1-L','SVNTEE1-2-1-XL','SVNTEE1-2-1-XX'],
    ['SVNTEE1-2-2','SVN 1-2 Color 2 Loc Core Cotton Tee','','','','10.95','10.95','10.95','10.95','11.95','tee','YES','APPAREL','GRID_TEE','TEE','1-2','2','','YES','SVNTEE1-2-2-S','SVNTEE1-2-2-M','SVNTEE1-2-2-L','SVNTEE1-2-2-XL','SVNTEE1-2-2-XX'],
    ['SVNTEE3-5-1','SVN 3-5 Color 1 Loc Core Cotton Tee','','','','9.95','9.95','9.95','9.95','10.95','tee','YES','APPAREL','GRID_TEE','TEE','3-5','1','','YES','SVNTEE3-5-1-S','SVNTEE3-5-1-M','SVNTEE3-5-1-L','SVNTEE3-5-1-XL','SVNTEE3-5-1-XX'],
    ['SVNHDY1-2-1','SVN 1-2 Color 1 Loc Fleece Hoodie','','','','19.95','19.95','19.95','19.95','21.95','hoodie','YES','APPAREL','GRID_TEE','HDY','1-2','1','','YES','SVNHDY1-2-1-S','SVNHDY1-2-1-M','SVNHDY1-2-1-L','SVNHDY1-2-1-XL','SVNHDY1-2-1-XX'],
    ['SVNJ35-1','SVN 8" Oreo the Border Collie','','','','','','','','','plush oreo border collie','YES','PLUSH','HARDGOOD','','','', 'PLUSH_BANDANA','YES','SVNJ35-1','','','',''],
    ['SVNBEAR10','SVN 10" Sitting Bear with Jersey','','','','','','','','','plush bear jersey','YES','PLUSH','HARDGOOD','','','', 'PLUSH_BEAR','YES','SVNBEAR10','','','',''],
    ['SVNPTCHCAP','SVN Patch Cap','','','','12.50','','','','','cap patch','YES','CAPS','HARDGOOD','','','', 'PATCH_CAP','YES','SVNPTCHCAP','','','',''],
    ['SVNVD6','SVN 6" x 6" Vinyl Decal','','','','4.25','','','','','decal','YES','DECALS','HARDGOOD','','','','','YES','SVNVD6','','','','']
];
var DEMO_COLOR_DATA = {
    TEE: { label: 'Core Cotton Tee', colors: [ {name:'Ash',hex:'#C8C9C7'},{name:'Jet Black',hex:'#0A0A0A'},{name:'Red',hex:'#CE202B'},{name:'Royal',hex:'#2450A0'},{name:'True Navy',hex:'#1B2A4A'},{name:'White',hex:'#FFFFFF'} ] },
    HDY: { label: 'Fleece Hoodie', colors: [ {name:'Ash',hex:'#C8C9C7'},{name:'Jet Black',hex:'#0A0A0A'},{name:'True Navy',hex:'#1B2A4A'},{name:'Red',hex:'#CE202B'} ] },
    PLUSH_BEAR: { attribute:'Bear Color', colors: [ {name:'Beige',hex:'#D9B99B'},{name:'Pink',hex:'#F1B8C8'},{name:'Blue',hex:'#7EC4E8'},{name:'Cream',hex:'#E9E2D0'} ] },
    PLUSH_BANDANA: { attribute:'Bandana Color', colors: [ {name:'Red',hex:'#CE202B'},{name:'White',hex:'#FFFFFF'},{name:'Purple',hex:'#4B2E83'},{name:'Royal Blue',hex:'#2450A0'},{name:'Black',hex:'#0A0A0A'},{name:'Kelly Green',hex:'#4CBB17'} ] },
    PATCH_CAP: { attribute:'Patch Color', colors: [ {name:'Dk Brown',hex:'#4A2E1E'},{name:'Oatmeal',hex:'#D8CBAE'},{name:'Savannah',hex:'#C9A876'},{name:'Stone',hex:'#B7A98A'},{name:'Khaki',hex:'#C3B091'},{name:'Cork',hex:'#9C7A54'} ] }
};
var DEMO_ART_INDEX = [
    { id: 'N012208_01', label: 'Eagle Crest Full Front', thumbUrl: '', keywords: 'eagle crest' },
    { id: 'N012280_01', label: 'Anchor Script Full Front', thumbUrl: '', keywords: 'anchor script' },
    { id: 'N010441_02', label: 'Flag Wave Back Print', thumbUrl: '', keywords: 'flag wave' },
    { id: 'N011290_01', label: 'Trident Badge', thumbUrl: '', keywords: 'trident badge' }
];
