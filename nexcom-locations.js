/*
 * nexcom-locations.js — rep-scoped store picker for the NEXCOM order pages.
 *
 * Load it right AFTER nexcom-order.js:
 *     <script src="nexcom-order.js"></script>
 *     <script src="nexcom-locations.js"></script>
 *
 * What it does:
 *   - Replaces the free-text "Facility ID" + "Location Name" fields with one
 *     type-ahead "Store" field. Reps type any part of a store name, city,
 *     state or ship-to and pick from matches.
 *   - Only the stores assigned to the logged-in rep's email are loaded
 *     (Admins get every store). Data comes from the Authentication script's
 *     ?action=getMyLocations endpoint (via the relay), which requires the
 *     session token login.html saves — so an email alone isn't enough.
 *   - On pick, fills the (now hidden) #facilityId with the ship-to and
 *     #locationName with the store name, so nexcom-order.js keeps working.
 *   - Blocks submitOrder() unless a store has been picked from the list.
 *
 * Config (optional, in window.NEXCOM_CONFIG):
 *   locationsUrl — endpoint to call. Defaults to the auth relay below
 *                  (the same relay login.html uses).
 */
(function ($) {
    'use strict';

    // Cloudflare relay in front of the Authentication script (same one login.html uses).
    // The browser can't read Apps Script responses directly, so everything goes through it.
    var DEFAULT_SCRIPT_URL = 'https://blue-silence-0a95.will1298.workers.dev';
    var MAX_RESULTS = 60;

    var cfg = window.NEXCOM_CONFIG || {};
    var locationsUrl = cfg.locationsUrl || DEFAULT_SCRIPT_URL;

    var state = {
        locations: [],
        byShipTo: {},
        isAdmin: false,
        loaded: false,
        selected: null,
        results: [],
        highlight: -1
    };

    // ---------- helpers ----------
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function norm(s) {
        return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    }
    function getAuth() {
        try { return JSON.parse(sessionStorage.getItem('salesPortalAuth')) || null; }
        catch (e) { return null; }
    }
    function cityLine(loc) {
        return [loc.city, loc.state].filter(Boolean).join(', ');
    }

    // ---------- matching ----------
    // Every typed word must appear somewhere (name, city, state, address,
    // ship-to). Name matches rank above matches in other fields, and matches at
    // the start of a word rank above matches mid-word.
    function scoreLocation(loc, tokens, rawQuery) {
        var name = loc._name, other = loc._other;
        var score = 0;
        for (var i = 0; i < tokens.length; i++) {
            var t = tokens[i];
            var nIdx = name.indexOf(t);
            if (nIdx !== -1) {
                var wordStart = nIdx === 0 || name.charAt(nIdx - 1) === ' ';
                score += wordStart ? 30 : 15;
                continue;
            }
            var oIdx = other.indexOf(t);
            if (oIdx !== -1) {
                var oWordStart = oIdx === 0 || other.charAt(oIdx - 1) === ' ';
                score += oWordStart ? 10 : 5;
                continue;
            }
            return -1; // this word appears nowhere → not a match
        }
        if (name.indexOf(rawQuery) === 0) score += 100;      // name starts with the whole query
        else if (name.indexOf(rawQuery) !== -1) score += 40; // whole query appears in name
        if (loc._shipTo === rawQuery) score += 200;          // exact ship-to typed
        return score;
    }

    function search(query) {
        var q = norm(query);
        if (!q) return state.locations.slice(0, MAX_RESULTS);
        var tokens = q.split(' ');
        var hits = [];
        state.locations.forEach(function (loc) {
            var s = scoreLocation(loc, tokens, q);
            if (s >= 0) hits.push({ loc: loc, score: s });
        });
        hits.sort(function (a, b) { return b.score - a.score || a.loc.name.localeCompare(b.loc.name); });
        return hits.slice(0, MAX_RESULTS).map(function (h) { return h.loc; });
    }

    function highlightName(name, query) {
        var tokens = norm(query).split(' ').filter(Boolean);
        if (!tokens.length) return esc(name);
        // mark matched characters, then emit
        var lower = name.toLowerCase();
        var marks = new Array(name.length);
        tokens.forEach(function (t) {
            var from = 0, idx;
            while ((idx = lower.indexOf(t, from)) !== -1) {
                for (var k = idx; k < idx + t.length; k++) marks[k] = true;
                from = idx + t.length;
            }
        });
        var out = '', open = false;
        for (var i = 0; i < name.length; i++) {
            if (marks[i] && !open) { out += '<mark>'; open = true; }
            if (!marks[i] && open) { out += '</mark>'; open = false; }
            out += esc(name.charAt(i));
        }
        if (open) out += '</mark>';
        return out;
    }

    // ---------- UI ----------
    var CSS = '' +
        '.loc-field{grid-column:span 2;min-width:0}' +
        '@media (max-width:480px){.loc-field{grid-column:auto}}' +
        '.loc-combo{position:relative}' +
        '.loc-input{width:100%;padding:8px 30px 8px 8px;border:1px solid #ddd;border-radius:5px;font-size:14px;box-sizing:border-box;font-family:inherit}' +
        '.loc-input:focus{outline:none;border-color:#764ba2}' +
        '.loc-input.confirmed{border-color:#4CAF50;background:#f1f8f4}' +
        '.loc-input.invalid{border-color:#f44336;background:#fff5f5}' +
        '.loc-input:disabled{background:#f5f5f5;color:#999}' +
        '.loc-clear{position:absolute;right:6px;top:50%;transform:translateY(-50%);background:none;border:none;font-size:14px;color:#999;cursor:pointer;padding:4px;display:none}' +
        '.loc-combo.has-value .loc-clear{display:block}' +
        '.loc-dropdown{position:absolute;top:calc(100% + 4px);left:0;right:0;max-height:300px;overflow-y:auto;background:#fff;border:1px solid #ddd;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.15);z-index:950;display:none}' +
        '.loc-dropdown.open{display:block}' +
        '.loc-option{padding:8px 10px;cursor:pointer;border-bottom:1px solid #f0f0f0}' +
        '.loc-option:last-child{border-bottom:none}' +
        '.loc-option.highlighted,.loc-option:hover{background:#f1eaf7}' +
        '.loc-option-name{font-weight:700;font-size:13px;color:#222}' +
        '.loc-option-name mark{background:#ffe58a;color:inherit;padding:0;border-radius:2px}' +
        '.loc-option-meta{font-size:11px;color:#666;margin-top:2px}' +
        '.loc-option-reps{font-size:10px;color:#8a6200;margin-top:2px}' +
        '.loc-empty{padding:10px;font-size:12px;color:#888;font-style:italic}' +
        '.loc-status{font-size:11px;margin-top:4px;color:#666;min-height:14px}' +
        '.loc-status.ok{color:#2e7d32;font-weight:600}' +
        '.loc-status.err{color:#c62828;font-weight:600}' +
        // the pages style every ".rep-info-bar div" as a flex column; undo that inside the picker
        '.rep-info-bar .loc-field .loc-combo,.rep-info-bar .loc-field .loc-option,.rep-info-bar .loc-field .loc-option div,.rep-info-bar .loc-field .loc-empty,.rep-info-bar .loc-field .loc-status{display:block}' +
        '.rep-info-bar .loc-field .loc-dropdown{display:none}' +
        '.rep-info-bar .loc-field .loc-dropdown.open{display:block}' +
        '.loc-admin-tag{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:8px;background:#fff3cd;color:#8a6200;font-size:10px;font-weight:700;text-transform:none}';

    var $input, $dropdown, $status, $combo, $facilityId, $locationName;

    function buildUI() {
        $facilityId = $('#facilityId');
        $locationName = $('#locationName');
        if (!$facilityId.length || !$locationName.length) return false;

        $('<style>').text(CSS).appendTo('head');

        // Hide the two old fields but keep them in the DOM for nexcom-order.js
        var $fidWrap = $facilityId.closest('div');
        var $nameWrap = $locationName.closest('div');
        $fidWrap.hide();
        $nameWrap.hide();
        $facilityId.val('').prop('readonly', true);
        $locationName.val('').prop('readonly', true);

        var $field = $(
            '<div class="loc-field">' +
              '<label for="locSearch">Store / Location * <span class="loc-admin-tag" style="display:none">Admin: all stores</span></label>' +
              '<div class="loc-combo">' +
                '<input type="text" id="locSearch" class="loc-input" autocomplete="off" ' +
                  'role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="locList" ' +
                  'placeholder="Loading your stores…" disabled>' +
                '<button type="button" class="loc-clear" aria-label="Clear store">✕</button>' +
                '<div class="loc-dropdown" id="locList" role="listbox"></div>' +
              '</div>' +
              '<div class="loc-status" aria-live="polite"></div>' +
            '</div>'
        );
        $field.insertBefore($fidWrap);

        $input = $field.find('.loc-input');
        $dropdown = $field.find('.loc-dropdown');
        $status = $field.find('.loc-status');
        $combo = $field.find('.loc-combo');

        $input.on('input', function () {
            if (state.selected) clearSelection(true);
            $combo.toggleClass('has-value', !!$input.val());
            renderResults();
            openDropdown();
        });
        $input.on('focus', function () {
            if (!state.loaded || state.selected) return;
            renderResults();
            openDropdown();
        });
        $input.on('keydown', onKeyDown);
        $input.on('blur', function () {
            // let a click on an option land first
            setTimeout(function () {
                closeDropdown();
                if (!state.selected && $input.val().trim()) {
                    $input.addClass('invalid');
                    setStatus('Pick a store from the list.', 'err');
                }
            }, 150);
        });
        $field.find('.loc-clear').on('mousedown', function (e) {
            e.preventDefault();
            clearSelection(false);
            $input.val('').focus();
            $combo.removeClass('has-value');
            renderResults();
            openDropdown();
        });
        $dropdown.on('mousedown', '.loc-option', function (e) {
            e.preventDefault();
            var loc = state.byShipTo[$(this).attr('data-shipto')];
            if (loc) select(loc);
        });
        return true;
    }

    function onKeyDown(e) {
        var n = state.results.length;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (!$dropdown.hasClass('open')) { renderResults(); openDropdown(); return; }
            setHighlight(n ? (state.highlight + 1) % n : -1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlight(n ? (state.highlight - 1 + n) % n : -1);
        } else if (e.key === 'Enter') {
            if ($dropdown.hasClass('open') && n) {
                e.preventDefault();
                select(state.results[state.highlight >= 0 ? state.highlight : 0]);
            }
        } else if (e.key === 'Escape') {
            closeDropdown();
        }
    }

    function setHighlight(i) {
        state.highlight = i;
        var $opts = $dropdown.find('.loc-option').removeClass('highlighted').attr('aria-selected', 'false');
        if (i >= 0) {
            var $o = $opts.eq(i).addClass('highlighted').attr('aria-selected', 'true');
            var el = $o[0], box = $dropdown[0];
            if (el) {
                if (el.offsetTop < box.scrollTop) box.scrollTop = el.offsetTop;
                else if (el.offsetTop + el.offsetHeight > box.scrollTop + box.clientHeight)
                    box.scrollTop = el.offsetTop + el.offsetHeight - box.clientHeight;
            }
        }
    }

    function renderResults() {
        var q = $input.val();
        state.results = search(q);
        state.highlight = state.results.length ? 0 : -1;

        if (!state.results.length) {
            $dropdown.html('<div class="loc-empty">No stores match “' + esc(q) + '” in your assigned list.</div>');
            return;
        }
        var html = state.results.map(function (loc, i) {
            var meta = [cityLine(loc), 'Ship-to ' + loc.shipTo].filter(Boolean).join(' · ');
            return '<div class="loc-option' + (i === 0 ? ' highlighted' : '') + '" role="option" ' +
                'id="locOpt' + i + '" data-shipto="' + esc(loc.shipTo) + '" aria-selected="' + (i === 0) + '">' +
                '<div class="loc-option-name">' + highlightName(loc.name, q) + '</div>' +
                '<div class="loc-option-meta">' + esc(meta) + '</div>' +
                (state.isAdmin ? '<div class="loc-option-reps">' + (loc.reps ? 'Rep: ' + esc(loc.reps) : 'Unassigned') + '</div>' : '') +
                '</div>';
        }).join('');
        var total = norm(q) ? '' : (state.locations.length > MAX_RESULTS
            ? '<div class="loc-empty">Showing first ' + MAX_RESULTS + ' of ' + state.locations.length + ' — type to narrow down.</div>' : '');
        $dropdown.html(html + total);
    }

    function openDropdown() { $dropdown.addClass('open'); $input.attr('aria-expanded', 'true'); }
    function closeDropdown() { $dropdown.removeClass('open'); $input.attr('aria-expanded', 'false'); }

    function setStatus(text, cls) {
        $status.removeClass('ok err').addClass(cls || '').text(text || '');
    }

    function select(loc) {
        state.selected = loc;
        $input.val(loc.name).removeClass('invalid').addClass('confirmed');
        $combo.addClass('has-value');
        $facilityId.val(loc.shipTo);
        $locationName.val(loc.name);
        closeDropdown();
        var addr = [loc.address, cityLine(loc), loc.zip].filter(Boolean).join(', ');
        setStatus('✓ Ship-to ' + loc.shipTo + (addr ? ' · ' + addr : ''), 'ok');
        $(document).trigger('nexcom:locationSelected', [loc]);
    }

    function clearSelection(keepText) {
        state.selected = null;
        $facilityId.val('');
        $locationName.val('');
        $input.removeClass('confirmed invalid');
        if (!keepText) $input.val('');
        setStatus('', '');
        $(document).trigger('nexcom:locationCleared');
    }

    // ---------- data ----------
    function loadLocations() {
        var auth = getAuth();
        if (!auth || !auth.email) {
            setStatus('Not logged in.', 'err');
            $input.attr('placeholder', 'Log in to see your stores');
            return;
        }
        if (!auth.token) {
            // logged in before session tokens existed
            setStatus('Please log out and log back in to load your stores.', 'err');
            $input.attr('placeholder', 'Log in again to see your stores');
            return;
        }
        $.ajax({
            url: locationsUrl,
            method: 'GET',
            cache: false,
            dataType: 'json',
            timeout: 20000,
            data: { action: 'getMyLocations', email: auth.email, token: auth.token || '' }
        }).done(function (resp) {
            if (!resp || !resp.success) {
                setStatus((resp && resp.message) || 'Could not load your stores.', 'err');
                $input.attr('placeholder', 'Stores unavailable');
                return;
            }
            state.isAdmin = !!resp.isAdmin;
            state.locations = (resp.locations || []).map(function (loc) {
                loc.shipTo = String(loc.shipTo);
                loc._name = norm(loc.name);
                loc._shipTo = norm(loc.shipTo);
                loc._other = norm([loc.city, loc.state, loc.address, loc.zip, loc.shipTo].join(' '));
                return loc;
            });
            state.byShipTo = {};
            state.locations.forEach(function (loc) { state.byShipTo[loc.shipTo] = loc; });
            state.loaded = true;

            if (state.isAdmin) $('.loc-admin-tag').show();

            if (!state.locations.length) {
                $input.attr('placeholder', 'No stores assigned');
                setStatus('No stores are assigned to ' + auth.email + '. Contact your administrator.', 'err');
                return;
            }
            $input.prop('disabled', false).attr('placeholder', 'Start typing a store name, city or state…');
            if (state.locations.length === 1) {
                select(state.locations[0]);
            } else {
                setStatus(state.locations.length + ' stores available to you.', '');
            }
        }).fail(function () {
            setStatus('Could not reach the server to load your stores. Refresh to try again.', 'err');
            $input.attr('placeholder', 'Stores unavailable');
        });
    }

    // ---------- submit guard ----------
    function guardSubmit() {
        var original = window.submitOrder;
        if (typeof original !== 'function' || original.__locGuarded) return;
        var guarded = function () {
            var loc = state.selected;
            var ok = loc && state.byShipTo[loc.shipTo] === loc &&
                     $facilityId.val() === loc.shipTo && $locationName.val() === loc.name;
            if (!ok) {
                alert('Please pick a store from your list before submitting.');
                if (typeof window.closeCart === 'function') window.closeCart();
                $input.addClass('invalid').focus();
                return;
            }
            return original.apply(this, arguments);
        };
        guarded.__locGuarded = true;
        window.submitOrder = guarded;
    }

    // Public hooks for nexcom-order.js (optional)
    window.NexcomLocations = {
        getSelected: function () { return state.selected; },
        isLoaded: function () { return state.loaded; },
        reload: loadLocations
    };

    $(function () {
        if (!buildUI()) return;
        guardSubmit();
        loadLocations();
    });
})(jQuery);
