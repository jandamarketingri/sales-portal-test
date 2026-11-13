/* Minimum order quantities (MOQ) from the NEXCOM DSD catalogs
 * (Local Navy Pride and Souvenir, Nov 2026). Shared by souvenirs.html,
 * navy-pride.html and art-request.html. Both catalogs use the same minimums.
 *
 * To change a minimum, edit the numbers below and upload this file to GitHub.
 * Styles are written without the SVN / LNP prefix.
 *
 *   q    = the minimum, per design
 *   note = extra rule shown next to it (optional)
 *
 * Apparel: the minimum goes by the number of ink colors. Different garments
 * and garment colors can be mixed to reach it, as long as the art is the
 * same size (catalog ordering notes).
 */
var MOQ_APPAREL = { '1-2': 48, '3-5': 72, '6-9': 145 };
var MOQ_APPAREL_NOTE = 'Mix garments and colors to reach it (same art size)';

var MOQ_DATA = {
    // Hats
    'PTCHCAP':   { q: 24 },
    'TWL36CAP':  { q: 36, note: 'Hat colors shown in the catalog only' },
    'TWLCAP':    { q: 144, note: 'Any hat color' },
    // Plush
    'J35-1': { q: 24 }, 'J34-9': { q: 24 }, 'J35-2': { q: 24 }, 'J34-8': { q: 24 },
    'J32-1': { q: 24 }, 'J60-1': { q: 24 }, 'J31-1': { q: 24 }, 'J31-6': { q: 24 }, 'J59-1': { q: 24 },
    'J37-T': { q: 24 }, 'J37-MAG': { q: 24 },
    'BEAR6': { q: 24 }, 'BEAR10': { q: 24 }, 'BEAR12': { q: 24 }, 'BEAR10HD': { q: 24 }, 'BEAR12HD': { q: 24 },
    // Lanyards and ID holders
    '632JD': { q: 50 }, '634JD': { q: 50 }, '632JDBA': { q: 50 },
    '212030BH': { q: 50 }, '212036BH': { q: 50 },
    '600TS': { q: 100 }, '600HS': { q: 100 },
    // Decals and magnets
    'VD3.5': { q: 24 }, 'VD6': { q: 24 }, 'VD6X2': { q: 24 }, 'VD10': { q: 24 },
    'VD12X6': { q: 24 }, 'VD12X12': { q: 24 }, 'VD20T': { q: 24 },
    'MAG-SM': { q: 24 }, 'MAG': { q: 24 }, 'MAG6': { q: 24 }, 'MAG8': { q: 24 }, 'MAGEURO': { q: 24 }, 'MAG10T': { q: 24 }, 'MAG12': { q: 24 },
    // Textured stickers (the catalog says 520 for the 5" x 5"; left out until that's confirmed)
    'TS2': { q: 50 }, 'TS3': { q: 35 },
    // Window clings and sticker sheets
    'CL3': { q: 50 }, 'CL5': { q: 40 }, 'CL6X2': { q: 40 }, 'CL16': { q: 20 }, 'SS1': { q: 24 },
    // Bags
    '3071': { q: 150 }, '3220': { q: 36 }, '3220E': { q: 24 },
    // Key chains
    '300JD': { q: 72 }, '301JD': { q: 72 }, '301LG': { q: 72 }, 'BOK01': { q: 48 }, 'KCSTRP-100': { q: 24 },
    // Playing cards and puzzle cubes
    'PCC': { q: 50 }, 'JCUBE': { q: 24 }, 'CUBE-KC': { q: 24 },
    // Ornaments
    '1081100': { q: 12 }, '1081101': { q: 12 }, '1081102': { q: 12 },
    '1081103': { q: 12 }, '1081104': { q: 12 }, '1081105': { q: 12 },
    // Etched glassware and mugs
    '003-7898-DE': { q: 12 }, '003-4585-DE': { q: 12 }, '003-4584-DE': { q: 12 }, '003-0012-DE': { q: 12 },
    '003-2163-DE': { q: 12 }, '003-5166-DE': { q: 12 }, '003-6416-DE': { q: 12 }, '024-6146 ASST': { q: 12 },
    // Polar Camel and Nalgene drinkware
    'PC06': { q: 24, note: '12 per color' }, 'PC09': { q: 24, note: '12 per color' }, 'PC10': { q: 24, note: '12 per color' },
    'PC11': { q: 24, note: '12 per color' }, 'PC13': { q: 24, note: '12 per color' },
    'TC701': { q: 24, note: '12 per color' }, 'TC704': { q: 24, note: '12 per color' },
    'TC825-WH': { q: 48 }
};

/** Minimum for a style such as "SVNTEE3-5-1" or "LNPPC09".
 *  Returns { q, note, key } or null when the catalog has no minimum for it.
 *  `key` groups items that count toward the same minimum. */
function moqFor(style) {
    var s = String(style || '').toUpperCase().replace(/^(SVN|LNP)/, '');
    var m = /^([A-Z]+)(\d-\d)-\d$/.exec(s);          // apparel: TEE1-2-1, HDY6-9-2 …
    if (m && MOQ_APPAREL[m[2]]) return { q: MOQ_APPAREL[m[2]], note: MOQ_APPAREL_NOTE, key: 'APPAREL ' + m[2], apparel: true };
    var keys = Object.keys(MOQ_DATA);
    for (var i = 0; i < keys.length; i++) {
        if (keys[i].toUpperCase() === s) return { q: MOQ_DATA[keys[i]].q, note: MOQ_DATA[keys[i]].note || '', key: s, apparel: false };
    }
    return null;
}
