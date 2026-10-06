// auth.js — блок реєстрації/авторизації + особиста статистика + онлайн,
// зверху справа. Незалежний модуль: сам будує свою розмітку і стилі,
// нічого не потребує від engine.js окрім самого факту імпорту.

const AUTH_URL = './auth.php';
const HEARTBEAT_MS = 30000; // раз на 30с — оновлює last_seen і список онлайн

let currentUser = null; // { id, login, kill_mode1, kill_mode2, kill_mode4, cnt_drones, flight_seconds } | null
let panelEl = null;
let mode = 'login'; // 'login' | 'register' — який таб активний у формі

async function api(action, body = null) {
    const opts = {
        method: body ? 'POST' : 'GET',
        credentials: 'include', // обов'язково — сесія тримається на cookie
    };
    if (body) {
        opts.headers = { 'Content-Type': 'application/json' };
        opts.body = JSON.stringify(body);
    }
    try {
        const res = await fetch(`${AUTH_URL}?action=${action}`, opts);
        return await res.json();
    } catch (e) {
        console.warn('auth api failed', action, e);
        return { ok: false, error: 'network' };
    }
}

function ensureStyle() {
    if (document.getElementById('auth-panel-style')) return;
    const style = document.createElement('style');
    style.id = 'auth-panel-style';
    style.textContent = `
        .auth-panel {
            position: fixed;
            top: 18px;
            right: 24px;
            width: 280px;
            background: rgba(8, 12, 10, 0.82);
            border: 1px solid rgba(251, 207, 24, 0.22);
            border-radius: 6px;
            padding: 16px 16px 14px;
            color: #d8d8d8;
            font-size: 12px;
            font-family: 'Share Tech Mono', 'Courier New', monospace;
            z-index: 140;
            pointer-events: auto;
            box-shadow:
                0 16px 48px rgba(0,0,0,0.55),
                inset 0 1px 0 rgba(255,255,255,0.04);
            backdrop-filter: blur(14px);
            -webkit-backdrop-filter: blur(14px);
            animation: authIn 0.45s ease-out;
        }
        /* Мобільний стек: ніколи не fixed */
        .auth-panel.auth-in-stack {
            position: relative !important;
            top: auto !important;
            right: auto !important;
            left: auto !important;
            bottom: auto !important;
            inset: auto !important;
            transform: none !important;
            width: 100% !important;
            max-width: none !important;
            margin: 0 !important;
            z-index: 1 !important;
            animation: none !important;
            background: transparent !important;
            border: none !important;
            border-radius: 0 !important;
            box-shadow: none !important;
            backdrop-filter: none !important;
            -webkit-backdrop-filter: none !important;
            padding: 12px 14px !important;
            float: none !important;
        }
        .auth-panel.auth-hidden {
            display: none !important;
            visibility: hidden !important;
            pointer-events: none !important;
        }
        @keyframes authIn {
            from { opacity: 0; transform: translateY(-8px); }
            to   { opacity: 1; transform: translateY(0); }
        }
        .auth-panel h4 {
            color: #fbcf18;
            font-size: 12px;
            font-family: inherit;
            letter-spacing: 0.22em;
            margin: 0 0 12px;
            text-align: left;
            text-transform: uppercase;
            border-bottom: 1px solid rgba(251,207,24,0.18);
            padding-bottom: 8px;
            text-shadow: 0 0 12px rgba(251,207,24,0.25);
        }
        .auth-panel input,
        .auth-panel input[type="text"],
        .auth-panel input[type="password"],
        .auth-panel input[type="email"] {
            width: 100%;
            font-family: inherit;
            font-size: 12px;
            border-radius: 4px;
            border: 1px solid rgba(255,255,255,0.1);
            background: #0c100e !important;
            background-color: #0c100e !important;
            color: #eee !important;
            padding: 7px 9px;
            outline: none;
            transition: border-color 0.15s;
            color-scheme: dark;
            -webkit-text-fill-color: #eee;
            box-sizing: border-box;
        }
        .auth-panel input:focus,
        .auth-panel input:hover,
        .auth-panel input:active,
        .auth-panel input:-webkit-autofill,
        .auth-panel input:-webkit-autofill:hover,
        .auth-panel input:-webkit-autofill:focus {
            border-color: rgba(251,207,24,0.55);
            box-shadow: 0 0 0 1px rgba(251,207,24,0.12);
            background: #101612 !important;
            background-color: #101612 !important;
            color: #eee !important;
            -webkit-text-fill-color: #eee;
            /* chrome autofill жовтий фон */
            -webkit-box-shadow: 0 0 0 1000px #101612 inset !important;
            transition: background-color 9999s ease-out;
        }
        .auth-panel input::placeholder { color: rgba(255,255,255,0.3); }
        .auth-panel button {
            font-family: inherit;
            font-size: 12px;
            font-weight: 700;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            border: none;
            border-radius: 4px;
            padding: 10px 14px;
            cursor: pointer;
            background: linear-gradient(180deg, #ffe566 0%, #fbcf18 50%, #d4a80a 100%);
            color: #0a0c08;
            white-space: nowrap;
            transition: filter 0.15s, transform 0.1s;
        }
        .auth-panel button:hover { filter: brightness(1.08); }
        .auth-panel button:active { transform: scale(0.98); }
        .auth-panel button:disabled { opacity: 0.5; cursor: wait; }
        .auth-panel .auth-tabs {
            display: flex;
            gap: 4px;
            margin-bottom: 12px;
            background: rgba(0,0,0,0.35);
            border-radius: 4px;
            padding: 3px;
        }
        .auth-panel .auth-tab {
            flex: 1;
            text-align: center;
            padding: 7px 0;
            border-radius: 3px;
            border: none;
            color: rgba(255,255,255,0.4);
            cursor: pointer;
            font-size: 11px;
            letter-spacing: 0.1em;
            text-transform: uppercase;
            transition: color 0.15s, background 0.15s;
        }
        .auth-panel .auth-tab:hover { color: rgba(255,255,255,0.7); }
        .auth-panel .auth-tab.active {
            background: rgba(251,207,24,0.15);
            color: #fbcf18;
        }
        .auth-panel .auth-error {
            color: #ff6b6b;
            font-size: 11px;
            margin-bottom: 8px;
            padding: 6px 8px;
            background: rgba(255,80,80,0.08);
            border-radius: 3px;
            border-left: 2px solid #ff6b6b;
        }
        .auth-panel .auth-fields {
            display: flex;
            flex-direction: column;
            gap: 8px;
            margin-bottom: 10px;
        }
        .auth-panel .auth-submit-row {
            display: flex;
            gap: 8px;
        }
        .auth-panel .auth-submit-row button { flex: 1; }
        .auth-panel .auth-header-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 12px;
            gap: 10px;
        }
        .auth-panel .auth-user-row {
            color: #fbcf18;
            font-weight: 700;
            font-size: 14px;
            letter-spacing: 0.04em;
            word-break: break-all;
        }
        .auth-panel .auth-user-badge {
            display: inline-flex;
            align-items: center;
            gap: 8px;
        }
        .auth-panel .auth-avatar {
            width: 28px;
            height: 28px;
            border-radius: 4px;
            background: linear-gradient(135deg, #fbcf18 0%, #a88000 100%);
            color: #0a0c08;
            font-weight: 800;
            font-size: 13px;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            box-shadow: 0 0 12px rgba(251,207,24,0.3);
        }
        .auth-panel .auth-stats-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 6px 12px;
            margin-bottom: 10px;
        }
        .auth-panel .auth-stat {
            display: flex;
            flex-direction: column;
            gap: 1px;
        }
        .auth-panel .auth-stat-label {
            font-size: 10px;
            color: rgba(255,255,255,0.35);
            letter-spacing: 0.08em;
            text-transform: uppercase;
        }
        .auth-panel .auth-stat-value {
            color: #eee;
            font-size: 13px;
            font-weight: 600;
        }
        .auth-panel .auth-stat-value.accent { color: #fbcf18; }
        .auth-panel .auth-online-block {
            border-top: 1px solid rgba(255,255,255,0.08);
            padding-top: 8px;
            margin-top: 2px;
        }
        .auth-panel .auth-online-head {
            display: flex;
            justify-content: space-between;
            color: rgba(255,255,255,0.4);
            font-size: 10px;
            letter-spacing: 0.1em;
            text-transform: uppercase;
            margin-bottom: 4px;
        }
        .auth-panel .auth-online-head b { color: #7dffa0; font-weight: 600; }
        .auth-panel .auth-online-list {
            max-height: 36px;
            overflow-y: auto;
            color: rgba(255,255,255,0.45);
            font-size: 11px;
            line-height: 1.4;
        }
        .auth-panel .auth-logout {
            background: transparent;
            border: 1px solid rgba(217, 83, 79, 0.5);
            color: #e07070;
            padding: 6px 12px;
            font-size: 10px;
            letter-spacing: 0.1em;
            box-shadow: none;
        }
        .auth-panel .auth-logout:hover {
            background: rgba(217, 83, 79, 0.85);
            color: #fff;
            border-color: transparent;
            filter: none;
        }
        @media (max-width: 900px) {
            .auth-panel {
                top: 12px; right: 12px;
                width: min(300px, calc(100vw - 24px));
                padding: 12px;
            }
            /* Всередині спільного мобільного блоку — у потоці, без fixed */
            .menu-auth-slot .auth-panel,
            #menuAuthSlot .auth-panel {
                position: relative !important;
                top: auto !important;
                right: auto !important;
                left: auto !important;
                width: 100% !important;
                max-width: none !important;
                margin: 0 !important;
                padding: 12px 14px !important;
                background: transparent !important;
                border: none !important;
                border-radius: 0 !important;
                box-shadow: none !important;
                backdrop-filter: none !important;
                z-index: 1 !important;
                animation: none !important;
            }
        }
    `;
    document.head.appendChild(style);
}

