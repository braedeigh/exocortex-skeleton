// sky-theme.js — time-of-day color scheme based on Austin sunrise/sunset

// Austin, TX coordinates
const SKY_LAT = 30.2672;
const SKY_LNG = -97.7431;

// Sunrise/sunset — simple solar calculation
// VPS is in CDT (UTC-5)
const SKY_TZ_OFFSET = -5;

function sunTimesFromDay(dayOfYear) {
    const rad = Math.PI / 180;

    const declination = -23.44 * Math.cos(rad * 360 / 365 * (dayOfYear + 10));

    const cosHA = (Math.sin(-0.833 * rad) - Math.sin(SKY_LAT * rad) * Math.sin(declination * rad))
                / (Math.cos(SKY_LAT * rad) * Math.cos(declination * rad));
    if (cosHA > 1 || cosHA < -1) return { sunrise: 6, sunset: 18 };
    const halfDay = Math.acos(cosHA) / rad / 15;

    const B = rad * 360 / 365 * (dayOfYear - 81);
    const EoT = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);

    const solarNoonUTC = 12 - EoT / 60 - SKY_LNG / 15;

    // Always use VPS timezone (CDT)
    const solarNoonLocal = solarNoonUTC + SKY_TZ_OFFSET;

    return {
        sunrise: solarNoonLocal - halfDay,
        sunset: solarNoonLocal + halfDay,
    };
}

// Theme palettes — defaults. Saved overrides from /settings merge over these.
const SKY_DEFAULT_THEMES = {
    night: {
        bg: '#0d0d1a', cardBg: '#1a1a2e', text: '#e8dcc8', textSecondary: 'rgba(220,210,195,0.75)',
        textMuted: 'rgba(180,170,155,0.5)', border: '#2a2a4a',
    },
    dawn: {
        bg: '#1a1520', cardBg: '#2a2030', text: '#f5ede5', textSecondary: 'rgba(240,220,210,0.85)',
        textMuted: 'rgba(215,195,180,0.6)', border: '#3a2a3a',
    },
    postDawn: {
        bg: '#8a7e88', cardBg: '#9a8e98', text: '#1a1815', textSecondary: '#2a2522',
        textMuted: 'rgba(30,25,20,0.5)', border: '#7a7078',
    },
    morning: {
        bg: '#eeeae4', cardBg: '#f8f6f2', text: '#1a1815', textSecondary: '#45403a',
        textMuted: '#8a8278', border: '#d8d2c8',
    },
    day: {
        bg: '#f7f4ef', cardBg: '#fff', text: '#2a2822', textSecondary: '#5a5650',
        textMuted: '#9a968e', border: '#e2ddd5',
    },
    golden: {
        bg: '#1e1812', cardBg: '#2e2518', text: '#f0dcc0', textSecondary: 'rgba(230,210,180,0.8)',
        textMuted: 'rgba(200,180,150,0.55)', border: '#3e3020',
    },
    twilight: {
        bg: '#14101e', cardBg: '#1e1830', text: '#ddd0e8', textSecondary: 'rgba(200,185,220,0.75)',
        textMuted: 'rgba(170,155,190,0.5)', border: '#2e2545',
    },
};

// Default boundary offsets — relative to sunrise (first 4) or sunset (last 3).
const SKY_DEFAULT_OFFSETS = {
    dawnStart: -1, dawnEnd: 0.25, postDawnEnd: 0.75, morningEnd: 2,
    goldenStart: -1.5, twilightStart: 0, twilightEnd: 1,
};

const SKY_DEFAULT_ACCENTS = {
    morning: '#d4880a', evening: '#6a7acc', ongoing: '#3a9e8c', accent: '#7c5cbf',
};

// Resolve overrides → working config
function resolveSkyConfig() {
    const overrides = window.THEME_OVERRIDES || {};
    const themes = {};
    for (const key of Object.keys(SKY_DEFAULT_THEMES)) {
        themes[key] = { ...SKY_DEFAULT_THEMES[key], ...((overrides.themes || {})[key] || {}) };
    }
    // Per-phase disable: a disabled phase inherits the next phase's colors so
    // its window is visually transparent. Order matches the day cycle.
    const phaseOrder = ['night','dawn','postDawn','morning','day','golden','twilight'];
    const enabled = overrides.phasesEnabled || {};
    for (let i = 0; i < phaseOrder.length; i++) {
        const p = phaseOrder[i];
        if (enabled[p] === false) {
            // Find next enabled phase (wrap around)
            for (let j = 1; j <= phaseOrder.length; j++) {
                const next = phaseOrder[(i + j) % phaseOrder.length];
                if (enabled[next] !== false) { themes[p] = themes[next]; break; }
            }
        }
    }
    const offsets = { ...SKY_DEFAULT_OFFSETS, ...(overrides.offsets || {}) };
    const accents = { ...SKY_DEFAULT_ACCENTS, ...(overrides.accents || {}) };
    return { themes, offsets, accents, enabled: overrides.enabled !== false };
}

let themes = resolveSkyConfig().themes;

function hexToRgb(hex) {
    hex = hex.replace('#', '');
    return [parseInt(hex.slice(0,2),16), parseInt(hex.slice(2,4),16), parseInt(hex.slice(4,6),16)];
}

function rgbToHex(r, g, b) {
    return '#' + [r,g,b].map(c => Math.round(Math.max(0,Math.min(255,c))).toString(16).padStart(2,'0')).join('');
}

