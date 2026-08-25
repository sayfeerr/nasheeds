"use strict";

/*
 * =========================================================
 * NUSHUD AUTH
 * Supabase Authentication
 * =========================================================
 */

(() => {

    let supabaseClient = null;
    let currentUser = null;

    const AUTH_STYLE_ID = "nushud-auth-style";
    const AUTH_ROOT_ID = "nushud-auth-root";
    const ACCOUNT_ID = "nushud-account";

    /*
     * ---------------------------------------------------------
     * CONFIGURACIÓN
     * ---------------------------------------------------------
     */

    async function createSupabaseClient() {

        if (supabaseClient) {
            return supabaseClient;
        }

        const response = await fetch(
            "/api/public-config",
            {
                method: "GET",
                cache: "no-store",
                credentials: "same-origin",
                headers: {
                    "Accept": "application/json"
                }
            }
        );

        if (!response.ok) {
            throw new Error(
                "No se pudo obtener la configuración de Supabase."
            );
        }

        const config = await response.json();

        if (
            !config.supabaseUrl ||
            !config.supabasePublishableKey
        ) {
            throw new Error(
                "La configuración pública de Supabase está incompleta."
            );
        }

        if (
            !window.supabase ||
            typeof window.supabase.createClient !== "function"
        ) {
            throw new Error(
                "La librería de Supabase no está disponible."
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
                        detectSessionInUrl: true,
                        flowType: "pkce"
                    }
                }
            );

        return supabaseClient;
    }


    /*
     * ---------------------------------------------------------
     * ESTILOS
     * ---------------------------------------------------------
     */

    function injectStyles() {

        if (
            document.getElementById(
                AUTH_STYLE_ID
            )
        ) {
            return;
        }

        const style =
            document.createElement("style");

        style.id =
            AUTH_STYLE_ID;

        style.textContent = `

            #${AUTH_ROOT_ID} {
                position: fixed;
                inset: 0;
                z-index: 10000;
                display: none;
                align-items: center;
                justify-content: center;
                padding: 18px;
                background: rgba(0,0,0,.58);
                backdrop-filter: blur(12px);
                -webkit-backdrop-filter: blur(12px);
            }

            #${AUTH_ROOT_ID}.open {
                display: flex;
            }

            .nushud-auth-card {
                width: min(430px, 100%);
                max-height: min(720px, calc(100vh - 36px));
                overflow-y: auto;
                padding: 26px;
                border-radius: 28px;
                background:
                    linear-gradient(
                        145deg,
                        rgba(24,24,30,.96),
                        rgba(10,10,13,.96)
                    );
                border: 1px solid rgba(245,158,11,.20);
                box-shadow:
                    0 30px 90px rgba(0,0,0,.65),
                    inset 0 1px 0 rgba(255,255,255,.05);
            }

            .nushud-auth-close {
                width: 34px;
                height: 34px;
                border-radius: 11px;
                display: flex;
                align-items: center;
                justify-content: center;
                background: rgba(255,255,255,.04);
                border: 1px solid rgba(255,255,255,.08);
                color: #a1a1aa;
                cursor: pointer;
                font-size: 16px;
            }

            .nushud-auth-close:hover {
                color: #fff;
                background: rgba(255,255,255,.07);
            }

            .nushud-auth-mark {
                width: 50px;
                height: 50px;
                border-radius: 17px;
                display: flex;
                align-items: center;
                justify-content: center;
                margin-bottom: 15px;
                background:
                    linear-gradient(
                        135deg,
                        #fbbf24,
                        #f59e0b,
                        #b45309
                    );
                color: #18181b;
                font-weight: 900;
                box-shadow:
                    0 10px 30px rgba(245,158,11,.18);
            }

            .nushud-auth-title {
                font-size: 19px;
                font-weight: 800;
                color: #f4f4f5;
            }

            .nushud-auth-description {
                margin-top: 5px;
                color: #71717a;
                font-size: 11px;
                line-height: 1.5;
            }

            .nushud-auth-label {
                display: block;
                margin-bottom: 7px;
                color: #a1a1aa;
                font-size: 10px;
                font-weight: 700;
            }

            .nushud-auth-input {
                width: 100%;
                padding: 12px 13px;
                border-radius: 13px;
                background: rgba(6,6,8,.85);
                border: 1px solid rgba(255,255,255,.09);
                color: #f4f4f5;
                outline: none;
                font-size: 12px;
            }

            .nushud-auth-input:focus {
                border-color: rgba(245,158,11,.55);
                box-shadow:
                    0 0 0 3px rgba(245,158,11,.08);
            }

            .nushud-auth-input::placeholder {
                color: #52525b;
            }

            .nushud-auth-field {
                margin-top: 14px;
            }

            .nushud-auth-button {
                width: 100%;
                margin-top: 17px;
                padding: 12px 14px;
                border-radius: 13px;
                border: 1px solid transparent;
                background: #f59e0b;
                color: #18181b;
                font-size: 11px;
                font-weight: 800;
                cursor: pointer;
            }

            .nushud-auth-button:hover {
                background: #fbbf24;
            }

            .nushud-auth-button:disabled {
                opacity: .55;
                cursor: not-allowed;
            }

            .nushud-auth-secondary {
                width: 100%;
                margin-top: 9px;
                padding: 10px 14px;
                border-radius: 13px;
                border: 1px solid rgba(255,255,255,.08);
                background: rgba(255,255,255,.035);
                color: #a1a1aa;
                font-size: 10px;
                font-weight: 700;
                cursor: pointer;
            }

            .nushud-auth-secondary:hover {
                background: rgba(255,255,255,.06);
                color: #f4f4f5;
            }

            .nushud-auth-message {
                min-height: 17px;
                margin-top: 12px;
                font-size: 10px;
                line-height: 1.5;
                text-align: center;
            }

            .nushud-auth-message.error {
                color: #f87171;
            }

            .nushud-auth-message.success {
                color: #fbbf24;
            }

            .nushud-auth-switch {
                margin-top: 16px;
                text-align: center;
                font-size: 10px;
                color: #71717a;
            }

            .nushud-auth-switch button {
                border: 0;
                padding: 0;
                margin-left: 4px;
                background: transparent;
                color: #fbbf24;
                font-weight: 800;
                cursor: pointer;
            }

            .nushud-auth-password-info {
                margin-top: 6px;
                color: #52525b;
                font-size: 9px;
                line-height: 1.4;
            }

            .nushud-account-button {
                width: 100%;
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 9px 8px;
                border-radius: 14px;
                border: 1px solid transparent;
                background: transparent;
                color: #a1a1aa;
                text-align: left;
                cursor: pointer;
            }

            .nushud-account-button:hover {
                background: rgba(255,255,255,.04);
                border-color: rgba(255,255,255,.06);
            }

            .nushud-account-avatar {
                width: 32px;
                height: 32px;
                min-width: 32px;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                background: rgba(245,158,11,.10);
                border: 1px solid rgba(245,158,11,.20);
                color: #fbbf24;
                font-size: 11px;
                font-weight: 900;
            }

            .nushud-account-info {
                min-width: 0;
                flex: 1;
            }

            .nushud-account-name {
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                color: #e4e4e7;
                font-size: 10px;
                font-weight: 800;
            }

            .nushud-account-status {
                margin-top: 3px;
                color: #71717a;
                font-size: 9px;
            }

            .nushud-account-arrow {
                color: #52525b;
                font-size: 12px;
            }

            .nushud-account-menu {
                position: fixed;
                z-index: 10001;
                display: none;
                width: 220px;
                padding: 9px;
                border-radius: 17px;
                background: rgba(14,14,18,.97);
                border: 1px solid rgba(255,255,255,.08);
                backdrop-filter: blur(18px);
                box-shadow: 0 25px 60px rgba(0,0,0,.55);
            }

            .nushud-account-menu.open {
                display: block;
            }

            .nushud-account-menu-email {
                padding: 8px;
                color: #71717a;
                font-size: 9px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            .nushud-account-menu-button {
                width: 100%;
                padding: 9px 10px;
                border: 0;
                border-radius: 10px;
                background: transparent;
                color: #a1a1aa;
                text-align: left;
                font-size: 10px;
                font-weight: 700;
                cursor: pointer;
            }

            .nushud-account-menu-button:hover {
                background: rgba(255,255,255,.05);
                color: #f4f4f5;
            }

            .nushud-account-menu-button.danger:hover {
                color: #f87171;
                background: rgba(239,68,68,.07);
            }

            @media (max-width: 767px) {

                .nushud-auth-card {
                    padding: 22px;
                    border-radius: 24px;
                }

            }

        `;

        document.head.appendChild(style);
    }


    /*
     * ---------------------------------------------------------
     * MODAL
     * ---------------------------------------------------------
     */

    function createAuthModal() {

        if (
            document.getElementById(
                AUTH_ROOT_ID
            )
        ) {
            return;
        }

        const root =
            document.createElement("div");

        root.id =
            AUTH_ROOT_ID;

        root.innerHTML = `
            <div
                class="nushud-auth-card"
                role="dialog"
                aria-modal="true"
                aria-labelledby="nushud-auth-title">

                <div
                    style="
                        display:flex;
                        justify-content:flex-end;
                        margin-bottom:8px;
                    ">

                    <button
                        type="button"
                        class="nushud-auth-close"
                        id="nushud-auth-close"
                        aria-label="Cerrar">
                        ×
                    </button>

                </div>

                <div
                    class="nushud-auth-mark">
                    N
                </div>

                <div
                    class="nushud-auth-title"
                    id="nushud-auth-title">
                    Iniciar sesión
                </div>

                <div
                    class="nushud-auth-description"
                    id="nushud-auth-description">
                    Accede a tu cuenta de Nushud.
                </div>

                <form
                    id="nushud-auth-form"
                    autocomplete="on">

                    <div
                        class="nushud-auth-field">

                        <label
                            class="nushud-auth-label"
                            for="nushud-auth-email">
                            Correo electrónico
                        </label>

                        <input
                            id="nushud-auth-email"
                            class="nushud-auth-input"
                            type="email"
                            name="email"
                            autocomplete="email"
                            maxlength="254"
                            required
                            placeholder="tu@email.com">

                    </div>

                    <div
                        class="nushud-auth-field">

                        <label
                            class="nushud-auth-label"
                            for="nushud-auth-password">
                            Contraseña
                        </label>

                        <input
                            id="nushud-auth-password"
                            class="nushud-auth-input"
                            type="password"
                            name="password"
                            autocomplete="current-password"
                            minlength="8"
                            maxlength="72"
                            required
                            placeholder="Tu contraseña">

                        <div
                            class="nushud-auth-password-info"
                            id="nushud-auth-password-info">
                            Mínimo 8 caracteres.
                        </div>

                    </div>

                    <button
                        id="nushud-auth-submit"
                        class="nushud-auth-button"
                        type="submit">
                        Iniciar sesión
                    </button>

                </form>

                <button
                    id="nushud-auth-reset"
                    class="nushud-auth-secondary"
                    type="button">
                    He olvidado mi contraseña
                </button>

                <div
                    id="nushud-auth-message"
                    class="nushud-auth-message">
                </div>

                <div
                    class="nushud-auth-switch">

                    <span
                        id="nushud-auth-switch-text">
                        ¿No tienes cuenta?
                    </span>

                    <button
                        id="nushud-auth-switch"
                        type="button">
                        Registrarse
                    </button>

                </div>

            </div>
        `;

        document.body.appendChild(root);

        root.addEventListener(
            "click",
            event => {

                if (
                    event.target === root
                ) {
                    closeAuth();
                }

            }
        );

        document
            .getElementById(
                "nushud-auth-close"
            )
            .addEventListener(
                "click",
                closeAuth
            );

        document
            .getElementById(
                "nushud-auth-switch"
            )
            .addEventListener(
                "click",
                toggleAuthMode
            );

        document
            .getElementById(
                "nushud-auth-reset"
            )
            .addEventListener(
                "click",
                requestPasswordReset
            );

        document
            .getElementById(
                "nushud-auth-form"
            )
            .addEventListener(
                "submit",
                handleAuthSubmit
            );

        document.addEventListener(
            "keydown",
            event => {

                if (
                    event.key === "Escape"
                ) {
                    closeAuth();
                }

            }
        );
    }


    let authMode =
        "login";


    function openAuth(
        mode = "login"
    ) {

        authMode =
            mode === "register"
                ? "register"
                : "login";

        updateAuthModal();

        const root =
            document.getElementById(
                AUTH_ROOT_ID
            );

        if (!root) {
            return;
        }

        root.classList.add(
            "open"
        );

        setTimeout(
            () => {

                const input =
                    document.getElementById(
                        "nushud-auth-email"
                    );

                if (input) {
                    input.focus();
                }

            },
            50
        );
    }


    function closeAuth() {

        const root =
            document.getElementById(
                AUTH_ROOT_ID
            );

        if (root) {
            root.classList.remove(
                "open"
            );
        }

        clearAuthMessage();
    }


    function toggleAuthMode() {

        authMode =
            authMode === "login"
                ? "register"
                : "login";

        updateAuthModal();

        clearAuthMessage();
    }


    function updateAuthModal() {

        const title =
            document.getElementById(
                "nushud-auth-title"
            );

        const description =
            document.getElementById(
                "nushud-auth-description"
            );

        const submit =
            document.getElementById(
                "nushud-auth-submit"
            );

        const switchText =
            document.getElementById(
                "nushud-auth-switch-text"
            );

        const switchButton =
            document.getElementById(
                "nushud-auth-switch"
            );

        const passwordInfo =
            document.getElementById(
                "nushud-auth-password-info"
            );

        const reset =
            document.getElementById(
                "nushud-auth-reset"
            );

        const password =
            document.getElementById(
                "nushud-auth-password"
            );

        if (
            !title ||
            !description ||
            !submit ||
            !switchText ||
            !switchButton
        ) {
            return;
        }

        if (
            authMode === "register"
        ) {

            title.textContent =
                "Crear cuenta";

            description.textContent =
                "Crea tu cuenta segura de Nushud.";

            submit.textContent =
                "Registrarse";

            switchText.textContent =
                "¿Ya tienes cuenta?";

            switchButton.textContent =
                "Iniciar sesión";

            passwordInfo.textContent =
                "Mínimo 8 caracteres, con mayúscula, minúscula y número.";

            if (password) {
                password.autocomplete =
                    "new-password";
            }

            if (reset) {
                reset.style.display =
                    "none";
            }

        } else {

            title.textContent =
                "Iniciar sesión";

            description.textContent =
                "Accede a tu cuenta de Nushud.";

            submit.textContent =
                "Iniciar sesión";

            switchText.textContent =
                "¿No tienes cuenta?";

            switchButton.textContent =
                "Registrarse";

            passwordInfo.textContent =
                "Mínimo 8 caracteres.";

            if (password) {
                password.autocomplete =
                    "current-password";
            }

            if (reset) {
                reset.style.display =
                    "block";
            }
        }
    }


    /*
     * ---------------------------------------------------------
     * VALIDACIÓN
     * ---------------------------------------------------------
     */

    function isValidEmail(
        email
    ) {

        return (
            typeof email === "string" &&
            email.length >= 3 &&
            email.length <= 254 &&
            /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
                email
            )
        );
    }


    function isStrongPassword(
        password
    ) {

        if (
            typeof password !== "string" ||
            password.length < 8 ||
            password.length > 72
        ) {
            return false;
        }

        return (
            /[a-z]/.test(password) &&
            /[A-Z]/.test(password) &&
            /\d/.test(password)
        );
    }


    function translateAuthError(
        error
    ) {

        const message =
            String(
                error?.message ||
                ""
            ).toLowerCase();

        if (
            message.includes(
                "invalid login credentials"
            )
        ) {
            return "Correo o contraseña incorrectos.";
        }

        if (
            message.includes(
                "user already registered"
            )
        ) {
            return "Ese correo ya está registrado.";
        }

        if (
            message.includes(
                "email not confirmed"
            )
        ) {
            return "Debes confirmar tu correo antes de iniciar sesión.";
        }

        if (
            message.includes(
                "password should be at least"
            )
        ) {
            return "La contraseña no cumple los requisitos mínimos.";
        }

        if (
            message.includes(
                "rate limit"
            ) ||
            message.includes(
                "too many requests"
            )
        ) {
            return "Demasiados intentos. Espera unos minutos y vuelve a intentarlo.";
        }

        if (
            message.includes(
                "email address"
            ) &&
            message.includes(
                "invalid"
            )
        ) {
            return "El correo electrónico no es válido.";
        }

        return (
            error?.message ||
            "No se pudo completar la operación."
        );
    }


    function setAuthMessage(
        message,
        type = "error"
    ) {

        const element =
            document.getElementById(
                "nushud-auth-message"
            );

        if (!element) {
            return;
        }

        element.textContent =
            message || "";

        element.className =
            "nushud-auth-message " +
            type;
    }


    function clearAuthMessage() {
        setAuthMessage(
            "",
            "error"
        );
    }


    /*
     * ---------------------------------------------------------
     * LOGIN / REGISTRO
     * ---------------------------------------------------------
     */

    async function handleAuthSubmit(
        event
    ) {

        event.preventDefault();

        clearAuthMessage();

        const emailInput =
            document.getElementById(
                "nushud-auth-email"
            );

        const passwordInput =
            document.getElementById(
                "nushud-auth-password"
            );

        const submit =
            document.getElementById(
                "nushud-auth-submit"
            );

        const email =
            String(
                emailInput?.value ||
                ""
            )
                .trim()
                .toLowerCase();

        const password =
            String(
                passwordInput?.value ||
                ""
            );

        if (
            !isValidEmail(email)
        ) {

            setAuthMessage(
                "Introduce un correo electrónico válido."
            );

            emailInput?.focus();

            return;
        }

        if (
            authMode === "register" &&
            !isStrongPassword(password)
        ) {

            setAuthMessage(
                "La contraseña debe tener al menos 8 caracteres, una mayúscula, una minúscula y un número."
            );

            passwordInput?.focus();

            return;
        }

        if (
            authMode === "login" &&
            (
                password.length < 8 ||
                password.length > 72
            )
        ) {

            setAuthMessage(
                "La contraseña no es válida."
            );

            passwordInput?.focus();

            return;
        }

        if (submit) {
            submit.disabled =
                true;

            submit.textContent =
                authMode === "register"
                    ? "Creando cuenta..."
                    : "Comprobando...";
        }

        try {

            const client =
                await createSupabaseClient();

            if (
                authMode === "register"
            ) {

                const {
                    data,
                    error
                } =
                    await client.auth.signUp({
                        email,
                        password,
                        options: {
                            emailRedirectTo:
                                window.location.origin
                        }
                    });

                if (error) {
                    throw error;
                }

                if (
                    data?.session
                ) {

                    currentUser =
                        data.user ||
                        null;

                    closeAuth();

                    updateAccountUI();

                    setAuthMessage(
                        "",
                        "success"
                    );

                } else {

                    setAuthMessage(
                        "Cuenta creada. Revisa tu correo para confirmar la cuenta.",
                        "success"
                    );

                    if (passwordInput) {
                        passwordInput.value =
                            "";
                    }
                }

            } else {

                const {
                    data,
                    error
                } =
                    await client.auth.signInWithPassword({
                        email,
                        password
                    });

                if (error) {
                    throw error;
                }

                currentUser =
                    data?.user ||
                    null;

                closeAuth();

                updateAccountUI();
            }

        } catch (
            error
        ) {

            console.error(
                "[NUSHUD AUTH]",
                error
            );

            setAuthMessage(
                translateAuthError(
                    error
                )
            );

        } finally {

            if (submit) {

                submit.disabled =
                    false;

                submit.textContent =
                    authMode === "register"
                        ? "Registrarse"
                        : "Iniciar sesión";
            }
        }
    }


    /*
     * ---------------------------------------------------------
     * RECUPERAR CONTRASEÑA
     * ---------------------------------------------------------
     */

    async function requestPasswordReset() {

        clearAuthMessage();

        const emailInput =
            document.getElementById(
                "nushud-auth-email"
            );

        const email =
            String(
                emailInput?.value ||
                ""
            )
                .trim()
                .toLowerCase();

        if (
            !isValidEmail(email)
        ) {

            setAuthMessage(
                "Escribe primero tu correo electrónico."
            );

            emailInput?.focus();

            return;
        }

        try {

            const client =
                await createSupabaseClient();

            const {
                error
            } =
                await client.auth.resetPasswordForEmail(
                    email,
                    {
                        redirectTo:
                            window.location.origin
                    }
                );

            if (error) {
                throw error;
            }

            setAuthMessage(
                "Si existe una cuenta con ese correo, recibirás instrucciones para recuperar la contraseña.",
                "success"
            );

        } catch (
            error
        ) {

            console.error(
                "[NUSHUD AUTH RESET]",
                error
            );

            setAuthMessage(
                translateAuthError(
                    error
                )
            );
        }
    }


    /*
     * ---------------------------------------------------------
     * CUENTA
     * ---------------------------------------------------------
     */

    function findAccountHost() {

        const sidebar =
            document.querySelector(
                "aside"
            );

        if (!sidebar) {
            return null;
        }

        const candidates =
            sidebar.querySelectorAll(
                ":scope > div"
            );

        if (
            candidates.length < 2
        ) {
            return null;
        }

        return candidates[
            candidates.length - 1
        ];
    }


    function createAccountUI() {

        if (
            document.getElementById(
                ACCOUNT_ID
            )
        ) {
            return;
        }

        const host =
            findAccountHost();

        if (!host) {
            return;
        }

        const existing =
            host.querySelector(
                ".pt-4"
            );

        if (
            existing
        ) {
            existing.innerHTML = "";

            existing.id =
                ACCOUNT_ID;

        } else {

            const wrapper =
                document.createElement(
                    "div"
                );

            wrapper.id =
                ACCOUNT_ID;

            wrapper.className =
                "pt-4 border-t border-white/5";

            host.appendChild(
                wrapper
            );
        }

        const wrapper =
            document.getElementById(
                ACCOUNT_ID
            );

        wrapper.innerHTML = `

            <button
                type="button"
                class="nushud-account-button"
                id="nushud-account-button">

                <div
                    class="nushud-account-avatar"
                    id="nushud-account-avatar">
                    N
                </div>

                <div
                    class="nushud-account-info">

                    <div
                        class="nushud-account-name"
                        id="nushud-account-name">
                        Iniciar sesión
                    </div>

                    <div
                        class="nushud-account-status"
                        id="nushud-account-status">
                        Cuenta Nushud
                    </div>

                </div>

                <div
                    class="nushud-account-arrow">
                    ›
                </div>

            </button>
        `;

        document
            .getElementById(
                "nushud-account-button"
            )
            .addEventListener(
                "click",
                handleAccountClick
            );
    }


    function getUserInitial(
        user
    ) {

        const email =
            String(
                user?.email ||
                ""
            );

        return (
            email
                .charAt(0)
                .toUpperCase() ||
            "N"
        );
    }


    function updateAccountUI() {

        createAccountUI();

        const name =
            document.getElementById(
                "nushud-account-name"
            );

        const status =
            document.getElementById(
                "nushud-account-status"
            );

        const avatar =
            document.getElementById(
                "nushud-account-avatar"
            );

        if (
            !name ||
            !status ||
            !avatar
        ) {
            return;
        }

        if (
            currentUser
        ) {

            name.textContent =
                currentUser.email ||
                "Usuario";

            status.textContent =
                "Sesión iniciada";

            avatar.textContent =
                getUserInitial(
                    currentUser
                );

        } else {

            name.textContent =
                "Iniciar sesión";

            status.textContent =
                "Cuenta Nushud";

            avatar.textContent =
                "N";
        }
    }


    let accountMenu =
        null;


    function closeAccountMenu() {

        if (
            accountMenu
        ) {
            accountMenu.classList.remove(
                "open"
            );
        }
    }


    function createAccountMenu() {

        if (
            document.getElementById(
                "nushud-account-menu"
            )
        ) {
            return;
        }

        accountMenu =
            document.createElement(
                "div"
            );

        accountMenu.id =
            "nushud-account-menu";

        accountMenu.className =
            "nushud-account-menu";

        document.body.appendChild(
            accountMenu
        );

        document.addEventListener(
            "click",
            event => {

                if (
                    !accountMenu ||
                    !accountMenu.classList.contains(
                        "open"
                    )
                ) {
                    return;
                }

                const button =
                    document.getElementById(
                        "nushud-account-button"
                    );

                if (
                    event.target !== button &&
                    !button?.contains(
                        event.target
                    ) &&
                    !accountMenu.contains(
                        event.target
                    )
                ) {
                    closeAccountMenu();
                }
            }
        );
    }


    function openAccountMenu() {

        createAccountMenu();

        if (!accountMenu) {
            return;
        }

        if (
            !currentUser
        ) {

            openAuth(
                "login"
            );

            return;
        }

        accountMenu.innerHTML = `

            <div
                class="nushud-account-menu-email">
                ${escapeHtml(
                    currentUser.email ||
                    ""
                )}
            </div>

            <button
                type="button"
                class="nushud-account-menu-button danger"
                id="nushud-auth-logout">
                Cerrar sesión
            </button>
        `;

        const button =
            document.getElementById(
                "nushud-account-button"
            );

        if (!button) {
            return;
        }

        const rect =
            button.getBoundingClientRect();

        const menuWidth =
            220;

        let left =
            rect.left;

        if (
            left + menuWidth >
            window.innerWidth - 10
        ) {
            left =
                window.innerWidth -
                menuWidth -
                10;
        }

        accountMenu.style.left =
            `${Math.max(
                10,
                left
            )}px`;

        accountMenu.style.bottom =
            `${Math.max(
                10,
                window.innerHeight -
                rect.top +
                8
            )}px`;

        accountMenu.classList.add(
            "open"
        );

        document
            .getElementById(
                "nushud-auth-logout"
            )
            .addEventListener(
                "click",
                logout
            );
    }


    function handleAccountClick() {

        if (
            currentUser
        ) {

            openAccountMenu();

        } else {

            openAuth(
                "login"
            );
        }
    }


    async function logout() {

        closeAccountMenu();

        try {

            const client =
                await createSupabaseClient();

            const {
                error
            } =
                await client.auth.signOut();

            if (error) {
                throw error;
            }

            currentUser =
                null;

            updateAccountUI();

        } catch (
            error
        ) {

            console.error(
                "[NUSHUD AUTH LOGOUT]",
                error
            );

            alert(
                "No se pudo cerrar la sesión."
            );
        }
    }


    /*
     * ---------------------------------------------------------
     * SEGURIDAD / SESIÓN
     * ---------------------------------------------------------
     */

    async function restoreSession() {

        const client =
            await createSupabaseClient();

        const {
            data,
            error
        } =
            await client.auth.getSession();

        if (error) {
            throw error;
        }

        currentUser =
            data?.session?.user ||
            null;

        updateAccountUI();

        client.auth.onAuthStateChange(
            (
                event,
                session
            ) => {

                currentUser =
                    session?.user ||
                    null;

                updateAccountUI();

            }
        );
    }


    /*
     * ---------------------------------------------------------
     * ESCAPE HTML
     * ---------------------------------------------------------
     */

    function escapeHtml(
        value
    ) {

        const div =
            document.createElement(
                "div"
            );

        div.textContent =
            String(
                value ??
                ""
            );

        return div.innerHTML;
    }


    /*
     * ---------------------------------------------------------
     * INICIO
     * ---------------------------------------------------------
     */

    async function init() {

        injectStyles();

        createAuthModal();

        createAccountUI();

        updateAccountUI();

        try {

            await restoreSession();

        } catch (
            error
        ) {

            console.error(
                "[NUSHUD AUTH INIT]",
                error
            );
        }

        window.NushudAuth = {
            open: openAuth,
            logout,
            getUser: () =>
                currentUser
        };
    }


    if (
        document.readyState ===
        "loading"
    ) {

        document.addEventListener(
            "DOMContentLoaded",
            init,
            {
                once: true
            }
        );

    } else {

        init();

    }

})();