function ensurePanel() {
    if (panelEl) return panelEl;
    ensureStyle();
    panelEl = document.createElement('div');
    panelEl.className = 'auth-panel auth-hidden';
    // Прихована, поки головне меню не готове (лоадинг / політ).
    panelEl.style.setProperty('display', 'none', 'important');
    document.body.appendChild(panelEl);
    return panelEl;
}

function notifyMenuAuthPlace() {
    try {
        if (typeof window.__fpvSyncAuthPlacement === 'function') {
            window.__fpvSyncAuthPlacement();
        }
    } catch (_) {}
}

function renderLoggedOut(errorMsg = '') {
    const p = ensurePanel();
    p.innerHTML = `
        <h4>Профіль пілота</h4>
        <div class="auth-tabs">
            <div class="auth-tab ${mode === 'login' ? 'active' : ''}" data-tab="login">Вхід</div>
            <div class="auth-tab ${mode === 'register' ? 'active' : ''}" data-tab="register">Реєстрація</div>
        </div>
        ${errorMsg ? `<div class="auth-error">${escapeHtml(errorMsg)}</div>` : ''}
        <div class="auth-fields">
            <input type="text" id="authLogin" placeholder="Логін" autocomplete="username" maxlength="20" />
            <input type="password" id="authPass" placeholder="Пароль" autocomplete="current-password" />
        </div>
        <div class="auth-submit-row">
            <button id="authSubmit">${mode === 'login' ? 'Увійти' : 'Створити'}</button>
        </div>
    `;

    p.querySelectorAll('.auth-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            mode = tab.dataset.tab;
            renderLoggedOut();
        });
    });

    notifyMenuAuthPlace();

    p.querySelector('#authSubmit').addEventListener('click', async () => {
        const login = p.querySelector('#authLogin').value.trim();
        const pass = p.querySelector('#authPass').value;
        const btn = p.querySelector('#authSubmit');
        btn.disabled = true;

        const result = await api(mode, { login, pass });

        btn.disabled = false;
        if (result.ok) {
            currentUser = result.user;
            renderLoggedIn();
            emitAuthChanged();
        } else {
            renderLoggedOut(result.error || 'Помилка');
        }
    });

    p.querySelector('#authPass').addEventListener('keydown', (e) => {
        if (e.code === 'Enter') p.querySelector('#authSubmit').click();
    });
    p.querySelector('#authLogin').addEventListener('keydown', (e) => {
        if (e.code === 'Enter') p.querySelector('#authPass').focus();
    });
}

