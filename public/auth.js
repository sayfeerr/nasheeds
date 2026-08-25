"use strict";

(function () {

    var client = null;
    var user = null;

    function getClient() {
        return fetch("/api/public-config", {
            cache: "no-store"
        })
        .then(function (response) {
            if (!response.ok) {
                throw new Error("No se pudo cargar la configuración.");
            }
            return response.json();
        })
        .then(function (config) {

            if (
                !config.supabaseUrl ||
                !config.supabasePublishableKey
            ) {
                throw new Error("Configuración de Supabase incompleta.");
            }

            if (
                !window.supabase ||
                typeof window.supabase.createClient !== "function"
            ) {
                throw new Error("Supabase JS no está cargado.");
            }

            if (!client) {
                client = window.supabase.createClient(
                    config.supabaseUrl,
                    config.supabasePublishableKey,
                    {
                        auth: {
                            persistSession: true,
                            autoRefreshToken: true
                        }
                    }
                );
            }

            return client;
        });
    }

    function addStyles() {

        if (document.getElementById("nushud-auth-css")) {
            return;
        }

        var style = document.createElement("style");
        style.id = "nushud-auth-css";

        style.textContent =
            "#nushud-account{" +
                "position:fixed;" +
                "top:14px;" +
                "left:14px;" +
                "z-index:9999;" +
            "}" +

            "#nushud-account button{" +
                "border:1px solid rgba(255,255,255,.1);" +
                "background:rgba(12,12,15,.94);" +
                "color:#fff;" +
                "border-radius:12px;" +
                "padding:9px 14px;" +
                "cursor:pointer;" +
                "font-size:11px;" +
                "font-weight:700;" +
            "}" +

            "#nushud-auth{" +
                "display:none;" +
                "position:fixed;" +
                "inset:0;" +
                "z-index:10000;" +
                "align-items:center;" +
                "justify-content:center;" +
                "background:rgba(0,0,0,.65);" +
                "padding:20px;" +
            "}" +

            "#nushud-auth.open{" +
                "display:flex;" +
            "}" +

            "#nushud-auth-box{" +
                "width:100%;" +
                "max-width:400px;" +
                "background:#101014;" +
                "border:1px solid rgba(245,158,11,.25);" +
                "border-radius:22px;" +
                "padding:25px;" +
                "box-sizing:border-box;" +
            "}" +

            "#nushud-auth-box h2{" +
                "color:#fbbf24;" +
                "margin:0 0 6px 0;" +
                "font-size:20px;" +
            "}" +

            "#nushud-auth-box p{" +
                "color:#71717a;" +
                "font-size:11px;" +
            "}" +

            "#nushud-auth-box input{" +
                "width:100%;" +
                "box-sizing:border-box;" +
                "margin-top:10px;" +
                "padding:12px;" +
                "background:#07070a;" +
                "color:white;" +
                "border:1px solid rgba(255,255,255,.1);" +
                "border-radius:10px;" +
                "outline:none;" +
            "}" +

            "#nushud-auth-submit{" +
                "width:100%;" +
                "margin-top:14px;" +
                "padding:12px;" +
                "border:0;" +
                "border-radius:10px;" +
                "background:#f59e0b;" +
                "color:#18181b;" +
                "font-weight:800;" +
                "cursor:pointer;" +
            "}" +

            "#nushud-auth-register," +
            "#nushud-auth-forgot," +
            "#nushud-auth-close{" +
                "width:100%;" +
                "margin-top:9px;" +
                "padding:10px;" +
                "border:0;" +
                "background:transparent;" +
                "color:#fbbf24;" +
                "cursor:pointer;" +
            "}" +

            "#nushud-auth-message{" +
                "margin-top:12px;" +
                "text-align:center;" +
                "font-size:11px;" +
                "color:#f87171;" +
                "min-height:16px;" +
            "}";

        document.head.appendChild(style);
    }

    function createAccountButton() {

        if (document.getElementById("nushud-account")) {
            return;
        }

        var container = document.createElement("div");
        container.id = "nushud-account";

        var button = document.createElement("button");
        button.id = "nushud-account-button";
        button.textContent = "Iniciar sesión";

        button.onclick = function () {
            openAuth("login");
        };

        container.appendChild(button);
        document.body.appendChild(container);
    }

    function createAuthModal() {

        if (document.getElementById("nushud-auth")) {
            return;
        }

        var root = document.createElement("div");
        root.id = "nushud-auth";

        var box = document.createElement("div");
        box.id = "nushud-auth-box";

        var title = document.createElement("h2");
        title.id = "nushud-auth-title";
        title.textContent = "Iniciar sesión";

        var description = document.createElement("p");
        description.id = "nushud-auth-description";
        description.textContent = "Accede a tu cuenta de Nushud.";

        var email = document.createElement("input");
        email.id = "nushud-auth-email";
        email.type = "email";
        email.placeholder = "Correo electrónico";
        email.autocomplete = "email";

        var password = document.createElement("input");
        password.id = "nushud-auth-password";
        password.type = "password";
        password.placeholder = "Contraseña";
        password.autocomplete = "current-password";

        var submit = document.createElement("button");
        submit.id = "nushud-auth-submit";
        submit.textContent = "Iniciar sesión";

        var register = document.createElement("button");
        register.id = "nushud-auth-register";
        register.textContent = "Crear cuenta";

        var forgot = document.createElement("button");
        forgot.id = "nushud-auth-forgot";
        forgot.textContent = "He olvidado mi contraseña";

        var close = document.createElement("button");
        close.id = "nushud-auth-close";
        close.textContent = "Cerrar";

        var message = document.createElement("div");
        message.id = "nushud-auth-message";

        box.appendChild(title);
        box.appendChild(description);
        box.appendChild(email);
        box.appendChild(password);
        box.appendChild(submit);
        box.appendChild(register);
        box.appendChild(forgot);
        box.appendChild(message);
        box.appendChild(close);

        root.appendChild(box);
        document.body.appendChild(root);

        submit.onclick = function () {
            loginOrRegister();
        };

        register.onclick = function () {
            openAuth("register");
        };

        forgot.onclick = function () {
            resetPassword();
        };

        close.onclick = function () {
            closeAuth();
        };

        root.onclick = function (event) {
            if (event.target === root) {
                closeAuth();
            }
        };
    }

    function openAuth(mode) {

        var root = document.getElementById("nushud-auth");
        var title = document.getElementById("nushud-auth-title");
        var description = document.getElementById("nushud-auth-description");
        var submit = document.getElementById("nushud-auth-submit");
        var register = document.getElementById("nushud-auth-register");

        if (!root) {
            return;
        }

        if (mode === "register") {

            root.setAttribute("data-mode", "register");

            title.textContent = "Crear cuenta";
            description.textContent =
                "Crea una cuenta nueva en Nushud.";

            submit.textContent = "Registrarse";
            register.textContent = "Ya tengo una cuenta";

        } else {

            root.setAttribute("data-mode", "login");

            title.textContent = "Iniciar sesión";
            description.textContent =
                "Accede a tu cuenta de Nushud.";

            submit.textContent = "Iniciar sesión";
            register.textContent = "Crear cuenta";
        }

        root.className = "open";

        document.getElementById("nushud-auth-email").focus();
    }

    function closeAuth() {

        var root = document.getElementById("nushud-auth");

        if (root) {
            root.className = "";
        }

        showMessage("");
    }

    function showMessage(text) {

        var message =
            document.getElementById("nushud-auth-message");

        if (message) {
            message.textContent = text || "";
        }
    }

    function loginOrRegister() {

        var root = document.getElementById("nushud-auth");

        var email =
            document.getElementById("nushud-auth-email").value
                .trim()
                .toLowerCase();

        var password =
            document.getElementById("nushud-auth-password").value;

        var submit =
            document.getElementById("nushud-auth-submit");

        var mode =
            root.getAttribute("data-mode") || "login";

        if (!email || email.indexOf("@") === -1) {
            showMessage("Introduce un correo válido.");
            return;
        }

        if (password.length < 8) {
            showMessage(
                "La contraseña debe tener al menos 8 caracteres."
            );
            return;
        }

        submit.disabled = true;

        getClient()
            .then(function (supabase) {

                if (mode === "register") {

                    return supabase.auth.signUp({
                        email: email,
                        password: password,
                        options: {
                            emailRedirectTo:
                                window.location.origin
                        }
                    });

                }

                return supabase.auth.signInWithPassword({
                    email: email,
                    password: password
                });

            })
            .then(function (result) {

                if (result.error) {
                    throw result.error;
                }

                if (mode === "register") {

                    showMessage(
                        "Cuenta creada. Revisa tu correo para confirmarla."
                    );

                } else {

                    user =
                        result.data &&
                        result.data.user
                            ? result.data.user
                            : null;

                    closeAuth();
                    updateAccountButton();
                }

            })
            .catch(function (error) {

                console.error(
                    "[NUSHUD AUTH]",
                    error
                );

                showMessage(
                    error && error.message
                        ? error.message
                        : "Error de autenticación."
                );

            })
            .finally(function () {

                submit.disabled = false;

            });
    }

    function resetPassword() {

        var email =
            document.getElementById("nushud-auth-email").value
                .trim()
                .toLowerCase();

        if (!email || email.indexOf("@") === -1) {
            showMessage(
                "Escribe primero tu correo."
            );
            return;
        }

        getClient()
            .then(function (supabase) {

                return supabase.auth.resetPasswordForEmail(
                    email,
                    {
                        redirectTo:
                            window.location.origin
                    }
                );

            })
            .then(function (result) {

                if (result.error) {
                    throw result.error;
                }

                showMessage(
                    "Hemos enviado las instrucciones al correo."
                );

            })
            .catch(function (error) {

                console.error(
                    "[NUSHUD RESET]",
                    error
                );

                showMessage(
                    error && error.message
                        ? error.message
                        : "No se pudo recuperar la contraseña."
                );

            });
    }

    function updateAccountButton() {

        var button =
            document.getElementById(
                "nushud-account-button"
            );

        if (!button) {
            return;
        }

        if (user && user.email) {
            button.textContent =
                user.email;
        } else {
            button.textContent =
                "Iniciar sesión";
        }
    }

    function restoreSession() {

        return getClient()
            .then(function (supabase) {

                return supabase.auth.getSession();

            })
            .then(function (result) {

                if (result.error) {
                    throw result.error;
                }

                user =
                    result.data &&
                    result.data.session
                        ? result.data.session.user
                        : null;

                updateAccountButton();

            })
            .catch(function (error) {

                console.error(
                    "[NUSHUD SESSION]",
                    error
                );

            });
    }

    function init() {

        console.log(
            "[NUSHUD AUTH] auth.js cargado correctamente"
        );

        addStyles();
        createAccountButton();
        createAuthModal();
        updateAccountButton();
        restoreSession();
    }

    if (document.readyState === "loading") {

        document.addEventListener(
            "DOMContentLoaded",
            init
        );

    } else {

        init();
    }

})();