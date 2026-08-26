"use strict";

(function () {

    var uploadSection = null;
    var currentUser = null;
    var initialized = false;

    var I18N = {
        es: {
            title: "Subir nasheed",
            subtitle: "Tu espacio privado para crear nasheeds.",
            loginTitle: "Inicia sesión para subir",
            loginText: "Necesitas una cuenta de Nushud para subir y guardar tus propios nasheeds.",
            login: "Iniciar sesión",
            register: "Crear cuenta",
            daily: "1 subida diaria",
            private: "Solo visible para ti",
            automatic: "Subtítulos generados automáticamente",
            audio: "Archivo de audio",
            audioHelp: "MP3, M4A, WAV, OGG o formatos compatibles. Máximo 25 MB.",
            cover: "Portada",
            optional: "Opcional",
            titleLabel: "Título",
            titlePlaceholder: "Nombre del nasheed",
            languages: "Traducciones",
            arabic: "Árabe",
            arabicRequired: "Obligatorio",
            spanish: "Español",
            english: "Inglés",
            russian: "Ruso",
            submit: "Subir y generar",
            processing: "Procesando...",
            preparing: "Preparando subida...",
            uploadingAudio: "Subiendo audio...",
            uploadingCover: "Subiendo portada...",
            generating: "Generando subtítulos...",
            ready: "Nasheed generado correctamente.",
            myNasheeds: "Mis nasheeds",
            noNasheeds: "Todavía no tienes nasheeds.",
            readyStatus: "Disponible",
            processingStatus: "Procesando",
            errorStatus: "Error",
            dailyLimit: "Ya has utilizado tu subida de hoy.",
            invalid: "Completa el título y selecciona un audio.",
            server: "El servidor no devolvió una respuesta válida.",
            loginRequired: "Debes iniciar sesión.",
            privateBadge: "PRIVADO",
            todayBadge: "HOY"
        },

        en: {
            title: "Upload nasheed",
            subtitle: "Your private space to create nasheeds.",
            loginTitle: "Sign in to upload",
            loginText: "You need a Nushud account to upload and keep your own nasheeds.",
            login: "Sign in",
            register: "Create account",
            daily: "1 upload per day",
            private: "Only visible to you",
            automatic: "Subtitles generated automatically",
            audio: "Audio file",
            audioHelp: "MP3, M4A, WAV, OGG or compatible formats. Maximum 25 MB.",
            cover: "Cover",
            optional: "Optional",
            titleLabel: "Title",
            titlePlaceholder: "Nasheed name",
            languages: "Translations",
            arabic: "Arabic",
            arabicRequired: "Required",
            spanish: "Spanish",
            english: "English",
            russian: "Russian",
            submit: "Upload & generate",
            processing: "Processing...",
            preparing: "Preparing upload...",
            uploadingAudio: "Uploading audio...",
            uploadingCover: "Uploading cover...",
            generating: "Generating subtitles...",
            ready: "Nasheed generated successfully.",
            myNasheeds: "My nasheeds",
            noNasheeds: "You have no nasheeds yet.",
            readyStatus: "Available",
            processingStatus: "Processing",
            errorStatus: "Error",
            dailyLimit: "You have already used today's upload.",
            invalid: "Enter a title and select an audio file.",
            server: "The server did not return a valid response.",
            loginRequired: "You must sign in.",
            privateBadge: "PRIVATE",
            todayBadge: "TODAY"
        }
    };


    function getLanguage() {

        try {

            return localStorage.getItem(
                "nasheed_interface_language"
            ) === "en"
                ? "en"
                : "es";

        } catch {

            return "es";
        }
    }


    function T(key) {

        var language =
            getLanguage();

        return (
            I18N[language][key] ||
            I18N.es[key] ||
            key
        );
    }


    function getAuthUser() {

        if (
            window.NushudAuth &&
            typeof window.NushudAuth.getUser ===
                "function"
        ) {

            return window.NushudAuth.getUser();

        }

        return null;
    }


    function getToken() {

        return new Promise(
            function (resolve) {

                if (
                    !window.supabase ||
                    typeof window.supabase.createClient !==
                        "function"
                ) {

                    resolve(null);

                    return;
                }


                fetch(
                    "/api/public-config",
                    {
                        cache:
                            "no-store",

                        credentials:
                            "same-origin"
                    }
                )
                    .then(
                        function (response) {

                            if (
                                !response.ok
                            ) {

                                throw new Error(
                                    "No se pudo cargar Supabase."
                                );

                            }

                            return response.json();

                        }
                    )
                    .then(
                        function (config) {

                            var client =
                                window.supabase.createClient(
                                    config.supabaseUrl,
                                    config.supabasePublishableKey,
                                    {
                                        auth: {
                                            persistSession:
                                                true,

                                            autoRefreshToken:
                                                true,

                                            detectSessionInUrl:
                                                true
                                        }
                                    }
                                );

                            return client.auth.getSession();

                        }
                    )
                    .then(
                        function (result) {

                            resolve(
                                result &&
                                result.data &&
                                result.data.session
                                    ? result.data.session.access_token
                                    : null
                            );

                        }
                    )
                    .catch(
                        function () {

                            resolve(null);

                        }
                    );

            }
        );
    }


    async function apiJson(
        url,
        options
    ) {

        var response =
            await fetch(
                url,
                options || {}
            );

        var contentType =
            (
                response.headers.get(
                    "content-type"
                ) ||
                ""
            ).toLowerCase();

        var text =
            await response.text();

        if (
            !contentType.includes(
                "application/json"
            )
        ) {

            console.error(
                "[NUSHUD API HTML]",
                url,
                response.status,
                text.slice(0, 500)
            );

            throw new Error(
                T("server") +
                " HTTP " +
                response.status
            );
        }

        var data;

        try {

            data =
                JSON.parse(
                    text
                );

        } catch {

            throw new Error(
                T("server")
            );
        }

        if (
            !response.ok
        ) {

            throw new Error(
                data.error ||
                T("server")
            );
        }

        return data;
    }


    function render() {

        uploadSection =
            document.getElementById(
                "section-upload"
            );

        if (
            !uploadSection
        ) {

            return;
        }


        currentUser =
            getAuthUser();


        if (
            !currentUser
        ) {

            renderLogin();

        } else {

            renderUploader();

            loadMyNasheeds();

        }
    }


    function renderLogin() {

        uploadSection.innerHTML = `
            <div class="max-w-xl mx-auto">

                <div class="glass-panel rounded-3xl border border-white/5 overflow-hidden">

                    <div class="p-7 text-center">

                        <div
                            class="mx-auto mb-5 w-12 h-12 rounded-2xl bg-white/[.035] border border-white/10 flex items-center justify-center text-amber-400 text-lg">

                            ↑

                        </div>

                        <h2
                            class="text-base font-extrabold text-zinc-100">

                            ${escapeHtml(T("loginTitle"))}

                        </h2>

                        <p
                            class="mt-2 text-[11px] leading-relaxed text-zinc-500 max-w-sm mx-auto">

                            ${escapeHtml(T("loginText"))}

                        </p>

                        <div
                            class="mt-6 flex gap-2 justify-center">

                            <button
                                id="upload-login-button"
                                type="button"
                                class="px-4 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-zinc-950 text-[10px] font-extrabold cursor-pointer">

                                ${escapeHtml(T("login"))}

                            </button>

                            <button
                                id="upload-register-button"
                                type="button"
                                class="px-4 py-2.5 rounded-xl bg-white/[.035] hover:bg-white/[.06] text-zinc-300 border border-white/10 text-[10px] font-bold cursor-pointer">

                                ${escapeHtml(T("register"))}

                            </button>

                        </div>

                    </div>

                    <div
                        class="grid grid-cols-3 border-t border-white/5">

                        ${infoItem(
                            "1",
                            T("daily")
                        )}

                        ${infoItem(
                            "◆",
                            T("private")
                        )}

                        ${infoItem(
                            "CC",
                            T("automatic")
                        )}

                    </div>

                </div>

            </div>
        `;


        document
            .getElementById(
                "upload-login-button"
            )
            .addEventListener(
                "click",
                function () {

                    if (
                        window.NushudAuth
                    ) {

                        window.NushudAuth.open(
                            "login"
                        );
                    }
                }
            );


        document
            .getElementById(
                "upload-register-button"
            )
            .addEventListener(
                "click",
                function () {

                    if (
                        window.NushudAuth
                    ) {

                        window.NushudAuth.open(
                            "register"
                        );
                    }
                }
            );
    }


    function infoItem(
        icon,
        text
    ) {

        return `
            <div
                class="px-3 py-4 text-center">

                <div class="text-[10px] font-extrabold text-amber-400">
                    ${escapeHtml(icon)}
                </div>

                <div class="mt-1 text-[8px] leading-tight text-zinc-600">
                    ${escapeHtml(text)}
                </div>

            </div>
        `;
    }


    function renderUploader() {

        uploadSection.innerHTML = `
            <div class="max-w-xl mx-auto">

                <div
                    class="flex items-end justify-between gap-4 mb-5">

                    <div>

                        <div
                            class="flex items-center gap-2">

                            <h2
                                class="text-xl font-extrabold tracking-tight text-zinc-100">

                                ${escapeHtml(T("title"))}

                            </h2>

                            <span
                                class="px-2 py-1 rounded-lg bg-amber-500/10 border border-amber-500/15 text-[7px] font-extrabold tracking-wider text-amber-400">

                                ${escapeHtml(T("privateBadge"))}

                            </span>

                        </div>

                        <p
                            class="mt-1 text-[10px] text-zinc-500">

                            ${escapeHtml(T("subtitle"))}

                        </p>

                    </div>

                    <span
                        class="shrink-0 px-2.5 py-1 rounded-lg bg-white/[.025] border border-white/5 text-[8px] font-bold text-zinc-600">

                        ${escapeHtml(T("daily"))}

                    </span>

                </div>


                <form
                    id="nushud-user-upload-form"
                    class="glass-panel rounded-2xl border border-white/5 overflow-hidden">

                    <div class="p-5 space-y-5">

                        <div>

                            <label
                                class="block text-[9px] font-bold uppercase tracking-wider text-zinc-500">

                                ${escapeHtml(T("titleLabel"))}

                            </label>

                            <input
                                id="user-upload-title"
                                type="text"
                                maxlength="120"
                                required
                                placeholder="${escapeHtml(T("titlePlaceholder"))}"
                                class="mt-2 w-full px-3.5 py-3 rounded-xl bg-zinc-950/80 border border-white/8 text-xs text-zinc-100 placeholder:text-zinc-700 outline-none focus:border-amber-500/40">

                        </div>


                        <div>

                            <label
                                class="block text-[9px] font-bold uppercase tracking-wider text-zinc-500">

                                ${escapeHtml(T("audio"))}

                            </label>

                            <label
                                for="user-upload-audio"
                                class="mt-2 flex items-center gap-3 p-3.5 rounded-xl border border-dashed border-white/10 bg-white/[.018] hover:bg-white/[.035] cursor-pointer">

                                <span
                                    class="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/15 flex items-center justify-center text-amber-400">

                                    ♫

                                </span>

                                <span
                                    class="min-w-0">

                                    <span
                                        id="user-upload-audio-name"
                                        class="block text-[10px] font-bold text-zinc-300 truncate">

                                        ${escapeHtml(T("audio"))}

                                    </span>

                                    <span
                                        class="block mt-1 text-[8px] text-zinc-600">

                                        ${escapeHtml(T("audioHelp"))}

                                    </span>

                                </span>

                            </label>

                            <input
                                id="user-upload-audio"
                                type="file"
                                accept="audio/*,video/mp4,video/webm"
                                required
                                class="hidden">

                        </div>


                        <div>

                            <label
                                class="block text-[9px] font-bold uppercase tracking-wider text-zinc-500">

                                ${escapeHtml(T("cover"))}

                                <span class="normal-case tracking-normal text-zinc-700">
                                    · ${escapeHtml(T("optional"))}
                                </span>

                            </label>

                            <label
                                for="user-upload-cover"
                                class="mt-2 flex items-center gap-3 p-3.5 rounded-xl border border-white/7 bg-white/[.018] hover:bg-white/[.035] cursor-pointer">

                                <span
                                    class="w-9 h-9 rounded-xl bg-white/[.035] border border-white/8 flex items-center justify-center text-zinc-500">

                                    ▧

                                </span>

                                <span
                                    id="user-upload-cover-name"
                                    class="min-w-0 text-[10px] text-zinc-500 truncate">

                                    ${escapeHtml(T("cover"))}

                                </span>

                            </label>

                            <input
                                id="user-upload-cover"
                                type="file"
                                accept="image/jpeg,image/png,image/webp"
                                class="hidden">

                        </div>


                        <div>

                            <div
                                class="flex items-center justify-between">

                                <label
                                    class="block text-[9px] font-bold uppercase tracking-wider text-zinc-500">

                                    ${escapeHtml(T("languages"))}

                                </label>

                            </div>

                            <div
                                class="mt-2 grid grid-cols-3 gap-2">

                                <label
                                    class="flex items-center gap-2 p-2.5 rounded-xl bg-amber-500/[.045] border border-amber-500/10 cursor-default">

                                    <input
                                        type="checkbox"
                                        checked
                                        disabled
                                        class="accent-amber-500">

                                    <span
                                        class="min-w-0">

                                        <span
                                            class="block text-[9px] font-bold text-zinc-300">

                                            ${escapeHtml(T("arabic"))}

                                        </span>

                                        <span
                                            class="block text-[7px] text-amber-500/70">

                                            ${escapeHtml(T("arabicRequired"))}

                                        </span>

                                    </span>

                                </label>


                                ${languageCheck(
                                    "user-upload-es",
                                    T("spanish"),
                                    true
                                )}

                                ${languageCheck(
                                    "user-upload-en",
                                    T("english"),
                                    false
                                )}

                                ${languageCheck(
                                    "user-upload-ru",
                                    T("russian"),
                                    false
                                )}

                            </div>

                        </div>

                    </div>


                    <div
                        class="border-t border-white/5 px-5 py-4">

                        <button
                            id="user-upload-submit"
                            type="submit"
                            class="w-full py-3 rounded-xl bg-amber-500 hover:bg-amber-400 text-zinc-950 text-[10px] font-extrabold shadow-lg shadow-amber-500/10 disabled:opacity-50 disabled:cursor-not-allowed">

                            ${escapeHtml(T("submit"))}

                        </button>

                        <div
                            id="user-upload-status"
                            class="min-h-[16px] mt-3 text-center text-[9px] text-zinc-600">

                        </div>

                    </div>

                </form>


                <div class="mt-7">

                    <div
                        class="flex items-center justify-between mb-3">

                        <h3
                            class="text-[9px] font-extrabold uppercase tracking-widest text-zinc-500">

                            ${escapeHtml(T("myNasheeds"))}

                        </h3>

                        <span
                            class="text-[8px] text-zinc-700">

                            ${escapeHtml(T("privateBadge"))}

                        </span>

                    </div>

                    <div
                        id="user-upload-list"
                        class="space-y-2">

                    </div>

                </div>

            </div>
        `;


        var form =
            document.getElementById(
                "nushud-user-upload-form"
            );

        form.addEventListener(
            "submit",
            handleSubmit
        );


        var audioInput =
            document.getElementById(
                "user-upload-audio"
            );

        audioInput.addEventListener(
            "change",
            function () {

                var element =
                    document.getElementById(
                        "user-upload-audio-name"
                    );

                if (
                    this.files &&
                    this.files[0]
                ) {

                    element.textContent =
                        this.files[0].name;

                    element.className =
                        "block text-[10px] font-bold text-amber-400 truncate";

                }

            }
        );


        var coverInput =
            document.getElementById(
                "user-upload-cover"
            );

        coverInput.addEventListener(
            "change",
            function () {

                var element =
                    document.getElementById(
                        "user-upload-cover-name"
                    );

                if (
                    this.files &&
                    this.files[0]
                ) {

                    element.textContent =
                        this.files[0].name;

                    element.className =
                        "min-w-0 text-[10px] text-amber-400 truncate";

                }

            }
        );
    }


    function languageCheck(
        id,
        label,
        checked
    ) {

        return `
            <label
                class="flex items-center gap-2 p-2.5 rounded-xl bg-white/[.018] border border-white/7 cursor-pointer hover:bg-white/[.035]">

                <input
                    id="${id}"
                    type="checkbox"
                    ${checked ? "checked" : ""}
                    class="accent-amber-500">

                <span class="text-[9px] font-semibold text-zinc-400">
                    ${escapeHtml(label)}
                </span>

            </label>
        `;
    }


    async function handleSubmit(
        event
    ) {

        event.preventDefault();


        if (
            !currentUser
        ) {

            render();

            return;
        }


        var title =
            document.getElementById(
                "user-upload-title"
            )
                .value
                .trim();


        var audio =
            document.getElementById(
                "user-upload-audio"
            )
                .files[0];


        var cover =
            document.getElementById(
                "user-upload-cover"
            )
                .files[0] ||
            null;


        var translations =
            [];


        if (
            document.getElementById(
                "user-upload-es"
            )
                .checked
        ) {

            translations.push(
                "es"
            );
        }


        if (
            document.getElementById(
                "user-upload-en"
            )
                .checked
        ) {

            translations.push(
                "en"
            );
        }


        if (
            document.getElementById(
                "user-upload-ru"
            )
                .checked
        ) {

            translations.push(
                "ru"
            );
        }


        if (
            !title ||
            !audio
        ) {

            setStatus(
                T("invalid"),
                true
            );

            return;
        }


        var button =
            document.getElementById(
                "user-upload-submit"
            );


        button.disabled =
            true;


        try {

            var token =
                await getToken();


            if (
                !token
            ) {

                throw new Error(
                    T("loginRequired")
                );
            }


            setStatus(
                T("preparing")
            );


            var prepared =
                await apiJson(
                    "/api/user-nasheeds/prepare",
                    {
                        method:
                            "POST",

                        headers: {
                            "Content-Type":
                                "application/json",

                            "Authorization":
                                "Bearer " +
                                token
                        },

                        body:
                            JSON.stringify({
                                title,

                                translations,

                                audio: {
                                    name:
                                        audio.name,

                                    type:
                                        audio.type,

                                    size:
                                        audio.size
                                },

                                cover:
                                    cover
                                        ? {
                                            name:
                                                cover.name,

                                            type:
                                                cover.type,

                                            size:
                                                cover.size
                                        }
                                        : null
                            })
                    }
                );


            if (
                !window.supabase ||
                typeof window.supabase.createClient !==
                    "function"
            ) {

                throw new Error(
                    "Supabase no está disponible."
                );
            }


            var configResponse =
                await fetch(
                    "/api/public-config",
                    {
                        cache:
                            "no-store"
                    }
                );


            if (
                !configResponse.ok
            ) {

                throw new Error(
                    T("server")
                );
            }


            var config =
                await configResponse.json();


            var client =
                window.supabase.createClient(
                    config.supabaseUrl,
                    config.supabasePublishableKey,
                    {
                        auth: {
                            persistSession:
                                true,

                            autoRefreshToken:
                                true,

                            detectSessionInUrl:
                                true
                        }
                    }
                );


            setStatus(
                T("uploadingAudio")
            );


            var audioUpload =
                await client
                    .storage
                    .from(
                        "UserNasheeds"
                    )
                    .uploadToSignedUrl(
                        prepared.audio.path,
                        prepared.audio.token,
                        audio
                    );


            if (
                audioUpload.error
            ) {

                throw audioUpload.error;
            }


            if (
                prepared.cover &&
                cover
            ) {

                setStatus(
                    T("uploadingCover")
                );


                var coverUpload =
                    await client
                        .storage
                        .from(
                            "UserNasheeds"
                        )
                        .uploadToSignedUrl(
                            prepared.cover.path,
                            prepared.cover.token,
                            cover
                        );


                if (
                    coverUpload.error
                ) {

                    throw coverUpload.error;
                }
            }


            setStatus(
                T("generating")
            );


            await apiJson(
                "/api/user-nasheeds/" +
                encodeURIComponent(
                    prepared.id
                ) +
                "/process",
                {
                    method:
                        "POST",

                    headers: {
                        "Authorization":
                            "Bearer " +
                            token
                    }
                }
            );


            setStatus(
                T("ready")
            );


            document.getElementById(
                "user-upload-title"
            ).value =
                "";

            document.getElementById(
                "user-upload-audio"
            ).value =
                "";

            document.getElementById(
                "user-upload-cover"
            ).value =
                "";


            document.getElementById(
                "user-upload-audio-name"
            ).textContent =
                T("audio");


            document.getElementById(
                "user-upload-cover-name"
            ).textContent =
                T("cover");


            await loadMyNasheeds();


            if (
                typeof window.fetchNasheeds ===
                "function"
            ) {

                window.fetchNasheeds();

            }

        } catch (
            error
        ) {

            console.error(
                "[NUSHUD USER UPLOAD]",
                error
            );

            setStatus(
                error.message ||
                T("server"),
                true
            );

        } finally {

            button.disabled =
                false;

        }
    }


    function setStatus(
        message,
        error
    ) {

        var element =
            document.getElementById(
                "user-upload-status"
            );

        if (
            !element
        ) {

            return;
        }


        element.textContent =
            message ||
            "";


        element.className =
            "min-h-[16px] mt-3 text-center text-[9px] " +
            (
                error
                    ? "text-red-400"
                    : "text-zinc-600"
            );
    }


    async function loadMyNasheeds() {

        var list =
            document.getElementById(
                "user-upload-list"
            );


        if (
            !list ||
            !currentUser
        ) {

            return;
        }


        try {

            var token =
                await getToken();


            if (
                !token
            ) {

                return;
            }


            var data =
                await apiJson(
                    "/api/user-nasheeds",
                    {
                        method:
                            "GET",

                        headers: {
                            "Authorization":
                                "Bearer " +
                                token
                        },

                        cache:
                            "no-store"
                    }
                );


            list.innerHTML =
                "";


            if (
                !data.nasheeds ||
                !data.nasheeds.length
            ) {

                list.innerHTML =
                    `
                        <div
                            class="rounded-xl border border-white/5 bg-white/[.018] px-4 py-3 text-[9px] text-zinc-700 text-center">

                            ${escapeHtml(
                                T("noNasheeds")
                            )}

                        </div>
                    `;

                return;
            }


            data.nasheeds.forEach(
                function (
                    item
                ) {

                    var row =
                        document.createElement(
                            "div"
                        );


                    row.className =
                        "flex items-center justify-between gap-3 rounded-xl border border-white/5 bg-white/[.018] px-3.5 py-3";


                    var left =
                        document.createElement(
                            "div"
                        );


                    left.className =
                        "min-w-0";


                    var title =
                        document.createElement(
                            "div"
                        );


                    title.className =
                        "truncate text-[10px] font-bold text-zinc-300";


                    title.textContent =
                        item.title;


                    var status =
                        document.createElement(
                            "div"
                        );


                    status.className =
                        "mt-1 text-[8px] text-zinc-700";


                    if (
                        item.status ===
                        "ready"
                    ) {

                        status.textContent =
                            T("readyStatus");

                        status.className =
                            "mt-1 text-[8px] text-amber-500/60";

                    } else if (
                        item.status ===
                        "processing"
                    ) {

                        status.textContent =
                            T("processingStatus");

                    } else {

                        status.textContent =
                            T("errorStatus");

                        status.className =
                            "mt-1 text-[8px] text-red-500/70";

                    }


                    left.appendChild(
                        title
                    );

                    left.appendChild(
                        status
                    );


                    var badge =
                        document.createElement(
                            "span"
                        );


                    badge.className =
                        "shrink-0 text-[7px] font-extrabold tracking-wider text-zinc-700";


                    badge.textContent =
                        item.upload_day ===
                            new Date()
                                .toISOString()
                                .slice(
                                    0,
                                    10
                                )
                            ? T("todayBadge")
                            : "";


                    row.appendChild(
                        left
                    );

                    row.appendChild(
                        badge
                    );

                    list.appendChild(
                        row
                    );

                }
            );

        } catch (
            error
        ) {

            console.error(
                "[NUSHUD USER NASHEEDS]",
                error
            );

            list.innerHTML =
                `
                    <div
                        class="rounded-xl border border-red-500/10 bg-red-500/[.03] px-4 py-3 text-[9px] text-red-400">

                        ${escapeHtml(
                            error.message ||
                            T("server")
                        )}

                    </div>
                `;
        }
    }


    function escapeHtml(
        value
    ) {

        var div =
            document.createElement(
                "div"
            );

        div.textContent =
            String(
                value == null
                    ? ""
                    : value
            );

        return div.innerHTML;
    }


    function initialize() {

        if (
            initialized
        ) {

            render();

            return;
        }


        initialized =
            true;


        render();


        window.addEventListener(
            "nushud-auth-changed",
            function () {

                currentUser =
                    getAuthUser();

                render();

            }
        );


        window.addEventListener(
            "nushud-language-changed",
            function () {

                render();

            }
        );
    }


    if (
        document.readyState ===
        "loading"
    ) {

        document.addEventListener(
            "DOMContentLoaded",
            initialize,
            {
                once:
                    true
            }
        );

    } else {

        initialize();

    }

})();