async function renderLoggedIn() {
    const p = ensurePanel();
    const initial = (currentUser.login || '?').charAt(0).toUpperCase();
    p.innerHTML = `
        <div class="auth-header-row">
            <div class="auth-user-badge">
                <div class="auth-avatar">${escapeHtml(initial)}</div>
                <span class="auth-user-row">${escapeHtml(currentUser.login)}</span>
            </div>
            <button class="auth-logout" id="authLogoutBtn">Вихід</button>
        </div>
        <div class="auth-stats-grid" style="grid-template-columns:1fr">
            <div class="auth-stat">
                <span class="auth-stat-label">Наліт</span>
                <span class="auth-stat-value accent">${formatFlightTime(currentUser.flight_seconds)}</span>
            </div>
        </div>
        <div class="auth-online-block">
            <div class="auth-online-head">
                <span>Пілоти в мережі</span>
                <b id="authOnlineCount">…</b>
            </div>
            <div class="auth-online-list" id="authOnlineList">…</div>
        </div>
    `;

    p.querySelector('#authLogoutBtn').addEventListener('click', async () => {
        await api('logout', {});
        currentUser = null;
        mode = 'login';
        renderLoggedOut();
        emitAuthChanged();
    });

    refreshOnline();
    notifyMenuAuthPlace();
}

function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

