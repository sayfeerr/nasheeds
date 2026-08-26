"use strict";

/* =========================================================
   NUSHUD USER UPLOAD
   Subida privada de 1 nasheed por día
   ========================================================= */

(() => {

    const SECTION_ID = "section-upload";
    const MAX_AUDIO = 25 * 1024 * 1024;
    const MAX_COVER = 5 * 1024 * 1024;

    const AUDIO_TYPES = new Set([
        "audio/mpeg",
        "audio/mp3",
        "audio/mp4",
        "audio/x-m4a",
        "audio/m4a",
        "audio/ogg",
        "audio/wav",
        "audio/x-wav",
        "audio/webm",
        "audio/flac",
        "video/mp4",
        "video/webm"
    ]);

    const COVER_TYPES = new Set([
        "image/jpeg",
        "image/png",
        "image/webp"
    ]);

    let supabaseClient = null;
    let currentUser = null;
    let currentSession = null;

    let userNasheeds = [];

    let initialized = false;
    let busy = false;


    /* =====================================================
       UTILIDADES
       ===================================================== */

    function todayISO() {

        return new Date()
            .toISOString()
            .slice(0, 10);

    }


    function escapeHtml(value) {

        const div =
            document.createElement("div");

        div.textContent =
            String(value ?? "");

        return div.innerHTML;

    }


    function formatDate(value) {

        if (!value) {
            return "";
        }

        const date =
            new Date(value);

        if (
            Number.isNaN(
                date.getTime()
            )
        ) {
            return "";
        }

        return new Intl.DateTimeFormat(
            document.documentElement.lang === "en"
                ? "en-GB"
                : "es-ES",
            {
                day: "2-digit",
                month: "2-digit",
                year: "numeric"
            }
        ).format(date);

    }


    function formatBytes(bytes) {

        const value =
            Number(bytes);

        if (!Number.isFinite(value)) {
            return "0 MB";
        }

        if (value < 1024 * 1024) {
            return (
                Math.round(value / 1024) +
                " KB"
            );
        }

        return (
            (value / 1024 / 1024)
                .toFixed(1)
                .replace(".", ",") +
            " MB"
        );

    }


    function isValidAudio(file) {

        if (!file) {
            return false;
        }

        if (
            file.size <= 0 ||
            file.size > MAX_AUDIO
        ) {
            return false;
        }

        return AUDIO_TYPES.has(
            String(file.type || "")
                .toLowerCase()
        );

    }


    function isValidCover(file) {

        if (!file) {
            return true;
        }

        if (
            file.size <= 0 ||
            file.size > MAX_COVER
        ) {
            return false;
        }

        return COVER_TYPES.has(
            String(file.type || "")
                .toLowerCase()
        );

    }


    function setStatus(
        message,
        type = "info"
    ) {

        const element =
            document.getElementById(
                "nushud-upload-status"
            );

        if (!element) {
            return;
        }

        element.textContent =
            message || "";

        element.className =
            "nushud-upload-status " +
            type;

    }


    function setBusy(value) {

        busy =
            Boolean(value);

        const button =
            document.getElementById(
                "nushud-upload-submit"
            );

        if (!button) {
            return;
        }

        button.disabled =
            busy;

        if (busy) {

            button.textContent =
                "Procesando...";

        } else {

            button.textContent =
                "Subir nasheed";

        }

    }


    /* =====================================================
       CONFIGURACIÓN SUPABASE
       ===================================================== */

    async function getSupabaseClient() {

        if (
            supabaseClient
        ) {
            return supabaseClient;
        }

        if (
            !window.supabase ||
            typeof window.supabase.createClient !==
                "function"
        ) {

            throw new Error(
                "La librería de Supabase no está disponible."
            );

        }

        const response =
            await fetch(
                "/api/public-config",
                {
                    method: "GET",
                    cache: "no-store",
                    credentials: "same-origin",
                    headers: {
                        Accept:
                            "application/json"
                    }
                }
            );

        if (!response.ok) {

            throw new Error(
                "No se pudo cargar la configuración de Supabase."
            );

        }

        const config =
            await response.json();

        if (
            !config.supabaseUrl ||
            !config.supabasePublishableKey
        ) {

            throw new Error(
                "La configuración de Supabase está incompleta."
            );

        }

        supabaseClient =
            window.supabase.createClient(
                config.supabaseUrl,
                config.supabasePublishableKey,
                {
                    auth: {
                        persistSession: true,
                        autoRefreshToken: true,
                        detectSessionInUrl: true
                    }
                }
            );

        return supabaseClient;

    }


    /* =====================================================
       SESIÓN
       ===================================================== */

    async function refreshAuth() {

        try {

            const client =
                await getSupabaseClient();

            /*
             * getSession() obtiene la sesión persistida.
             * Después usamos getUser() para confirmar el usuario.
             */

            const sessionResult =
                await client.auth.getSession();

            currentSession =
                sessionResult?.data?.session ||
                null;

            if (!currentSession) {

                currentUser =
                    null;

                return null;

            }

            const userResult =
                await client.auth.getUser();

            currentUser =
                userResult?.data?.user ||
                null;

            if (
                !currentUser
            ) {

                currentSession =
                    null;

            }

            return currentUser;

        } catch (error) {

            console.error(
                "[NUSHUD UPLOAD AUTH]",
                error
            );

            currentUser =
                null;

            currentSession =
                null;

            return null;

        }

    }


    async function getAccessToken() {

        const client =
            await getSupabaseClient();

        const result =
            await client.auth.getSession();

        const session =
            result?.data?.session ||
            null;

        currentSession =
            session;

        currentUser =
            session?.user ||
            null;

        if (
            !session?.access_token
        ) {

            return null;

        }

        return session.access_token;

    }


    /* =====================================================
       HTML
       ===================================================== */

    function ensureStyles() {

        if (
            document.getElementById(
                "nushud-upload-style"
            )
        ) {
            return;
        }

        const style =
            document.createElement("style");

        style.id =
            "nushud-upload-style";

        style.textContent = `
            #${SECTION_ID} .nushud-upload-shell {
                width: 100%;
            }

            #${SECTION_ID} .nushud-upload-header {
                display: flex;
                align-items: flex-start;
                justify-content: space-between;
                gap: 20px;
                margin-bottom: 18px;
            }

            #${SECTION_ID} .nushud-upload-title {
                margin: 0;
                color: #f4f4f5;
                font-size: 20px;
                font-weight: 800;
                letter-spacing: -.02em;
            }

            #${SECTION_ID} .nushud-upload-subtitle {
                margin-top: 6px;
                color: #71717a;
                font-size: 11px;
                line-height: 1.6;
            }

            #${SECTION_ID} .nushud-upload-pill {
                flex-shrink: 0;
                padding: 7px 10px;
                border-radius: 10px;
                background: rgba(245,158,11,.08);
                border: 1px solid rgba(245,158,11,.15);
                color: #fbbf24;
                font-size: 9px;
                font-weight: 800;
                letter-spacing: .06em;
                text-transform: uppercase;
            }

            #${SECTION_ID} .nushud-upload-card {
                padding: 20px;
                border-radius: 22px;
                background: rgba(18,18,23,.62);
                backdrop-filter: blur(12px);
                border: 1px solid rgba(255,255,255,.05);
            }

            #${SECTION_ID} .nushud-upload-field {
                margin-bottom: 16px;
            }

            #${SECTION_ID} .nushud-upload-label {
                display: block;
                margin-bottom: 7px;
                color: #a1a1aa;
                font-size: 10px;
                font-weight: 700;
            }

            #${SECTION_ID} .nushud-upload-input {
                width: 100%;
                box-sizing: border-box;
                border: 1px solid rgba(255,255,255,.08);
                background: rgba(7,7,10,.7);
                color: #f4f4f5;
                border-radius: 13px;
                padding: 11px 12px;
                outline: none;
                font-size: 11px;
            }

            #${SECTION_ID} .nushud-upload-input:focus {
                border-color: rgba(245,158,11,.45);
                box-shadow: 0 0 0 3px rgba(245,158,11,.07);
            }

            #${SECTION_ID} .nushud-upload-file {
                width: 100%;
                box-sizing: border-box;
                border: 1px dashed rgba(255,255,255,.10);
                background: rgba(255,255,255,.025);
                color: #a1a1aa;
                border-radius: 15px;
                padding: 13px;
                font-size: 10px;
            }

            #${SECTION_ID} .nushud-upload-file::file-selector-button {
                border: 0;
                border-radius: 9px;
                padding: 7px 10px;
                margin-right: 9px;
                background: rgba(245,158,11,.12);
                color: #fbbf24;
                font-weight: 800;
                cursor: pointer;
            }

            #${SECTION_ID} .nushud-upload-help {
                margin-top: 6px;
                color: #52525b;
                font-size: 9px;
                line-height: 1.45;
            }

            #${SECTION_ID} .nushud-language-grid {
                display: grid;
                grid-template-columns: repeat(3, minmax(0, 1fr));
                gap: 8px;
            }

            #${SECTION_ID} .nushud-language-option {
                position: relative;
            }

            #${SECTION_ID} .nushud-language-option input {
                position: absolute;
                opacity: 0;
                pointer-events: none;
            }

            #${SECTION_ID} .nushud-language-label {
                display: flex;
                align-items: center;
                justify-content: space-between;
                min-height: 42px;
                padding: 0 11px;
                border-radius: 12px;
                border: 1px solid rgba(255,255,255,.07);
                background: rgba(255,255,255,.025);
                color: #71717a;
                cursor: pointer;
                font-size: 10px;
                font-weight: 700;
            }

            #${SECTION_ID} .nushud-language-label span:last-child {
                width: 16px;
                height: 16px;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 50%;
                border: 1px solid rgba(255,255,255,.12);
                font-size: 9px;
            }

            #${SECTION_ID} .nushud-language-option input:checked + label {
                border-color: rgba(245,158,11,.28);
                background: rgba(245,158,11,.08);
                color: #fbbf24;
            }

            #${SECTION_ID} .nushud-language-option input:checked + label span:last-child {
                background: #f59e0b;
                border-color: #f59e0b;
                color: #18181b;
            }

            #${SECTION_ID} .nushud-upload-submit {
                width: 100%;
                border: 1px solid transparent;
                border-radius: 13px;
                padding: 12px 14px;
                background: #f59e0b;
                color: #18181b;
                font-size: 11px;
                font-weight: 800;
                cursor: pointer;
                margin-top: 3px;
            }

            #${SECTION_ID} .nushud-upload-submit:hover {
                background: #fbbf24;
            }

            #${SECTION_ID} .nushud-upload-submit:disabled {
                opacity: .5;
                cursor: not-allowed;
            }

            #${SECTION_ID} .nushud-upload-status {
                min-height: 18px;
                margin-top: 11px;
                text-align: center;
                font-size: 10px;
                line-height: 1.5;
            }

            #${SECTION_ID} .nushud-upload-status.info {
                color: #71717a;
            }

            #${SECTION_ID} .nushud-upload-status.success {
                color: #fbbf24;
            }

            #${SECTION_ID} .nushud-upload-status.error {
                color: #f87171;
            }

            #${SECTION_ID} .nushud-upload-login {
                padding: 26px 20px;
                text-align: center;
            }

            #${SECTION_ID} .nushud-upload-login-icon {
                width: 44px;
                height: 44px;
                margin: 0 auto 13px;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 14px;
                background: rgba(245,158,11,.09);
                border: 1px solid rgba(245,158,11,.16);
                color: #fbbf24;
                font-size: 18px;
            }

            #${SECTION_ID} .nushud-upload-login-title {
                color: #f4f4f5;
                font-size: 13px;
                font-weight: 800;
            }

            #${SECTION_ID} .nushud-upload-login-text {
                margin-top: 6px;
                color: #71717a;
                font-size: 10px;
                line-height: 1.5;
            }

            #${SECTION_ID} .nushud-upload-login-button {
                margin-top: 16px;
                border: 1px solid rgba(245,158,11,.22);
                border-radius: 12px;
                padding: 10px 14px;
                background: rgba(245,158,11,.08);
                color: #fbbf24;
                font-size: 10px;
                font-weight: 800;
                cursor: pointer;
            }

            #${SECTION_ID} .nushud-upload-today {
                margin-bottom: 14px;
                padding: 12px 13px;
                border-radius: 13px;
                background: rgba(245,158,11,.06);
                border: 1px solid rgba(245,158,11,.12);
                color: #a1a1aa;
                font-size: 10px;
                line-height: 1.5;
            }

            #${SECTION_ID} .nushud-upload-today strong {
                color: #fbbf24;
            }

            #${SECTION_ID} .nushud-my-title {
                margin-top: 24px;
                margin-bottom: 10px;
                color: #a1a1aa;
                font-size: 10px;
                font-weight: 800;
                text-transform: uppercase;
                letter-spacing: .08em;
            }

            #${SECTION_ID} .nushud-my-list {
                display: flex;
                flex-direction: column;
                gap: 8px;
            }

            #${SECTION_ID} .nushud-my-item {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                padding: 11px 12px;
                border-radius: 13px;
                background: rgba(255,255,255,.025);
                border: 1px solid rgba(255,255,255,.05);
            }

            #${SECTION_ID} .nushud-my-item-info {
                min-width: 0;
                flex: 1;
            }

            #${SECTION_ID} .nushud-my-item-title {
                color: #e4e4e7;
                font-size: 10px;
                font-weight: 800;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            #${SECTION_ID} .nushud-my-item-date {
                margin-top: 3px;
                color: #52525b;
                font-size: 8px;
            }

            #${SECTION_ID} .nushud-status {
                flex-shrink: 0;
                padding: 5px 8px;
                border-radius: 8px;
                font-size: 8px;
                font-weight: 800;
                text-transform: uppercase;
                letter-spacing: .04em;
            }

            #${SECTION_ID} .nushud-status.ready {
                color: #fbbf24;
                background: rgba(245,158,11,.08);
                border: 1px solid rgba(245,158,11,.15);
            }

            #${SECTION_ID} .nushud-status.processing {
                color: #a1a1aa;
                background: rgba(255,255,255,.04);
                border: 1px solid rgba(255,255,255,.06);
            }

            #${SECTION_ID} .nushud-status.error {
                color: #f87171;
                background: rgba(239,68,68,.07);
                border: 1px solid rgba(239,68,68,.12);
            }

            @media (max-width: 767px) {

                #${SECTION_ID} .nushud-upload-header {
                    display: block;
                }

                #${SECTION_ID} .nushud-upload-pill {
                    display: inline-block;
                    margin-top: 10px;
                }

                #${SECTION_ID} .nushud-language-grid {
                    grid-template-columns: 1fr;
                }

            }
        `;

        document.head.appendChild(
            style
        );

    }


    function openLogin() {

        if (
            window.NushudAuth &&
            typeof window.NushudAuth.open ===
                "function"
        ) {

            window.NushudAuth.open(
                "login"
            );

        }

    }


    /* =====================================================
       CREAR INTERFAZ
       ===================================================== */

    function renderBase() {

        const section =
            document.getElementById(
                SECTION_ID
            );

        if (!section) {
            return;
        }

        section.innerHTML = `
            <div class="nushud-upload-shell">

                <div class="nushud-upload-header">

                    <div>

                        <h2 class="nushud-upload-title">
                            Subir nasheed
                        </h2>

                        <p class="nushud-upload-subtitle">
                            Tu espacio privado para subir y generar subtítulos automáticamente.
                        </p>

                    </div>

                    <div class="nushud-upload-pill">
                        1 por día
                    </div>

                </div>

                <div id="nushud-upload-content"></div>

            </div>
        `;

    }


    /* =====================================================
       LOGIN UI
       ===================================================== */

    function renderLoggedOut() {

        const content =
            document.getElementById(
                "nushud-upload-content"
            );

        if (!content) {
            return;
        }

        content.innerHTML = `
            <div class="nushud-upload-card">

                <div class="nushud-upload-login">

                    <div class="nushud-upload-login-icon">
                        ◉
                    </div>

                    <div class="nushud-upload-login-title">
                        Inicia sesión para subir
                    </div>

                    <div class="nushud-upload-login-text">
                        Tus nasheeds subidos son privados y solo tú puedes escucharlos.
                    </div>

                    <button
                        type="button"
                        class="nushud-upload-login-button"
                        id="nushud-upload-login-button">

                        Iniciar sesión

                    </button>

                </div>

            </div>
        `;

        document
            .getElementById(
                "nushud-upload-login-button"
            )
            ?.addEventListener(
                "click",
                openLogin
            );

    }


    /* =====================================================
       RENDER FORM
       ===================================================== */

    function renderForm(
        existingToday
    ) {

        const content =
            document.getElementById(
                "nushud-upload-content"
            );

        if (!content) {
            return;
        }

        const hasTodayUpload =
            Boolean(
                existingToday
            );

        let todayMessage =
            "";

        if (
            hasTodayUpload
        ) {

            todayMessage = `
                <div class="nushud-upload-today">
                    Ya has utilizado tu subida de hoy con
                    <strong>${escapeHtml(
                        existingToday.title ||
                        "tu nasheed"
                    )}</strong>.
                    Podrás volver a subir mañana.
                </div>
            `;

        }

        content.innerHTML = `
            ${
                hasTodayUpload
                    ? todayMessage
                    : ""
            }

            <div class="nushud-upload-card">

                ${
                    hasTodayUpload
                        ? ""
                        : `
                            <form
                                id="nushud-upload-form"
                                autocomplete="off">

                                <div class="nushud-upload-field">

                                    <label
                                        class="nushud-upload-label"
                                        for="nushud-upload-title">

                                        Título

                                    </label>

                                    <input
                                        id="nushud-upload-title"
                                        class="nushud-upload-input"
                                        type="text"
                                        maxlength="120"
                                        placeholder="Nombre del nasheed"
                                        required>

                                </div>


                                <div class="nushud-upload-field">

                                    <label
                                        class="nushud-upload-label"
                                        for="nushud-upload-audio">

                                        Audio

                                    </label>

                                    <input
                                        id="nushud-upload-audio"
                                        class="nushud-upload-file"
                                        type="file"
                                        accept="audio/*,video/mp4,video/webm"
                                        required>

                                    <div class="nushud-upload-help">
                                        MP3, M4A, OGG, WAV, WebM, FLAC o MP4. Máximo 25 MB.
                                    </div>

                                </div>


                                <div class="nushud-upload-field">

                                    <label
                                        class="nushud-upload-label"
                                        for="nushud-upload-cover">

                                        Portada

                                    </label>

                                    <input
                                        id="nushud-upload-cover"
                                        class="nushud-upload-file"
                                        type="file"
                                        accept="image/jpeg,image/png,image/webp">

                                    <div class="nushud-upload-help">
                                        JPG, PNG o WebP. Opcional. Máximo 5 MB.
                                    </div>

                                </div>


                                <div class="nushud-upload-field">

                                    <label class="nushud-upload-label">
                                        Traducciones
                                    </label>

                                    <div class="nushud-upload-help"
                                         style="margin-bottom:8px">

                                        El árabe se genera siempre. Selecciona los idiomas adicionales.

                                    </div>

                                    <div class="nushud-language-grid">

                                        <div class="nushud-language-option">

                                            <input
                                                id="nushud-lang-es"
                                                type="checkbox"
                                                value="es">

                                            <label
                                                for="nushud-lang-es"
                                                class="nushud-language-label">

                                                <span>Español</span>
                                                <span>✓</span>

                                            </label>

                                        </div>


                                        <div class="nushud-language-option">

                                            <input
                                                id="nushud-lang-en"
                                                type="checkbox"
                                                value="en">

                                            <label
                                                for="nushud-lang-en"
                                                class="nushud-language-label">

                                                <span>English</span>
                                                <span>✓</span>

                                            </label>

                                        </div>


                                        <div class="nushud-language-option">

                                            <input
                                                id="nushud-lang-ru"
                                                type="checkbox"
                                                value="ru">

                                            <label
                                                for="nushud-lang-ru"
                                                class="nushud-language-label">

                                                <span>Русский</span>
                                                <span>✓</span>

                                            </label>

                                        </div>

                                    </div>

                                </div>


                                <button
                                    id="nushud-upload-submit"
                                    class="nushud-upload-submit"
                                    type="submit">

                                    Subir nasheed

                                </button>

                                <div
                                    id="nushud-upload-status"
                                    class="nushud-upload-status info">

                                </div>

                            </form>
                        `
                }

            </div>

            <div
                id="nushud-my-nasheeds"
                class="nushud-upload-card"
                style="margin-top:14px">

            </div>
        `;

        if (!hasTodayUpload) {

            document
                .getElementById(
                    "nushud-upload-form"
                )
                ?.addEventListener(
                    "submit",
                    handleSubmit
                );

        }

        renderMyNasheeds();

    }


    /* =====================================================
       LISTA
       ===================================================== */

    function getStatusLabel(
        status
    ) {

        if (
            status ===
            "ready"
        ) {
            return "Disponible";
        }

        if (
            status ===
            "processing"
        ) {
            return "Procesando";
        }

        if (
            status ===
            "error"
        ) {
            return "Error";
        }

        return (
            status ||
            "Desconocido"
        );

    }


    function renderMyNasheeds() {

        const container =
            document.getElementById(
                "nushud-my-nasheeds"
            );

        if (!container) {
            return;
        }

        if (!userNasheeds.length) {

            container.innerHTML = `
                <div class="nushud-my-title"
                     style="margin-top:0">

                    Mis nasheeds

                </div>

                <div
                    style="
                        color:#52525b;
                        font-size:10px;
                        padding:3px 0 2px;
                    ">

                    Todavía no has subido ningún nasheed.

                </div>
            `;

            return;

        }

        const items =
            userNasheeds
                .map(
                    item => {

                        const status =
                            String(
                                item.status ||
                                ""
                            );

                        const statusClass =
                            status ===
                                "ready"

                                ? "ready"

                                : status ===
                                    "error"

                                    ? "error"

                                    : "processing";

                        return `
                            <div class="nushud-my-item">

                                <div class="nushud-my-item-info">

                                    <div class="nushud-my-item-title">

                                        ${escapeHtml(
                                            item.title ||
                                            "Nasheed"
                                        )}

                                    </div>

                                    <div class="nushud-my-item-date">

                                        ${formatDate(
                                            item.created_at
                                        )}

                                    </div>

                                    ${
                                        item.error
                                            ? `
                                                <div style="
                                                    margin-top:4px;
                                                    color:#f87171;
                                                    font-size:8px;
                                                    line-height:1.4;
                                                ">
                                                    ${escapeHtml(
                                                        item.error
                                                    )}
                                                </div>
                                            `
                                            : ""
                                    }

                                </div>

                                <div
                                    class="nushud-status ${statusClass}">

                                    ${escapeHtml(
                                        getStatusLabel(
                                            status
                                        )
                                    )}

                                </div>

                            </div>
                        `;

                    }
                )
                .join("");

        container.innerHTML = `
            <div class="nushud-my-title"
                 style="margin-top:0">

                Mis nasheeds

            </div>

            <div class="nushud-my-list">

                ${items}

            </div>
        `;

    }


    /* =====================================================
       CARGAR NASHEEDS
       ===================================================== */

    async function loadUserNasheeds() {

        const token =
            await getAccessToken();

        if (!token) {

            userNasheeds =
                [];

            return [];

        }

        const response =
            await fetch(
                "/api/user-nasheeds",
                {
                    method:
                        "GET",

                    cache:
                        "no-store",

                    credentials:
                        "same-origin",

                    headers: {
                        Accept:
                            "application/json",

                        Authorization:
                            `Bearer ${token}`
                    }
                }
            );

        const contentType =
            response.headers.get(
                "content-type"
            ) ||
            "";

        if (
            !contentType.includes(
                "application/json"
            )
        ) {

            const raw =
                await response.text();

            throw new Error(
                `El servidor no devolvió JSON. HTTP ${response.status}: ${raw.slice(0, 120)}`
            );

        }

        const data =
            await response.json();

        if (!response.ok) {

            throw new Error(
                data?.error ||
                "No se pudieron cargar tus nasheeds."
            );

        }

        userNasheeds =
            Array.isArray(
                data?.nasheeds
            )
                ? data.nasheeds
                : [];

        return userNasheeds;

    }


    /* =====================================================
       DETERMINAR SI HAY SUBIDA HOY
       ===================================================== */

    function getTodayUpload() {

        const today =
            todayISO();

        return (
            userNasheeds.find(
                item =>
                    String(
                        item.upload_day ||
                        ""
                    ) === today
            ) ||
            null
        );

    }


    /* =====================================================
       RENDER
       ===================================================== */

    async function render() {

        ensureStyles();

        renderBase();

        const user =
            await refreshAuth();

        if (!user) {

            renderLoggedOut();

            return;

        }

        try {

            await loadUserNasheeds();

        } catch (error) {

            console.error(
                "[NUSHUD UPLOAD LIST]",
                error
            );

            userNasheeds =
                [];

            const content =
                document.getElementById(
                    "nushud-upload-content"
                );

            if (content) {

                content.innerHTML = `
                    <div class="nushud-upload-card">

                        <div
                            style="
                                color:#f87171;
                                text-align:center;
                                font-size:10px;
                                padding:12px;
                            ">

                            No se pudieron cargar tus datos de subida.

                        </div>

                    </div>
                `;

            }

            return;

        }

        const todayUpload =
            getTodayUpload();

        /*
         * ESTA ES LA PARTE IMPORTANTE:
         *
         * Si el usuario tiene una subida de ayer
         * pero NO de hoy, se muestra el formulario.
         *
         * Solo se oculta cuando upload_day === hoy.
         */

        renderForm(
            todayUpload
        );

    }


    /* =====================================================
       SUBIDA
       ===================================================== */

    async function handleSubmit(
        event
    ) {

        event.preventDefault();

        if (busy) {
            return;
        }

        const user =
            await refreshAuth();

        if (!user) {

            setStatus(
                "Debes iniciar sesión.",
                "error"
            );

            openLogin();

            return;

        }

        /*
         * Comprobar otra vez contra el servidor
         * antes de subir.
         */

        try {

            await loadUserNasheeds();

            const todayUpload =
                getTodayUpload();

            if (todayUpload) {

                renderForm(
                    todayUpload
                );

                setStatus(
                    "Ya tienes una subida para hoy.",
                    "error"
                );

                return;

            }

        } catch (error) {

            console.error(
                error
            );

        }

        const titleInput =
            document.getElementById(
                "nushud-upload-title"
            );

        const audioInput =
            document.getElementById(
                "nushud-upload-audio"
            );

        const coverInput =
            document.getElementById(
                "nushud-upload-cover"
            );

        const title =
            String(
                titleInput?.value ||
                ""
            ).trim();

        const audioFile =
            audioInput?.files?.[0] ||
            null;

        const coverFile =
            coverInput?.files?.[0] ||
            null;

        if (
            !title
        ) {

            setStatus(
                "Escribe el título del nasheed.",
                "error"
            );

            titleInput?.focus();

            return;

        }

        if (
            title.length >
            120
        ) {

            setStatus(
                "El título es demasiado largo.",
                "error"
            );

            return;

        }

        if (
            !audioFile
        ) {

            setStatus(
                "Selecciona el audio.",
                "error"
            );

            return;

        }

        if (
            !isValidAudio(
                audioFile
            )
        ) {

            setStatus(
                "El audio no es compatible o supera los 25 MB.",
                "error"
            );

            return;

        }

        if (
            coverFile &&
            !isValidCover(
                coverFile
            )
        ) {

            setStatus(
                "La portada no es válida o supera los 5 MB.",
                "error"
            );

            return;

        }

        const translations = [];

        if (
            document.getElementById(
                "nushud-lang-es"
            )?.checked
        ) {

            translations.push(
                "es"
            );

        }

        if (
            document.getElementById(
                "nushud-lang-en"
            )?.checked
        ) {

            translations.push(
                "en"
            );

        }

        if (
            document.getElementById(
                "nushud-lang-ru"
            )?.checked
        ) {

            translations.push(
                "ru"
            );

        }

        setBusy(
            true
        );

        try {

            setStatus(
                `Preparando archivos... (${formatBytes(
                    audioFile.size
                )})`,
                "info"
            );

            const token =
                await getAccessToken();

            if (!token) {

                throw new Error(
                    "La sesión ha caducado. Inicia sesión de nuevo."
                );

            }

            /*
             * PREPARE
             */

            const prepareResponse =
                await fetch(
                    "/api/user-nasheeds/prepare",
                    {
                        method:
                            "POST",

                        credentials:
                            "same-origin",

                        headers: {

                            "Content-Type":
                                "application/json",

                            Accept:
                                "application/json",

                            Authorization:
                                `Bearer ${token}`

                        },

                        body:
                            JSON.stringify({

                                title,

                                audio: {

                                    name:
                                        audioFile.name,

                                    size:
                                        audioFile.size,

                                    type:
                                        audioFile.type

                                },

                                cover:
                                    coverFile

                                        ? {

                                            name:
                                                coverFile.name,

                                            size:
                                                coverFile.size,

                                            type:
                                                coverFile.type

                                        }

                                        : null,

                                translations

                            })
                    }
                );

            const prepareType =
                prepareResponse.headers.get(
                    "content-type"
                ) ||
                "";

            if (
                !prepareType.includes(
                    "application/json"
                )
            ) {

                const raw =
                    await prepareResponse.text();

                throw new Error(
                    `El servidor devolvió una respuesta inesperada (HTTP ${prepareResponse.status}). ${raw.slice(0, 150)}`
                );

            }

            const prepare =
                await prepareResponse.json();

            if (
                !prepareResponse.ok
            ) {

                throw new Error(
                    prepare?.error ||
                    "No se pudo preparar la subida."
                );

            }

            /*
             * SUBIR AUDIO
             */

            setStatus(
                "Subiendo audio...",
                "info"
            );

            const client =
                await getSupabaseClient();

            const audioUpload =
                await client
                    .storage
                    .from(
                        "UserNasheeds"
                    )
                    .uploadToSignedUrl(
                        prepare.audio.path,
                        prepare.audio.token,
                        audioFile,
                        {
                            contentType:
                                audioFile.type ||
                                "application/octet-stream"
                        }
                    );

            if (
                audioUpload.error
            ) {

                throw audioUpload.error;

            }


            /*
             * SUBIR PORTADA
             */

            if (
                coverFile &&
                prepare.cover
            ) {

                setStatus(
                    "Subiendo portada...",
                    "info"
                );

                const coverUpload =
                    await client
                        .storage
                        .from(
                            "UserNasheeds"
                        )
                        .uploadToSignedUrl(
                            prepare.cover.path,
                            prepare.cover.token,
                            coverFile,
                            {
                                contentType:
                                    coverFile.type ||
                                    "image/jpeg"
                            }
                        );

                if (
                    coverUpload.error
                ) {

                    throw coverUpload.error;

                }

            }


            /*
             * PROCESAMIENTO IA
             */

            setStatus(
                "Audio subido. Generando subtítulos con IA...",
                "info"
            );

            const processResponse =
                await fetch(
                    `/api/user-nasheeds/${prepare.id}/process`,
                    {
                        method:
                            "POST",

                        credentials:
                            "same-origin",

                        headers: {

                            Accept:
                                "application/json",

                            Authorization:
                                `Bearer ${token}`

                        }
                    }
                );

            const processType =
                processResponse.headers.get(
                    "content-type"
                ) ||
                "";

            if (
                !processType.includes(
                    "application/json"
                )
            ) {

                const raw =
                    await processResponse.text();

                throw new Error(
                    `El servidor devolvió una respuesta inesperada durante el procesamiento. ${raw.slice(0, 150)}`
                );

            }

            const process =
                await processResponse.json();

            if (
                !processResponse.ok
            ) {

                throw new Error(
                    process?.error ||
                    "No se pudo procesar el nasheed."
                );

            }

            /*
             * TODO CORRECTO
             */

            setStatus(
                "Nasheed listo. Tus subtítulos ya están disponibles.",
                "success"
            );

            /*
             * Recargar datos y formulario.
             */

            await loadUserNasheeds();

            const todayUpload =
                getTodayUpload();

            renderForm(
                todayUpload
            );

            /*
             * Actualizar la biblioteca principal.
             */

            if (
                typeof window.fetchNasheeds ===
                    "function"
            ) {

                try {

                    await window.fetchNasheeds();

                } catch (
                    error
                ) {

                    console.error(
                        "[NUSHUD UPLOAD] Error actualizando biblioteca:",
                        error
                    );

                }

            }

        } catch (error) {

            console.error(
                "[NUSHUD UPLOAD]",
                error
            );

            setBusy(
                false
            );

            setStatus(
                error?.message ||
                "No se pudo completar la subida.",
                "error"
            );

            /*
             * Volver a cargar el estado.
             * Si el backend dejó el registro en error,
             * el formulario volverá a estar disponible.
             */

            try {

                await loadUserNasheeds();

                renderForm(
                    getTodayUpload()
                );

            } catch {}

            return;
        }

        setBusy(
            false
        );

    }


    /* =====================================================
       AUTH EVENTS
       ===================================================== */

    function listenAuth() {

        getSupabaseClient()
            .then(
                client => {

                    client.auth.onAuthStateChange(
                        async (
                            event,
                            session
                        ) => {

                            currentSession =
                                session ||
                                null;

                            currentUser =
                                session?.user ||
                                null;

                            /*
                             * Cuando entra o sale el usuario,
                             * reconstruimos la sección.
                             */

                            if (
                                event ===
                                    "SIGNED_IN" ||
                                event ===
                                    "SIGNED_OUT" ||
                                event ===
                                    "TOKEN_REFRESHED"
                            ) {

                                await render();

                            }

                        }
                    );

                }
            )
            .catch(
                error => {

                    console.error(
                        "[NUSHUD UPLOAD AUTH LISTENER]",
                        error
                    );

                }
            );

    }


    /* =====================================================
       PUBLIC API
       ===================================================== */

    window.NushudUserUpload = {

        refresh:
            render,

        reload:
            render,

        getUser:
            () =>
                currentUser

    };


    /* =====================================================
       INIT
       ===================================================== */

    async function init() {

        if (initialized) {
            return;
        }

        initialized =
            true;

        ensureStyles();

        listenAuth();

        /*
         * Esperar un poco a auth.js para que
         * haya terminado de restaurar la sesión.
         */

        setTimeout(
            () => {

                render();

            },
            250
        );

    }


    if (
        document.readyState ===
        "loading"
    ) {

        document.addEventListener(
            "DOMContentLoaded",
            init,
            {
                once:
                    true
            }
        );

    } else {

        init();

    }

})();