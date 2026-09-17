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
//   artCsvUrl: 'art-index.csv',        // see art-index-template.csv
//   orderSubmissionUrl: '',            // same Apps Script POST endpoint as apparel.html
//   logo: 'nex-logo.jpg'
// }
// ==========================================================

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
        '<span style="color:#666;font-size:14px;">👤 ' + auth.name + '</span>' +
        '<a href="nexcom-hub.html" style="background:#667eea;color:white;padding:6px 12px;border-radius:4px;text-decoration:none;font-size:14px;font-weight:600;">⇄ NEXCOM Hub</a>' +
        '<a href="my-orders.html" style="background:#764ba2;color:white;padding:6px 12px;border-radius:4px;text-decoration:none;font-size:14px;font-weight:600;">📋 My Orders</a>' +
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
    if (CFG.artCsvUrl) {
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
        return '<div class="size-item"><div class="size-label">' + sz + '</div><input type="number" min="0" value="0" class="size-qty-input" id="qty-' + garmentType + '-' + sz + '"></div>';
    }).join('');

    return '<div class="sku-card" data-garment="' + garmentType + '">' +
        '<div class="product-name">' + group.label + '</div>' +
        '<div class="product-desc">' + CFG.prefix + ' Custom Print</div>' +
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
    var p = tierRec.prices.S;
    return p ? ('$' + parseFloat(p).toFixed(2) + ' ea') : 'TBD';
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
        var matches = artIndex.filter(function (a) { return a.id.toLowerCase().indexOf(q) !== -1 || a.label.toLowerCase().indexOf(q) !== -1 || a.keywords.indexOf(q) !== -1; });
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
            $('#artDropdown-' + key).hide();
            if (!artComboState[key].confirmed && input.val().trim() !== '') {
                input.addClass('invalid'); $('#artError-' + key).show();
            }
        }, 150);
    });
}
function renderArtDropdown(key) {
    var st = artComboState[key];
    var dd = $('#artDropdown-' + key);
    if (!st.filtered.length) { dd.html('<div class="art-empty">No approved designs match that.</div>').show(); return; }
    var html = st.filtered.map(function (a, i) {
        return '<div class="art-option' + (i === st.highlight ? ' highlighted' : '') + '" onmouseenter="artHover(\'' + key + '\',' + i + ')" onclick="artPick(\'' + key + '\',' + i + ')">' +
            '<div class="art-option-thumb" style="background:#888;">🖼️</div>' +
            '<div class="art-option-text"><div class="art-id">' + a.id + '</div><div class="art-desc">' + a.label + '</div></div></div>';
    }).join('');
    dd.html(html).show();
}
function artHover(key, i) { artComboState[key].highlight = i; renderArtDropdown(key); showArtPreview(key, artComboState[key].filtered[i], false); }
function artPick(key, i) { selectArt(key, artComboState[key].filtered[i]); }
function showArtPreview(key, art, locked) {
    var panel = $('#artPreview-' + key), thumb = $('#artPreviewThumb-' + key), empty = $('#artPreviewEmpty-' + key), text = $('#artPreviewText-' + key), status = $('#artPreviewStatus-' + key);
    if (!art) { panel.removeClass('locked'); thumb.css('background', '#ddd').text('🖼️'); empty.show(); text.hide(); status.text(''); return; }
    empty.hide(); text.show();
    thumb.css('background', '#607D8B').text('🖼️');
    $('#artPreviewId-' + key).text(art.id);
    $('#artPreviewDesc-' + key).text(art.label);
    panel.toggleClass('locked', locked);
    status.text(locked ? 'Selected' : 'Previewing');
}
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
                sku: tier.skus[sz], size: sz, quantity: qty,
                category: 'APPAREL', isCustom: true,
                style: tier.baseSKU, styleDesc: tier.description,
                color: st.color, artId: st.art ? st.art.id : '', artLabel: st.art ? st.art.label : '',
                cost: parseFloat(tier.prices[sz]) || 0
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
    return '<div class="sku-card">' +
        '<div class="product-name">' + rec.baseSKU + '</div>' +
        '<div class="product-desc">' + rec.description + '</div>' +
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
        productName: rec.baseSKU, sku: rec.skus.OS || rec.baseSKU, size: 'OS', quantity: qty,
        category: rec.category, isCustom: rec.requiresArt,
        style: rec.baseSKU, styleDesc: rec.description,
        color: st.color || '', artId: st.art ? st.art.id : '', artLabel: st.art ? st.art.label : '',
        cost: parseFloat(rec.prices.OS) || parseFloat(rec.prices.S) || 0
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
            '<span style="font-size:11px;color:#666;">SKU: ' + item.sku + ' · Size: ' + item.size + (item.color ? ' · Color: ' + item.color : '') + (item.artId ? ' · Art: ' + item.artId : '') + '</span></div>' +
            '<div style="display:flex;align-items:center;gap:10px;"><span>×' + item.quantity + '</span><button onclick="removeCartItem(' + i + ')" style="background:none;border:none;color:#c62828;cursor:pointer;font-size:16px;">✕</button></div>' +
            '</div>';
    }).join('');
    $('#cartItems').html(html);
    $('#cartTotalQty').text(cart.reduce(function (s, i) { return s + i.quantity; }, 0));
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

    $('.submit-order-btn').prop('disabled', true).text('Submitting...');
    var form = $('<form>', { method: 'POST', action: CFG.orderSubmissionUrl, target: '_blank', style: 'display:none;' });
    form.append($('<input>', { type: 'hidden', name: 'data', value: JSON.stringify(orderData) }));
    $('body').append(form);
    form.submit();
    setTimeout(function () { form.remove(); }, 1000);

    var totalItems = cart.reduce(function (s, i) { return s + i.quantity; }, 0);
    alert('📤 Order submitted! A new window will open showing the confirmation.\n\nTotal items: ' + totalItems);

    cart = [];
    updateCartBadge();
    closeCart();
    $('.submit-order-btn').prop('disabled', false).text('Submit Order');
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