/** 125 → "2год 05хв", 340 → "5хв", 40 → "<1хв" */
function formatFlightTime(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h}год ${String(m).padStart(2, '0')}хв`;
    if (m > 0) return `${m}хв`;
    return '<1хв';
}

async function refreshOnline() {
    if (!currentUser || !panelEl) return;
    const result = await api('online');
    const countEl = panelEl.querySelector('#authOnlineCount');
    const listEl = panelEl.querySelector('#authOnlineList');
    if (!countEl || !listEl) return; // панель могла вже перемалюватись (вихід)

    if (result.ok) {
        countEl.textContent = result.count;
        listEl.textContent = result.users.join(', ') || '—';
    }
}

async function refreshPersonalStats() {
    if (!currentUser) return;
    const result = await api('me');
    if (result.ok && result.user) {
        currentUser = result.user;
        if (panelEl && panelEl.querySelector('.auth-user-row')) {
            renderLoggedIn();
        }
    }
}

export async function initAuth() {
    ensurePanel();
    setPanelVisible(false);
    renderLoggedOut();
    setPanelVisible(false); // render не повинен знімати hidden під час лоадингу

    window.addEventListener('fpv-start-menu-ready', () => {
        setPanelVisible(true);
    });

    const result = await api('me');
    if (result.ok && result.user) {
        currentUser = result.user;
        renderLoggedIn();
        emitAuthChanged();
    }
    // /me може перемалювати панель — знову ховаємо, якщо меню ще не готове
    if (!panelWantVisible) setPanelVisible(false);

    setInterval(async () => {
        if (currentUser) {
            await api('heartbeat', {});
            await refreshOnline();
            await refreshPersonalStats();
        }
    }, HEARTBEAT_MS);
}

export function isLoggedIn() {
    return !!currentUser;
}

export function getCurrentUser() {
    return currentUser;
}

export function logFlightStart(detail) {
    const payload = {
        mode: detail && detail.mode != null ? detail.mode : 0,
        lat: detail && detail.lat != null ? detail.lat : null,
        lon: detail && detail.lon != null ? detail.lon : null,
    };
    api('logFlight', payload).catch(() => {});
}

function emitAuthChanged() {
    try {
        window.dispatchEvent(new CustomEvent('fpv-auth-changed', { detail: { user: currentUser } }));
    } catch (_) {}
}

/** Чи має панель бути видимою. false = лоадинг / політ. */
let panelWantVisible = false;

export function isPanelWantVisible() {
    return panelWantVisible;
}

/** Приховує/показує всю панель — викликається з engine.js: сховати на
 * час польоту (Start), показати знову при поверненні в меню (ESC). */
export function setPanelVisible(visible) {
    panelWantVisible = !!visible;
    const p = ensurePanel();
    if (visible) {
        p.style.removeProperty('display');
    } else {
        // important — перебиває syncAuthPlacement / inline з menu.js
        p.style.setProperty('display', 'none', 'important');
    }
    p.classList.toggle('auth-hidden', !visible);
}

if (typeof window !== 'undefined') {
    window.__fpvSetAuthVisible = setPanelVisible;
    window.__fpvIsAuthWantVisible = isPanelWantVisible;
}

/** Викликається зі stats.js при кожному reportKill(). type: 'car'|'tank'|'drone'|'heli' */
export async function reportPersonalKill(type) {
    if (!currentUser) return; // не залогінені гравці не мають персональної статистики
    const result = await api('kill', { type });
    if (result.ok && result.user) {
        currentUser = result.user;
        if (panelEl && panelEl.querySelector('.auth-user-row')) {
            renderLoggedIn();
        }
    } else {
        // Раніше тут не було жодного логу — помилка тихо ковталась, і
        // з інтерфейсу було неможливо зрозуміти, чому кіл не порахувався.
        console.warn('reportPersonalKill(' + type + ') failed:', result.error || result);
    }
}

/** Викликається з engine.js періодично (кожні ~20с реального польоту) та
 * при поверненні в меню (Escape) — надсилає ДЕЛЬТУ часу з моменту
 * останньої відправки, не абсолютний наліт. */
export async function reportFlightTime(deltaSeconds) {
    if (!currentUser || !(deltaSeconds > 0)) return;
    const result = await api('addFlightTime', { seconds: deltaSeconds });
    if (result.ok && result.user) {
        currentUser = result.user;
        if (panelEl && panelEl.querySelector('.auth-user-row')) {
            renderLoggedIn();
        }
    } else {
        console.warn('reportFlightTime failed:', result.error || result);
    }
}

/** Той самий звіт про наліт, але через navigator.sendBeacon — для випадку
 * закриття вкладки/переходу зі сторінки, коли звичайний fetch() може не
 * встигнути завершитись (браузер обриває мережеві запити при unload). */
export function reportFlightTimeBeacon(deltaSeconds) {
    if (!currentUser || !(deltaSeconds > 0)) return;
    if (!navigator.sendBeacon) return; // старі браузери — просто втрачаємо останні секунди
    try {
        const blob = new Blob(
            [JSON.stringify({ seconds: deltaSeconds })],
            { type: 'application/json' }
        );
        navigator.sendBeacon(`${AUTH_URL}?action=addFlightTime`, blob);
    } catch (e) {
        console.warn('reportFlightTimeBeacon failed', e);
    }
}

initAuth();
