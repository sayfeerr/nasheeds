"use strict";

(function () {

    var supabaseClient = null;
    var currentUser = null;
    var authMode = "login";

    var STYLE_ID = "nushud-auth-style";
    var ACCOUNT_ID = "nushud-account";
    var ROOT_ID = "nushud-auth-root";
    var MENU_ID = "nushud-account-menu";

    var authTexts = {
        es: {
            login: "Iniciar sesión",
            register: "Crear cuenta",
            access: "Accede a tu cuenta de Nushud.",
            create: "Crea tu cuenta segura de Nushud.",
            email: "Correo electrónico",
            password: "Contraseña",
            emailPlaceholder: "tu@email.com",
            passwordPlaceholder: "Tu contraseña",
            loginButton: "Iniciar sesión",
            registerButton: "Registrarse",
            alreadyAccount: "¿Ya tienes cuenta?",
            noAccount: "¿No tienes cuenta?",
            forgot: "He olvidado mi contraseña",
            close: "Cerrar",
            account: "Cuenta Nushud",
            signedIn: "Sesión iniciada",
            creating: "Creando cuenta...",
            checking: "Comprobando...",
            invalidEmail: "Introduce un correo electrónico válido.",
            weakPassword: "La contraseña debe tener al menos 8 caracteres, una mayúscula, una minúscula y un número.",
            invalidPassword: "La contraseña no es válida.",
            checkEmail: "Cuenta creada. Revisa tu correo para confirmar la cuenta.",
            resetSent: "Si existe una cuenta con ese correo, recibirás instrucciones para recuperar la contraseña.",
            writeEmail: "Escribe primero tu correo electrónico.",
            wrongCredentials: "Correo o contraseña incorrectos.",
            alreadyRegistered: "Ese correo ya está registrado.",
            notConfirmed: "Debes confirmar tu correo antes de iniciar sesión.",
            rateLimit: "Demasiados intentos. Espera unos minutos.",
            supabaseError: "No se pudo completar la operación.",
            logout: "Cerrar sesión"
        },

        en: {
            login: "Sign in",
            register: "Create account",
            access: "Access your Nushud account.",
            create: "Create your secure Nushud account.",
            email: "Email address",
            password: "Password",
            emailPlaceholder: "you@email.com",
            passwordPlaceholder: "Your password",
            loginButton: "Sign in",
            registerButton: "Register",
            alreadyAccount: "Already have an account?",
            noAccount: "Don't have an account?",
            forgot: "Forgot my password",
            close: "Close",
            account: "Nushud account",
            signedIn: "Signed in",
            creating: "Creating account...",
            checking: "Checking...",
            invalidEmail: "Enter a valid email address.",
            weakPassword: "Password must contain at least 8 characters, one uppercase letter, one lowercase letter and one number.",
            invalidPassword: "The password is not valid.",
            checkEmail: "Account created. Check your email to confirm your account.",
            resetSent: "If an account exists with this email, you will receive recovery instructions.",
            writeEmail: "Enter your email address first.",
            wrongCredentials: "Incorrect email or password.",
            alreadyRegistered: "That email is already registered.",
            notConfirmed: "You must confirm your email before signing in.",
            rateLimit: "Too many attempts. Please wait a few minutes.",
            supabaseError: "The operation could not be completed.",
            logout: "Sign out"
        }
    };

    function getLanguage() {
        try {
            var lang = localStorage.getItem("nasheed_interface_language");

            if (lang === "en") {
                return "en";
            }
        } catch (e) {}

        return "es";
    }

    function text(key) {
        var lang = getLanguage();

        return (
            authTexts[lang][key] ||
            authTexts.es[key] ||
            key
        );
    }

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
            throw new Error(text("supabaseError"));
        }

        var config = await response.json();

        if (
            !config ||
            !config.supabaseUrl ||
            !config.supabasePublishableKey
        ) {
            throw new Error(text("supabaseError"));
        }

        if (
            !window.supabase ||
            typeof window.supabase.createClient !== "function"
        ) {
            throw new Error(text("supabaseError"));
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

    function injectStyles() {
        if (document.getElementById(STYLE_ID)) {
            return;
        }

        var style = document.createElement("style");
        style.id = STYLE_ID;

        style.textContent =
            "#nushud-account{" +
                "position:fixed;" +
                "top:14px;" +
                "right:108px;" +
                "left:auto;" +
                "z-index:9999;" +
            "}" +

            ".nushud-account-button{" +
                "display:flex;" +
                "align-items:center;" +
                "gap:8px;" +
                "padding:6px 11px 6px 6px;" +
                "min-height:40px;" +
                "border-radius:13px;" +
                "border:1px solid rgba(255,255,255,.10);" +
                "background:rgba(12,12,15,.90);" +
                "color:#f4f4f5;" +
                "backdrop-filter:blur(18px);" +
                "-webkit-backdrop-filter:blur(18px);" +
                "box-shadow:0 10px 25px rgba(0,0,0,.22);" +
                "cursor:pointer;" +
            "}" +

            ".nushud-account-button:hover{" +
                "border-color:rgba(245,158,11,.30);" +
                "background:rgba(24,24,30,.96);" +
            "}" +

            ".nushud-account-avatar{" +
                "width:29px;" +
                "height:29px;" +
                "min-width:29px;" +
                "border-radius:50%;" +
                "display:flex;" +
                "align-items:center;" +
                "justify-content:center;" +
                "background:rgba(245,158,11,.14);" +
                "border:1px solid rgba(245,158,11,.25);" +
                "color:#fbbf24;" +
                "font-size:10px;" +
                "font-weight:900;" +
            "}" +

            ".nushud-account-info{" +
                "max-width:150px;" +
                "min-width:0;" +
                "text-align:left;" +
            "}" +

            ".nushud-account-name{" +
                "font-size:9px;" +
                "font-weight:800;" +
                "overflow:hidden;" +
                "text-overflow:ellipsis;" +
                "white-space:nowrap;" +
            "}" +

            ".nushud-account-status{" +
                "margin-top:2px;" +
                "font-size:7px;" +
                "color:#71717a;" +
            "}" +

            "#nushud-auth-root{" +
                "position:fixed;" +
                "inset:0;" +
                "z-index:10000;" +
                "display:none;" +
                "align-items:center;" +
                "justify-content:center;" +
                "padding:18px;" +
                "box-sizing:border-box;" +
                "background:rgba(0,0,0,.60);" +
                "backdrop-filter:blur(12px);" +
                "-webkit-backdrop-filter:blur(12px);" +
            "}" +

            "#nushud-auth-root.open{" +
                "display:flex;" +
            "}" +

            ".nushud-auth-card{" +
                "width:min(430px,100%);" +
                "max-height:calc(100vh - 36px);" +
                "overflow-y:auto;" +
                "box-sizing:border-box;" +
                "padding:26px;" +
                "border-radius:28px;" +
                "background:linear-gradient(145deg,rgba(24,24,30,.98),rgba(10,10,13,.98));" +
                "border:1px solid rgba(245,158,11,.22);" +
                "box-shadow:0 30px 90px rgba(0,0,0,.65);" +
            "}" +

            ".nushud-auth-close{" +
                "width:34px;" +
                "height:34px;" +
                "border-radius:11px;" +
                "border:1px solid rgba(255,255,255,.08);" +
                "background:rgba(255,255,255,.04);" +
                "color:#a1a1aa;" +
                "cursor:pointer;" +
                "font-size:17px;" +
            "}" +

            ".nushud-auth-mark{" +
                "width:50px;" +
                "height:50px;" +
                "border-radius:17px;" +
                "display:flex;" +
                "align-items:center;" +
                "justify-content:center;" +
                "margin-bottom:15px;" +
                "background:linear-gradient(135deg,#fbbf24,#f59e0b,#b45309);" +
                "color:#18181b;" +
                "font-size:20px;" +
                "font-weight:900;" +
            "}" +

            ".nushud-auth-title{" +
                "color:#f4f4f5;" +
                "font-size:19px;" +
                "font-weight:800;" +
            "}" +

            ".nushud-auth-description{" +
                "margin-top:5px;" +
                "color:#71717a;" +
                "font-size:11px;" +
            "}" +

            ".nushud-auth-field{" +
                "margin-top:14px;" +
            "}" +

            ".nushud-auth-label{" +
                "display:block;" +
                "margin-bottom:7px;" +
                "color:#a1a1aa;" +
                "font-size:10px;" +
                "font-weight:700;" +
            "}" +

            ".nushud-auth-input{" +
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

            ".nushud-auth-button{" +
                "width:100%;" +
                "margin-top:17px;" +
                "padding:12px 14px;" +
                "border:0;" +
                "border-radius:13px;" +
                "background:#f59e0b;" +
                "color:#18181b;" +
                "font-size:11px;" +
                "font-weight:800;" +
                "cursor:pointer;" +
            "}" +

            ".nushud-auth-button:disabled{" +
                "opacity:.55;" +
                "cursor:not-allowed;" +
            "}" +

            ".nushud-auth-secondary{" +
                "width:100%;" +
                "margin-top:9px;" +
                "padding:10px 14px;" +
                "border-radius:13px;" +
                "border:1px solid rgba(255,255,255,.08);" +
                "background:rgba(255,255,255,.035);" +
                "color:#a1a1aa;" +
                "font-size:10px;" +
                "font-weight:700;" +
                "cursor:pointer;" +
            "}" +

            ".nushud-auth-message{" +
                "min-height:18px;" +
                "margin-top:12px;" +
                "text-align:center;" +
                "font-size:10px;" +
            "}" +

            ".nushud-auth-message.error{" +
                "color:#f87171;" +
            "}" +

            ".nushud-auth-message.success{" +
                "color:#fbbf24;" +
            "}" +

            ".nushud-auth-switch{" +
                "margin-top:16px;" +
                "text-align:center;" +
                "color:#71717a;" +
                "font-size:10px;" +
            "}" +

            ".nushud-auth-switch button{" +
                "margin-left:4px;" +
                "padding:0;" +
                "border:0;" +
                "background:transparent;" +
                "color:#fbbf24;" +
                "font-weight:800;" +
                "cursor:pointer;" +
            "}" +

            "#nushud-account-menu{" +
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

            "#nushud-account-menu.open{" +
                "display:block;" +
            "}" +

            ".nushud-menu-email{" +
                "padding:8px;" +
                "color:#71717a;" +
                "font-size:9px;" +
                "overflow:hidden;" +
                "text-overflow:ellipsis;" +
                "white-space:nowrap;" +
            "}" +

            ".nushud-menu-button{" +
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

            ".nushud-menu-button:hover{" +
                "background:rgba(255,255,255,.05);" +
                "color:#f4f4f5;" +
            "}" +

            "@media(max-width:767px){" +
                "#nushud-account{" +
                    "top:10px;" +
                    "right:82px;" +
                    "left:auto;" +
                "}" +

                ".nushud-account-info{" +
                    "max-width:105px;" +
                "}" +
            "}";

        document.head.appendChild(style);
    }

    function createAuthModal() {
        if (document.getElementById(ROOT_ID)) {
            return;
        }

        var root = document.createElement("div");
        root.id = ROOT_ID;

        root.innerHTML =
            '<div class="nushud-auth-card">' +
                '<div style="display:flex;justify-content:flex-end;margin-bottom:8px;">' +
                    '<button id="nushud-auth-close" class="nushud-auth-close" type="button"></button>' +
                "</div>" +

                '<div class="nushud-auth-mark">N</div>' +

                '<div id="nushud-auth-title" class="nushud-auth-title"></div>' +

                '<div id="nushud-auth-description" class="nushud-auth-description"></div>' +

                '<form id="nushud-auth-form" autocomplete="on">' +

                    '<div class="nushud-auth-field">' +
                        '<label id="nushud-email-label" class="nushud-auth-label" for="nushud-auth-email"></label>' +
                        '<input id="nushud-auth-email" class="nushud-auth-input" type="email" autocomplete="email" maxlength="254" required>' +
                    "</div>" +

                    '<div class="nushud-auth-field">' +
                        '<label id="nushud-password-label" class="nushud-auth-label" for="nushud-auth-password"></label>' +
                        '<input id="nushud-auth-password" class="nushud-auth-input" type="password" autocomplete="current-password" minlength="8" maxlength="72" required>' +
                        '<div id="nushud-password-info" style="margin-top:6px;color:#52525b;font-size:9px;"></div>' +
                    "</div>" +

                    '<button id="nushud-auth-submit" class="nushud-auth-button" type="submit"></button>' +
                "</form>" +

                '<button id="nushud-auth-reset" class="nushud-auth-secondary" type="button"></button>' +

                '<div id="nushud-auth-message" class="nushud-auth-message"></div>' +

                '<div class="nushud-auth-switch">' +
                    '<span id="nushud-auth-switch-text"></span>' +
                    '<button id="nushud-auth-switch" type="button"></button>' +
                "</div>" +
            "</div>";

        document.body.appendChild(root);

        document.getElementById("nushud-auth-close")
            .addEventListener("click", closeAuth);

        document.getElementById("nushud-auth-switch")
            .addEventListener("click", toggleAuthMode);

        document.getElementById("nushud-auth-reset")
            .addEventListener("click", resetPassword);

        document.getElementById("nushud-auth-form")
            .addEventListener("submit", submitAuth);

        root.addEventListener("click", function (event) {
            if (event.target === root) {
                closeAuth();
            }
        });

        updateAuthLanguage();
    }

    function updateAuthLanguage() {
        var title = document.getElementById("nushud-auth-title");
        var description = document.getElementById("nushud-auth-description");
        var emailLabel = document.getElementById("nushud-email-label");
        var passwordLabel = document.getElementById("nushud-password-label");
        var email = document.getElementById("nushud-auth-email");
        var password = document.getElementById("nushud-auth-password");
        var info = document.getElementById("nushud-password-info");
        var submit = document.getElementById("nushud-auth-submit");
        var reset = document.getElementById("nushud-auth-reset");
        var switchText = document.getElementById("nushud-auth-switch-text");
        var switchButton = document.getElementById("nushud-auth-switch");
        var close = document.getElementById("nushud-auth-close");

        if (title) {
            title.textContent =
                authMode === "register"
                    ? text("register")
                    : text("login");
        }

        if (description) {
            description.textContent =
                authMode === "register"
                    ? text("create")
                    : text("access");
        }

        if (emailLabel) {
            emailLabel.textContent = text("email");
        }

        if (passwordLabel) {
            passwordLabel.textContent = text("password");
        }

        if (email) {
            email.placeholder = text("emailPlaceholder");
        }

        if (password) {
            password.placeholder = text("passwordPlaceholder");
        }

        if (info) {
            info.textContent =
                authMode === "register"
                    ? text("weakPassword")
                    : "Minimum 8 characters.";
        }

        if (submit) {
            submit.textContent =
                authMode === "register"
                    ? text("registerButton")
                    : text("loginButton");
        }

        if (reset) {
            reset.textContent = text("forgot");
            reset.style.display =
                authMode === "register"
                    ? "none"
                    : "block";
        }

        if (switchText) {
            switchText.textContent =
                authMode === "register"
                    ? text("alreadyAccount")
                    : text("noAccount");
        }

        if (switchButton) {
            switchButton.textContent =
                authMode === "register"
                    ? text("loginButton")
                    : text("registerButton");
        }

        if (close) {
            close.textContent = text("close");
        }

        updateAccountUI();
    }

    function openAuth(mode) {
        authMode =
            mode === "register"
                ? "register"
                : "login";

        updateAuthLanguage();

        var root = document.getElementById(ROOT_ID);

        if (!root) {
            return;
        }

        root.classList.add("open");

        setTimeout(function () {
            var email = document.getElementById("nushud-auth-email");

            if (email) {
                email.focus();
            }
        }, 50);
    }

    function closeAuth() {
        var root = document.getElementById(ROOT_ID);

        if (root) {
            root.classList.remove("open");
        }

        showMessage("");
    }

    function toggleAuthMode() {
        authMode =
            authMode === "login"
                ? "register"
                : "login";

        updateAuthLanguage();
        showMessage("");

        var password =
            document.getElementById("nushud-auth-password");

        if (password) {
            password.value = "";
        }
    }

    function validEmail(email) {
        return (
            typeof email === "string" &&
            /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
        );
    }

    function strongPassword(password) {
        return (
            typeof password === "string" &&
            password.length >= 8 &&
            password.length <= 72 &&
            /[a-z]/.test(password) &&
            /[A-Z]/.test(password) &&
            /\d/.test(password)
        );
    }

    function showMessage(message, type) {
        var element =
            document.getElementById("nushud-auth-message");

        if (!element) {
            return;
        }

        element.textContent = message || "";

        element.className =
            "nushud-auth-message " +
            (type || "error");
    }

    function translateError(error) {
        var message =
            String(
                error && error.message
                    ? error.message
                    : ""
            ).toLowerCase();

        if (message.indexOf("invalid login credentials") !== -1) {
            return text("wrongCredentials");
        }

        if (message.indexOf("user already registered") !== -1) {
            return text("alreadyRegistered");
        }

        if (message.indexOf("email not confirmed") !== -1) {
            return text("notConfirmed");
        }

        if (
            message.indexOf("rate limit") !== -1 ||
            message.indexOf("too many requests") !== -1
        ) {
            return text("rateLimit");
        }

        return (
            error && error.message
                ? error.message
                : text("supabaseError")
        );
    }

    async function submitAuth(event) {
        event.preventDefault();

        var emailInput =
            document.getElementById("nushud-auth-email");

        var passwordInput =
            document.getElementById("nushud-auth-password");

        var submit =
            document.getElementById("nushud-auth-submit");

        var email =
            String(emailInput.value || "")
                .trim()
                .toLowerCase();

        var password =
            String(passwordInput.value || "");

        if (!validEmail(email)) {
            showMessage(text("invalidEmail"));
            emailInput.focus();
            return;
        }

        if (
            authMode === "register" &&
            !strongPassword(password)
        ) {
            showMessage(text("weakPassword"));
            passwordInput.focus();
            return;
        }

        if (
            authMode === "login" &&
            (
                password.length < 8 ||
                password.length > 72
            )
        ) {
            showMessage(text("invalidPassword"));
            passwordInput.focus();
            return;
        }

        submit.disabled = true;

        submit.textContent =
            authMode === "register"
                ? text("creating")
                : text("checking");

        try {
            var client =
                await getSupabaseClient();

            if (authMode === "register") {
                var registerResult =
                    await client.auth.signUp({
                        email: email,
                        password: password,
                        options: {
                            emailRedirectTo:
                                window.location.origin
                        }
                    });

                if (registerResult.error) {
                    throw registerResult.error;
                }

                if (
                    registerResult.data &&
                    registerResult.data.session
                ) {
                    currentUser =
                        registerResult.data.user || null;

                    closeAuth();
                    updateAccountUI();

                    dispatchAuthChanged();
                } else {
                    showMessage(
                        text("checkEmail"),
                        "success"
                    );

                    passwordInput.value = "";
                }

            } else {
                var loginResult =
                    await client.auth.signInWithPassword({
                        email: email,
                        password: password
                    });

                if (loginResult.error) {
                    throw loginResult.error;
                }

                currentUser =
                    loginResult.data &&
                    loginResult.data.user
                        ? loginResult.data.user
                        : null;

                closeAuth();
                updateAccountUI();

                dispatchAuthChanged();
            }

        } catch (error) {
            console.error("[NUSHUD AUTH]", error);

            showMessage(
                translateError(error)
            );
        }

        submit.disabled = false;

        updateAuthLanguage();
    }

    async function resetPassword() {
        showMessage("");

        var emailInput =
            document.getElementById("nushud-auth-email");

        var email =
            String(emailInput.value || "")
                .trim()
                .toLowerCase();

        if (!validEmail(email)) {
            showMessage(text("writeEmail"));
            emailInput.focus();
            return;
        }

        try {
            var client =
                await getSupabaseClient();

            var result =
                await client.auth.resetPasswordForEmail(
                    email,
                    {
                        redirectTo:
                            window.location.origin
                    }
                );

            if (result.error) {
                throw result.error;
            }

            showMessage(
                text("resetSent"),
                "success"
            );

        } catch (error) {
            console.error("[NUSHUD RESET]", error);

            showMessage(
                translateError(error)
            );
        }
    }

    function createAccountUI() {
        if (
            document.getElementById(
                ACCOUNT_ID
            )
        ) {
            return;
        }

        var wrapper =
            document.createElement("div");

        wrapper.id = ACCOUNT_ID;

        wrapper.innerHTML =
            '<button id="nushud-account-button" class="nushud-account-button" type="button">' +
                '<div id="nushud-account-avatar" class="nushud-account-avatar">N</div>' +

                '<div class="nushud-account-info">' +
                    '<div id="nushud-account-name" class="nushud-account-name"></div>' +
                    '<div id="nushud-account-status" class="nushud-account-status"></div>' +
                "</div>" +

                '<div style="color:#52525b;font-size:12px;">›</div>' +
            "</button>";

        document.body.appendChild(wrapper);

        document
            .getElementById("nushud-account-button")
            .addEventListener(
                "click",
                handleAccountClick
            );

        updateAccountUI();
    }

    function updateAccountUI() {
        var name =
            document.getElementById("nushud-account-name");

        var status =
            document.getElementById("nushud-account-status");

        var avatar =
            document.getElementById("nushud-account-avatar");

        if (!name || !status || !avatar) {
            return;
        }

        if (currentUser) {
            name.textContent =
                currentUser.email || "Usuario";

            status.textContent =
                text("signedIn");

            avatar.textContent =
                (
                    currentUser.email || "N"
                )
                    .charAt(0)
                    .toUpperCase();

        } else {
            name.textContent =
                text("login");

            status.textContent =
                text("account");

            avatar.textContent =
                "N";
        }
    }

    function handleAccountClick() {
        if (currentUser) {
            openAccountMenu();
        } else {
            openAuth("login");
        }
    }

    function createAccountMenu() {
        var existing =
            document.getElementById(MENU_ID);

        if (existing) {
            return existing;
        }

        var menu =
            document.createElement("div");

        menu.id = MENU_ID;

        document.body.appendChild(menu);

        document.addEventListener(
            "click",
            function (event) {
                var button =
                    document.getElementById(
                        "nushud-account-button"
                    );

                if (
                    menu.classList.contains("open") &&
                    event.target !== button &&
                    !button.contains(event.target) &&
                    !menu.contains(event.target)
                ) {
                    menu.classList.remove("open");
                }
            }
        );

        return menu;
    }

    function openAccountMenu() {
        var menu =
            createAccountMenu();

        menu.innerHTML =
            '<div class="nushud-menu-email">' +
                escapeHtml(
                    currentUser &&
                    currentUser.email
                        ? currentUser.email
                        : ""
                ) +
            "</div>" +

            '<button id="nushud-logout-button" class="nushud-menu-button" type="button">' +
                text("logout") +
            "</button>";

        var button =
            document.getElementById(
                "nushud-account-button"
            );

        if (!button) {
            return;
        }

        var rect =
            button.getBoundingClientRect();

        menu.style.left =
            Math.max(10, rect.left) +
            "px";

        menu.style.top =
            rect.bottom +
            8 +
            "px";

        menu.classList.add("open");

        document
            .getElementById(
                "nushud-logout-button"
            )
            .addEventListener(
                "click",
                logout
            );
    }

    async function logout() {
        var menu =
            document.getElementById(
                MENU_ID
            );

        if (menu) {
            menu.classList.remove("open");
        }

        try {
            var client =
                await getSupabaseClient();

            var result =
                await client.auth.signOut();

            if (result.error) {
                throw result.error;
            }

            currentUser = null;

            updateAccountUI();

            dispatchAuthChanged();

        } catch (error) {
            console.error(
                "[NUSHUD LOGOUT]",
                error
            );
        }
    }

    function dispatchAuthChanged() {
        window.dispatchEvent(
            new CustomEvent(
                "nushud-auth-changed",
                {
                    detail: {
                        user: currentUser
                    }
                }
            )
        );
    }

    async function restoreSession() {
        var client =
            await getSupabaseClient();

        var result =
            await client.auth.getSession();

        if (result.error) {
            throw result.error;
        }

        currentUser =
            result.data &&
            result.data.session
                ? result.data.session.user
                : null;

        updateAccountUI();

        dispatchAuthChanged();

        var previousUserId =
            currentUser
                ? currentUser.id
                : null;

        client.auth.onAuthStateChange(
            function (event, session) {

                var nextUser =
                    session && session.user
                        ? session.user
                        : null;

                var nextUserId =
                    nextUser
                        ? nextUser.id
                        : null;

                currentUser =
                    nextUser;

                updateAccountUI();

                /*
                 * IMPORTANTE:
                 * solamente avisamos a index.html
                 * cuando cambia realmente el usuario.
                 *
                 * No hacemos render por refrescos
                 * de token.
                 */
                if (
                    previousUserId !==
                    nextUserId
                ) {

                    previousUserId =
                        nextUserId;

                    dispatchAuthChanged();
                }
            }
        );
    }

    window.addEventListener(
        "nushud-language-changed",
        function () {
            updateAuthLanguage();
            updateAccountUI();

            var menu =
                document.getElementById(
                    MENU_ID
                );

            if (
                menu &&
                menu.classList.contains("open")
            ) {
                openAccountMenu();
            }
        }
    );

    function escapeHtml(value) {
        var div =
            document.createElement("div");

        div.textContent =
            String(
                value == null
                    ? ""
                    : value
            );

        return div.innerHTML;
    }

    async function init() {
        console.log(
            "[NUSHUD AUTH] auth.js cargado"
        );

        injectStyles();
        createAccountUI();
        createAuthModal();

        try {
            await restoreSession();
        } catch (error) {
            console.error(
                "[NUSHUD AUTH INIT]",
                error
            );

            dispatchAuthChanged();
        }
    }

    window.NushudAuth = {
        open: openAuth,

        logout: logout,

        getUser: function () {
            return currentUser;
        }
    };

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