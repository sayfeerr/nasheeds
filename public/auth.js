```javascript
"use strict";

(function () {
    var supabaseClient = null;
    var currentUser = null;
    var authMode = "login";

    var AUTH_ROOT_ID = "nushud-auth-root";
    var ACCOUNT_ID = "nushud-account";
    var STYLE_ID = "nushud-auth-style";

    /* =========================================================
       SUPABASE
       ========================================================= */

    async function getSupabaseClient() {
        if (supabaseClient) {
            return supabaseClient;
        }

        var response = await fetch("/api/public-config", {
            method: "GET",
            cache: "no-store",
            credentials: "same-origin"
        });

        if (!response.ok) {
            throw new Error("No se pudo obtener la configuración de Supabase.");
        }

        var config = await response.json();

        if (!config.supabaseUrl || !config.supabasePublishableKey) {
            throw new Error("La configuración de Supabase está incompleta.");
        }

        if (
            !window.supabase ||
            typeof window.supabase.createClient !== "function"
        ) {
            throw new Error("La librería de Supabase no está cargada.");
        }

        supabaseClient = window.supabase.createClient(
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

    /* =========================================================
       ESTILOS
       ========================================================= */

    function addStyles() {
        if (document.getElementById(STYLE_ID)) {
            return;
        }

        var style = document.createElement("style");
        style.id = STYLE_ID;

        style.textContent =
            "#nushud-account {" +
                "position:fixed;" +
                "top:14px;" +
                "left:16px;" +
                "z-index:9990;" +
            "}" +

            ".nushud-account-button {" +
                "display:flex;" +
                "align-items:center;" +
                "gap:9px;" +
                "padding:6px 12px 6px 6px;" +
                "min-height:40px;" +
                "border-radius:14px;" +
                "border:1px solid rgba(255,255,255,.10);" +
                "background:rgba(12,12,15,.90);" +
                "color:#f4f4f5;" +
                "backdrop-filter:blur(18px);" +
                "-webkit-backdrop-filter:blur(18px);" +
                "cursor:pointer;" +
                "box-shadow:0 12px 30px rgba(0,0,0,.25);" +
            "}" +

            ".nushud-account-avatar {" +
                "width:30px;" +
                "height:30px;" +
                "border-radius:50%;" +
                "display:flex;" +
                "align-items:center;" +
                "justify-content:center;" +
                "background:rgba(245,158,11,.14);" +
                "border:1px solid rgba(245,158,11,.25);" +
                "color:#fbbf24;" +
                "font-size:11px;" +
                "font-weight:900;" +
            "}" +

            ".nushud-account-info {" +
                "display:flex;" +
                "flex-direction:column;" +
                "text-align:left;" +
                "max-width:170px;" +
                "min-width:0;" +
            "}" +

            ".nushud-account-name {" +
                "font-size:10px;" +
                "font-weight:800;" +
                "overflow:hidden;" +
                "text-overflow:ellipsis;" +
                "white-space:nowrap;" +
            "}" +

            ".nushud-account-status {" +
                "margin-top:2px;" +
                "font-size:8px;" +
                "color:#71717a;" +
            "}" +

            "#nushud-auth-root {" +
                "position:fixed;" +
                "inset:0;" +
                "z-index:10000;" +
                "display:none;" +
                "align-items:center;" +
                "justify-content:center;" +
                "padding:18px;" +
                "background:rgba(0,0,0,.60);" +
                "backdrop-filter:blur(12px);" +
                "-webkit-backdrop-filter:blur(12px);" +
            "}" +

            "#nushud-auth-root.open {" +
                "display:flex;" +
            "}" +

            ".nushud-auth-card {" +
                "width:min(430px,100%);" +
                "max-height:calc(100vh - 36px);" +
                "overflow:auto;" +
                "padding:26px;" +
                "border-radius:28px;" +
                "background:linear-gradient(145deg,rgba(24,24,30,.98),rgba(10,10,13,.98));" +
                "border:1px solid rgba(245,158,11,.22);" +
                "box-shadow:0 30px 90px rgba(0,0,0,.65);" +
                "box-sizing:border-box;" +
            "}" +

            ".nushud-auth-close {" +
                "width:34px;" +
                "height:34px;" +
                "border-radius:11px;" +
                "border:1px solid rgba(255,255,255,.08);" +
                "background:rgba(255,255,255,.04);" +
                "color:#a1a1aa;" +
                "cursor:pointer;" +
                "font-size:18px;" +
            "}" +

            ".nushud-auth-mark {" +
                "width:50px;" +
                "height:50px;" +
                "border-radius:17px;" +
                "display:flex;" +
                "align-items:center;" +
                "justify-content:center;" +
                "margin-bottom:15px;" +
                "background:linear-gradient(135deg,#fbbf24,#f59e0b,#b45309);" +
                "color:#18181b;" +
                "font-weight:900;" +
                "font-size:20px;" +
            "}" +

            ".nushud-auth-title {" +
                "font-size:19px;" +
                "font-weight:800;" +
                "color:#f4f4f5;" +
            "}" +

            ".nushud-auth-description {" +
                "margin-top:5px;" +
                "font-size:11px;" +
                "color:#71717a;" +
            "}" +

            ".nushud-auth-field {" +
                "margin-top:14px;" +
            "}" +

            ".nushud-auth-label {" +
                "display:block;" +
                "margin-bottom:7px;" +
                "font-size:10px;" +
                "font-weight:700;" +
                "color:#a1a1aa;" +
            "}" +

            ".nushud-auth-input {" +
                "width:100%;" +
                "box-sizing:border-box;" +
                "padding:12px 13px;" +
                "border-radius:13px;" +
                "border:1px solid rgba(255,255,255,.09);" +
                "background:rgba(6,6,8,.85);" +
                "color:#f4f4f5;" +
                "outline:none;" +
                "font-size:12px;" +
            "}" +

            ".nushud-auth-button {" +
                "width:100%;" +
                "margin-top:17px;" +
                "padding:12px;" +
                "border:0;" +
                "border-radius:13px;" +
                "background:#f59e0b;" +
                "color:#18181b;" +
                "font-size:11px;" +
                "font-weight:800;" +
                "cursor:pointer;" +
            "}" +

            ".nushud-auth-button:disabled {" +
                "opacity:.55;" +
                "cursor:not-allowed;" +
            "}" +

            ".nushud-auth-secondary {" +
                "width:100%;" +
                "margin-top:9px;" +
                "padding:10px;" +
                "border-radius:13px;" +
                "border:1px solid rgba(255,255,255,.08);" +
                "background:rgba(255,255,255,.035);" +
                "color:#a1a1aa;" +
                "font-size:10px;" +
                "font-weight:700;" +
                "cursor:pointer;" +
            "}" +

            ".nushud-auth-message {" +
                "min-height:18px;" +
                "margin-top:12px;" +
                "text-align:center;" +
                "font-size:10px;" +
                "line-height:1.5;" +
            "}" +

            ".nushud-auth-message.error {" +
                "color:#f87171;" +
            "}" +

            ".nushud-auth-message.success {" +
                "color:#fbbf24;" +
            "}" +

            ".nushud-auth-switch {" +
                "margin-top:16px;" +
                "text-align:center;" +
                "font-size:10px;" +
                "color:#71717a;" +
            "}" +

            ".nushud-auth-switch button {" +
                "border:0;" +
                "background:transparent;" +
                "color:#fbbf24;" +
                "font-weight:800;" +
                "cursor:pointer;" +
            "}" +

            "#nushud-account-menu {" +
                "position:fixed;" +
                "z-index:10001;" +
                "display:none;" +
                "width:220px;" +
                "padding:9px;" +
                "box-sizing:border-box;" +
                "border-radius:17px;" +
                "background:rgba(14,14,18,.98);" +
                "border:1px solid rgba(255,255,255,.08);" +
                "box-shadow:0 25px 60px rgba(0,0,0,.55);" +
            "}" +

            "#nushud-account-menu.open {" +
                "display:block;" +
            "}" +

            ".nushud-menu-email {" +
                "padding:8px;" +
                "font-size:9px;" +
                "color:#71717a;" +
                "overflow:hidden;" +
                "text-overflow:ellipsis;" +
                "white-space:nowrap;" +
            "}" +

            ".nushud-menu-button {" +
                "width:100%;" +
                "padding:9px 10px;" +
                "border:0;" +
                "border-radius:10px;" +
                "background:transparent;" +
                "color:#a1a1aa;" +
                "text-align:left;" +
                "font-size:10px;" +
                "font-weight:700;" +
                "cursor:pointer;" +
            "}" +

            ".nushud-menu-button:hover {" +
                "background:rgba(255,255,255,.05);" +
                "color:#f4f4f5;" +
            "}" +

            "@media(max-width:767px) {" +
                "#nushud-account {" +
                    "top:10px;" +
                    "left:10px;" +
                "}" +

                ".nushud-account-info {" +
                    "max-width:110px;" +
                "}" +

                ".nushud-auth-card {" +
                    "padding:22px;" +
                    "border-radius:24px;" +
                "}" +
            "}";

        document.head.appendChild(style);
    }

    /* =========================================================
       MODAL
       ========================================================= */

    function createAuthModal() {
        if (document.getElementById(AUTH_ROOT_ID)) {
            return;
        }

        var root = document.createElement("div");
        root.id = AUTH_ROOT_ID;

        root.innerHTML =
            '<div class="nushud-auth-card">' +
                '<div style="display:flex;justify-content:flex-end;margin-bottom:8px;">' +
                    '<button type="button" class="nushud-auth-close" id="nushud-auth-close">×</button>' +
                "</div>" +

                '<div class="nushud-auth-mark">N</div>' +

                '<div class="nushud-auth-title" id="nushud-auth-title">Iniciar sesión</div>' +

                '<div class="nushud-auth-description" id="nushud-auth-description">' +
                    "Accede a tu cuenta de Nushud." +
                "</div>" +

                '<form id="nushud-auth-form">' +

                    '<div class="nushud-auth-field">' +
                        '<label class="nushud-auth-label" for="nushud-auth-email">' +
                            "Correo electrónico" +
                        "</label>" +

                        '<input id="nushud-auth-email" class="nushud-auth-input" type="email" autocomplete="email" maxlength="254" required placeholder="tu@email.com">' +
                    "</div>" +

                    '<div class="nushud-auth-field">' +
                        '<label class="nushud-auth-label" for="nushud-auth-password">' +
                            "Contraseña" +
                        "</label>" +

                        '<input id="nushud-auth-password" class="nushud-auth-input" type="password" autocomplete="current-password" minlength="8" maxlength="72" required placeholder="Tu contraseña">' +

                        '<div id="nushud-auth-password-info" style="margin-top:6px;color:#52525b;font-size:9px;">' +
                            "Mínimo 8 caracteres." +
                        "</div>" +
                    "</div>" +

                    '<button id="nushud-auth-submit" class="nushud-auth-button" type="submit">' +
                        "Iniciar sesión" +
                    "</button>" +

                "</form>" +

                '<button id="nushud-auth-reset" class="nushud-auth-secondary" type="button">' +
                    "He olvidado mi contraseña" +
                "</button>" +

                '<div id="nushud-auth-message" class="nushud-auth-message"></div>' +

                '<div class="nushud-auth-switch">' +
                    '<span id="nushud-auth-switch-text">¿No tienes cuenta?</span>' +
                    '<button id="nushud-auth-switch" type="button">Registrarse</button>' +
                "</div>" +
            "</div>";

        document.body.appendChild(root);

        document
            .getElementById("nushud-auth-close")
            .addEventListener("click", closeAuth);

        document
            .getElementById("nushud-auth-switch")
            .addEventListener("click", toggleAuthMode);

        document
            .getElementById("nushud-auth-reset")
            .addEventListener("click", resetPassword);

        document
            .getElementById("nushud-auth-form")
            .addEventListener("submit", submitAuth);

        root.addEventListener("click", function (event) {
            if (event.target === root) {
                closeAuth();
            }
        });
    }

    function openAuth(mode) {
        authMode = mode === "register" ? "register" : "login";

        updateAuthModal();

        var root = document.getElementById(AUTH_ROOT_ID);

        if (!root) {
            return;
        }

        root.classList.add("open");

        var email = document.getElementById("nushud-auth-email");

        if (email) {
            setTimeout(function () {
                email.focus();
            }, 50);
        }
    }

    function closeAuth() {
        var root = document.getElementById(AUTH_ROOT_ID);

        if (root) {
            root.classList.remove("open");
        }

        showMessage("");
    }

    function toggleAuthMode() {
        authMode = authMode === "login" ? "register" : "login";

        updateAuthModal();
        showMessage("");

        var password = document.getElementById("nushud-auth-password");

        if (password) {
            password.value = "";
        }
    }

    function updateAuthModal() {
        var title = document.getElementById("nushud-auth-title");
        var description = document.getElementById("nushud-auth-description");
        var submit = document.getElementById("nushud-auth-submit");
        var switchText = document.getElementById("nushud-auth-switch-text");
        var switchButton = document.getElementById("nushud-auth-switch");
        var reset = document.getElementById("nushud-auth-reset");
        var info = document.getElementById("nushud-auth-password-info");

        if (!title || !description || !submit || !switchText || !switchButton) {
            return;
        }

        if (authMode === "register") {
            title.textContent = "Crear cuenta";
            description.textContent = "Crea tu cuenta segura de Nushud.";
            submit.textContent = "Registrarse";
            switchText.textContent = "¿Ya tienes cuenta?";
            switchButton.textContent = "Iniciar sesión";

            if (reset) {
                reset.style.display = "none";
            }

            if (info) {
                info.textContent =
                    "Mínimo 8 caracteres, una mayúscula, una minúscula y un número.";
            }
        } else {
            title.textContent = "Iniciar sesión";
            description.textContent = "Accede a tu cuenta de Nushud.";
            submit.textContent = "Iniciar sesión";
            switchText.textContent = "¿No tienes cuenta?";
            switchButton.textContent = "Registrarse";

            if (reset) {
                reset.style.display = "block";
            }

            if (info) {
                info.textContent = "Mínimo 8 caracteres.";
            }
        }
    }

    /* =========================================================
       VALIDACIÓN
       ========================================================= */

    function validEmail(email) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }

    function strongPassword(password) {
        return (
            password.length >= 8 &&
            password.length <= 72 &&
            /[a-z]/.test(password) &&
            /[A-Z]/.test(password) &&
            /\d/.test(password)
        );
    }

    function showMessage(message, type) {
        var element = document.getElementById("nushud-auth-message");

        if (!element) {
            return;
        }

        element.textContent = message || "";
        element.className = "nushud-auth-message " + (type || "error");
    }

    function authError(error) {
        var text = String(error && error.message ? error.message : "").toLowerCase();

        if (text.indexOf("invalid login credentials") !== -1) {
            return "Correo o contraseña incorrectos.";
        }

        if (text.indexOf("user already registered") !== -1) {
            return "Ese correo ya está registrado.";
        }

        if (text.indexOf("email not confirmed") !== -1) {
            return "Debes confirmar tu correo antes de iniciar sesión.";
        }

        if (text.indexOf("rate limit") !== -1 || text.indexOf("too many requests") !== -1) {
            return "Demasiados intentos. Espera unos minutos.";
        }

        return (
            error && error.message
                ? error.message
                : "No se pudo completar la operación."
        );
    }

    /* =========================================================
       LOGIN / REGISTRO
       ========================================================= */

    async function submitAuth(event) {
        event.preventDefault();

        showMessage("");

        var emailElement = document.getElementById("nushud-auth-email");
        var passwordElement = document.getElementById("nushud-auth-password");
        var submit = document.getElementById("nushud-auth-submit");

        var email = String(emailElement.value || "").trim().toLowerCase();
        var password = String(passwordElement.value || "");

        if (!validEmail(email)) {
            showMessage("Introduce un correo electrónico válido.");
            emailElement.focus();
            return;
        }

        if (authMode === "register" && !strongPassword(password)) {
            showMessage(
                "La contraseña debe tener 8 caracteres, una mayúscula, una minúscula y un número."
            );
            passwordElement.focus();
            return;
        }

        if (
            authMode === "login" &&
            (password.length < 8 || password.length > 72)
        ) {
            showMessage("La contraseña no es válida.");
            passwordElement.focus();
            return;
        }

        submit.disabled = true;
        submit.textContent =
            authMode === "register"
                ? "Creando cuenta..."
                : "Comprobando...";

        try {
            var client = await getSupabaseClient();

            if (authMode === "register") {
                var resultRegister = await client.auth.signUp({
                    email: email,
                    password: password,
                    options: {
                        emailRedirectTo: window.location.origin
                    }
                });

                if (resultRegister.error) {
                    throw resultRegister.error;
                }

                if (resultRegister.data && resultRegister.data.session) {
                    currentUser = resultRegister.data.user || null;
                    closeAuth();
                    updateAccountUI();
                } else {
                    showMessage(
                        "Cuenta creada. Revisa tu correo para confirmar la cuenta.",
                        "success"
                    );

                    passwordElement.value = "";
                }
            } else {
                var resultLogin = await client.auth.signInWithPassword({
                    email: email,
                    password: password
                });

                if (resultLogin.error) {
                    throw resultLogin.error;
                }

                currentUser =
                    resultLogin.data && resultLogin.data.user
                        ? resultLogin.data.user
                        : null;

                closeAuth();
                updateAccountUI();
            }
        } catch (error) {
            console.error("[NUSHUD AUTH]", error);
            showMessage(authError(error));
        }

        submit.disabled = false;
        submit.textContent =
            authMode === "register"
                ? "Registrarse"
                : "Iniciar sesión";
    }

    /* =========================================================
       RECUPERAR CONTRASEÑA
       ========================================================= */

    async function resetPassword() {
        showMessage("");

        var emailElement = document.getElementById("nushud-auth-email");
        var email = String(emailElement.value || "").trim().toLowerCase();

        if (!validEmail(email)) {
            showMessage("Escribe primero tu correo electrónico.");
            emailElement.focus();
            return;
        }

        try {
            var client = await getSupabaseClient();

            var result =
                await client.auth.resetPasswordForEmail(email, {
                    redirectTo: window.location.origin
                });

            if (result.error) {
                throw result.error;
            }

            showMessage(
                "Si existe una cuenta con ese correo, recibirás instrucciones para recuperar la contraseña.",
                "success"
            );
        } catch (error) {
            console.error("[NUSHUD AUTH RESET]", error);
            showMessage(authError(error));
        }
    }

    /* =========================================================
       BOTÓN DE CUENTA
       ========================================================= */

    function createAccountUI() {
        if (document.getElementById(ACCOUNT_ID)) {
            return;
        }

        var wrapper = document.createElement("div");
        wrapper.id = ACCOUNT_ID;

        wrapper.innerHTML =
            '<button id="nushud-account-button" class="nushud-account-button" type="button">' +
                '<div id="nushud-account-avatar" class="nushud-account-avatar">N</div>' +
                '<div class="nushud-account-info">' +
                    '<div id="nushud-account-name" class="nushud-account-name">' +
                        "Iniciar sesión" +
                    "</div>" +
                    '<div id="nushud-account-status" class="nushud-account-status">' +
                        "Cuenta Nushud" +
                    "</div>" +
                "</div>" +
                '<div style="color:#52525b;font-size:12px;">›</div>' +
            "</button>";

        document.body.appendChild(wrapper);

        document
            .getElementById("nushud-account-button")
            .addEventListener("click", function () {
                if (currentUser) {
                    openAccountMenu();
                } else {
                    openAuth("login");
                }
            });
    }

    function updateAccountUI() {
        createAccountUI();

        var name = document.getElementById("nushud-account-name");
        var status = document.getElementById("nushud-account-status");
        var avatar = document.getElementById("nushud-account-avatar");

        if (!name || !status || !avatar) {
            return;
        }

        if (currentUser) {
            name.textContent = currentUser.email || "Usuario";
            status.textContent = "Sesión iniciada";
            avatar.textContent = (
                currentUser.email || "N"
            ).charAt(0).toUpperCase();
        } else {
            name.textContent = "Iniciar sesión";
            status.textContent = "Cuenta Nushud";
            avatar.textContent = "N";
        }
    }

    /* =========================================================
       MENÚ DE CUENTA
       ========================================================= */

    function createAccountMenu() {
        if (document.getElementById("nushud-account-menu")) {
            return document.getElementById("nushud-account-menu");
        }

        var menu = document.createElement("div");
        menu.id = "nushud-account-menu";

        document.body.appendChild(menu);

        document.addEventListener("click", function (event) {
            var button = document.getElementById("nushud-account-button");

            if (
                menu.classList.contains("open") &&
                event.target !== button &&
                !button.contains(event.target) &&
                !menu.contains(event.target)
            ) {
                menu.classList.remove("open");
            }
        });

        return menu;
    }

    function openAccountMenu() {
        var menu = createAccountMenu();

        menu.innerHTML =
            '<div class="nushud-menu-email">' +
                escapeHtml(currentUser && currentUser.email
                    ? currentUser.email
                    : "") +
            "</div>" +

            '<button id="nushud-logout-button" class="nushud-menu-button" type="button">' +
                "Cerrar sesión" +
            "</button>";

        var button = document.getElementById("nushud-account-button");

        if (!button) {
            return;
        }

        var rect = button.getBoundingClientRect();

        menu.style.left = Math.max(10, rect.left) + "px";
        menu.style.top = (rect.bottom + 8) + "px";

        menu.classList.add("open");

        document
            .getElementById("nushud-logout-button")
            .addEventListener("click", logout);
    }

    async function logout() {
        var menu = document.getElementById("nushud-account-menu");

        if (menu) {
            menu.classList.remove("open");
        }

        try {
            var client = await getSupabaseClient();
            var result = await client.auth.signOut();

            if (result.error) {
                throw result.error;
            }

            currentUser = null;
            updateAccountUI();
        } catch (error) {
            console.error("[NUSHUD AUTH LOGOUT]", error);
        }
    }

    /* =========================================================
       SESIÓN
       ========================================================= */

    async function restoreSession() {
        var client = await getSupabaseClient();

        var result = await client.auth.getSession();

        if (result.error) {
            throw result.error;
        }

        currentUser =
            result.data &&
            result.data.session
                ? result.data.session.user
                : null;

        updateAccountUI();

        client.auth.onAuthStateChange(function (event, session) {
            currentUser =
                session && session.user
                    ? session.user
                    : null;

            updateAccountUI();
        });
    }

    /* =========================================================
       ESCAPE
       ========================================================= */

    function escapeHtml(value) {
        var div = document.createElement("div");
        div.textContent = String(value == null ? "" : value);
        return div.innerHTML;
    }

    /* =========================================================
       INICIO
       ========================================================= */

    async function init() {
        addStyles();
        createAuthModal();
        createAccountUI();
        updateAccountUI();

        try {
            await restoreSession();
        } catch (error) {
            console.error("[NUSHUD AUTH INIT]", error);
        }

        window.NushudAuth = {
            open: openAuth,
            logout: logout,
            getUser: function () {
                return currentUser;
            }
        };
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init, {
            once: true
        });
    } else {
        init();
    }
})();
```