function lerpColor(a, b, t) {
    const ar = hexToRgb(a), br = hexToRgb(b);
    return rgbToHex(ar[0]+(br[0]-ar[0])*t, ar[1]+(br[1]-ar[1])*t, ar[2]+(br[2]-ar[2])*t);
}

function lerpRgba(a, b, t) {
    // Parse rgba strings
    function parse(s) {
        const m = s.match(/[\d.]+/g);
        return m ? m.map(Number) : [0,0,0,0];
    }
    const ap = parse(a), bp = parse(b);
    const r = ap[0]+(bp[0]-ap[0])*t, g = ap[1]+(bp[1]-ap[1])*t;
    const bl = ap[2]+(bp[2]-ap[2])*t, al = ap[3]+(bp[3]-ap[3])*t;
    return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(bl)},${al.toFixed(2)})`;
}

function blendThemes(a, b, t) {
    return {
        bg: lerpColor(a.bg, b.bg, t),
        cardBg: lerpColor(a.cardBg, b.cardBg, t),
        text: lerpColor(a.text, b.text, t),
        textSecondary: lerpRgba(a.textSecondary, b.textSecondary, t),
        textMuted: lerpRgba(a.textMuted, b.textMuted, t),
        border: lerpColor(a.border, b.border, t),
    };
}

function applyTheme(theme) {
    const r = document.documentElement.style;
    r.setProperty('--bg', theme.bg);
    r.setProperty('--card-bg', theme.cardBg);
    r.setProperty('--text', theme.text);
    r.setProperty('--text-secondary', theme.textSecondary);
    r.setProperty('--text-muted', theme.textMuted);
    r.setProperty('--border', theme.border);
}

function applyAccents(accents) {
    const r = document.documentElement.style;
    r.setProperty('--morning', accents.morning);
    r.setProperty('--evening', accents.evening);
    r.setProperty('--ongoing', accents.ongoing);
    r.setProperty('--accent', accents.accent);
}

// Server time — updated from API data
let _serverHour = null;
let _serverDayOfYear = null;

function updateSkyTheme() {
    const cfg = resolveSkyConfig();
    themes = cfg.themes;
    applyAccents(cfg.accents);
    if (!cfg.enabled) return; // Master toggle off — leave CSS var defaults from style.css

    // Use server time if available, fall back to local
    const hour = _serverHour !== null ? _serverHour : (new Date().getHours() + new Date().getMinutes() / 60);
    const dayOfYear = _serverDayOfYear !== null ? _serverDayOfYear : Math.floor((new Date() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
    const { sunrise, sunset } = sunTimesFromDay(dayOfYear);

    // Phase boundaries (decimal hours) — offsets are relative to sunrise/sunset
    const o = cfg.offsets;
    const dawnStart = sunrise + o.dawnStart;
    const dawnEnd = sunrise + o.dawnEnd;
    const postDawnEnd = sunrise + o.postDawnEnd;
    const morningEnd = sunrise + o.morningEnd;
    const goldenStart = sunset + o.goldenStart;
    const twilightStart = sunset + o.twilightStart;
    const twilightEnd = sunset + o.twilightEnd;

    let theme;

    if (hour < dawnStart || hour >= twilightEnd) {
        // Night
        theme = themes.night;
    } else if (hour < dawnEnd) {
        // Night → dawn
        const t = (hour - dawnStart) / (dawnEnd - dawnStart);
        theme = blendThemes(themes.night, themes.dawn, t);
    } else if (hour < postDawnEnd) {
        // Dawn → postDawn (text flips dark fast)
        const t = (hour - dawnEnd) / (postDawnEnd - dawnEnd);
        theme = blendThemes(themes.dawn, themes.postDawn, t);
    } else if (hour < morningEnd) {
        // PostDawn → morning (bg lightens, text already dark)
        const t = (hour - postDawnEnd) / (morningEnd - postDawnEnd);
        theme = blendThemes(themes.postDawn, themes.morning, t);
    } else if (hour < goldenStart) {
        // Day
        theme = themes.day;
    } else if (hour < twilightStart) {
        // Golden hour: day → golden. Hold text-day-dark longer, snap to dark mode near the end
        // so we don't sit in a muddy mid-tone where text and bg both blend to similar luminance.
        const tRaw = (hour - goldenStart) / (twilightStart - goldenStart);
        const t = tRaw < 0.7 ? tRaw * 0.2 : 0.14 + (tRaw - 0.7) / 0.3 * 0.86;
        theme = blendThemes(themes.day, themes.golden, t);
    } else {
        // Twilight: golden → night. Use a sharper curve so the mid-blend doesn't
        // hold a muddy gray-brown with low contrast for very long. Bg darkens
        // faster than text/border, so text gets the dark-mode flip near the end.
        const tRaw = (hour - twilightStart) / (twilightEnd - twilightStart);
        // Snap at 0.7 — under that, hold the warm-day appearance (just slightly dimmed bg)
        const t = tRaw < 0.7 ? tRaw * 0.25 : 0.175 + (tRaw - 0.7) / 0.3 * 0.825;
        theme = blendThemes(themes.golden, themes.night, t);
    }

    applyTheme(theme);
}

// Run immediately and every 2 minutes
updateSkyTheme();
setInterval(updateSkyTheme, 120000);

// Cross-frame theme refresh: parent (split.html) broadcasts new overrides
// after the settings save handler runs, so every iframe re-skins live.
window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || msg.type !== 'theme-changed' || !msg.overrides) return;
    window.THEME_OVERRIDES = msg.overrides;
    themes = resolveSkyConfig().themes;
    updateSkyTheme();
});
