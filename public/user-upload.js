"use strict";

(function () {

    /* =========================================================
       ESTADO
       ========================================================= */

    let currentUser = null;
    let initialized = false;
    let uploadSection = null;


    /* =========================================================
       IDIOMAS
       ========================================================= */

    const I18N = {

        es: {

            title:
                "Subir nasheed",

            subtitle:
                "Tu espacio privado para crear nasheeds.",

            loginTitle:
                "Inicia sesión para subir",

            loginText:
                "Necesitas una cuenta de Nushud para subir y conservar tus propios nasheeds.",

            login:
                "Iniciar sesión",

            register:
                "Crear cuenta",

            daily:
                "1 subida diaria",

            private:
                "Solo visible para ti",

            automatic:
                "Subtítulos automáticos",

            audio:
                "Archivo de audio",

            audioHelp:
                "MP3, M4A, WAV, OGG o formatos compatibles. Máximo 25 MB.",

            cover:
                "Portada",

            optional:
                "Opcional",

            titleLabel:
                "Título",

            titlePlaceholder:
                "Nombre del nasheed",

            languages:
                "Traducciones",

            arabic:
                "Árabe",

            arabicRequired:
                "Obligatorio",

            spanish:
                "Español",

            english:
                "Inglés",

            russian:
                "Ruso",

            submit:
                "Subir y generar",

            preparing:
                "Preparando subida...",

            uploadingAudio:
                "Subiendo audio...",

            uploadingCover:
                "Subiendo portada...",

            generating:
                "Generando subtítulos...",

            ready:
                "Nasheed generado correctamente.",

            myNasheeds:
                "Mis nasheeds",

            noNasheeds:
                "Todavía no tienes nasheeds.",

            readyStatus:
                "Disponible",

            processingStatus:
                "Procesando",

            errorStatus:
                "Error",

            privateBadge:
                "PRIVADO",

            todayBadge:
                "HOY",

            invalid:
                "Completa el título y selecciona un audio.",

            loginRequired:
                "Debes iniciar sesión.",

            server:
                "El servidor no devolvió una respuesta válida.",

            refresh:
                "Actualizar",

            play:
                "Reproducir"

        },

        en: {

            title:
                "Upload nasheed",

            subtitle:
                "Your private space to create nasheeds.",

            loginTitle:
                "Sign in to upload",

            loginText:
                "You need a Nushud account to upload and keep your own nasheeds.",

            login:
                "Sign in",

            register:
                "Create account",

            daily:
                "1 upload per day",

            private:
                "Only visible to you",

            automatic:
                "Automatic subtitles",

            audio:
                "Audio file",

            audioHelp:
                "MP3, M4A, WAV, OGG or compatible formats. Maximum 25 MB.",

            cover:
                "Cover",

            optional:
                "Optional",

            titleLabel:
                "Title",

            titlePlaceholder:
                "Nasheed name",

            languages:
                "Translations",

            arabic:
                "Arabic",

            arabicRequired:
                "Required",

            spanish:
                "Spanish",

            english:
                "English",

            russian:
                "Russian",

            submit:
                "Upload & generate",

            preparing:
                "Preparing upload...",

            uploadingAudio:
                "Uploading audio...",

            uploadingCover:
                "Uploading cover...",

            generating:
                "Generating subtitles...",

            ready:
                "Nasheed generated successfully.",

            myNasheeds:
                "My nasheeds",

            noNasheeds:
                "You do not have any nasheeds yet.",

            readyStatus:
                "Available",

            processingStatus:
                "Processing",

            errorStatus:
                "Error",

            privateBadge:
                "PRIVATE",

            todayBadge:
                "TODAY",

            invalid:
                "Enter a title and select an audio file.",

            loginRequired:
                "You must sign in.",

            server:
                "The server did not return a valid response.",

            refresh:
                "Refresh",

            play:
                "Play"

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


    function t(
        key
    ) {

        const language =
            getLanguage();

        return (
            I18N[language]?.[key] ||
            I18N.es[key] ||
            key
        );

    }


    /* =========================================================
       USUARIO
       ========================================================= */

    function getCurrentUser() {

        if (
            window.NushudAuth &&
            typeof window.NushudAuth.getUser ===
                "function"
        ) {

            return (
                window.NushudAuth.getUser() ||
                null
            );

        }

        return null;

    }


    /* =========================================================
       TOKEN SUPABASE
       ========================================================= */

    async function getAccessToken() {

        if (
            !window.supabase ||
            typeof window.supabase.createClient !==
                "function"
        ) {

            return null;

        }


        const response =
            await fetch(
                "/api/public-config",
                {
                    method:
                        "GET",

                    credentials:
                        "same-origin",

                    cache:
                        "no-store"
                }
            );


        if (
            !response.ok
        ) {

            return null;

        }


        const config =
            await response.json();


        if (
            !config.supabaseUrl ||
            !config.supabasePublishableKey
        ) {

            return null;

        }


        const client =
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


        const {
            data,
            error
        } =
            await client.auth.getSession();


        if (
            error
        ) {

            console.error(
                "[NUSHUD USER UPLOAD SESSION]",
                error
            );

            return null;

        }


        return (
            data?.session?.access_token ||
            null
        );

    }


    /* =========================================================
       API JSON
       ========================================================= */

    async function apiJson(
        url,
        options = {}
    ) {

        const response =
            await fetch(
                url,
                options
            );


        const contentType =
            (
                response.headers.get(
                    "content-type"
                ) ||
                ""
            ).toLowerCase();


        const text =
            await response.text();


        if (
            !contentType.includes(
                "application/json"
            )
        ) {

            console.error(
                "[NUSHUD API NON JSON]",
                url,
                response.status,
                text.slice(
                    0,
                    1000
                )
            );


            throw new Error(
                `${t("server")} HTTP ${response.status}`
            );

        }


        let data;


        try {

            data =
                JSON.parse(
                    text
                );

        } catch {

            throw new Error(
                t("server")
            );

        }


        if (
            !response.ok
        ) {

            throw new Error(
                data?.error ||
                t("server")
            );

        }


        return data;

    }


    /* =========================================================
       ESCAPE
       ========================================================= */

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


    /* =========================================================
       INICIALIZAR
       ========================================================= */

    function init() {

        if (
            initialized
        ) {

            render();

            return;

        }


        initialized =
            true;


        uploadSection =
            document.getElementById(
                "section-upload"
            );


        if (
            !uploadSection
        ) {

            console.warn(
                "[NUSHUD] No existe #section-upload"
            );

            return;

        }


        render();


        /*
         * Cuando auth.js cambie de usuario,
         * reconstruimos completamente la sección.
         */

        window.addEventListener(
            "nushud-auth-changed",
            function () {

                currentUser =
                    getCurrentUser();

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


    /* =========================================================
       RENDER PRINCIPAL
       ========================================================= */

    function render() {

        if (
            !uploadSection
        ) {

            uploadSection =
                document.getElementById(
                    "section-upload"
                );

        }


        if (
            !uploadSection
        ) {

            return;

        }


        currentUser =
            getCurrentUser();


        if (
            currentUser
        ) {

            renderUploader();

            loadMyNasheeds();

        } else {

            renderLogin();

        }

    }


    /* =========================================================
       LOGIN
       ========================================================= */

    function renderLogin() {

        uploadSection.innerHTML = `

            <div class="max-w-xl mx-auto">

                <div
                    class="glass-panel rounded-3xl border border-white/5 overflow-hidden">

                    <div class="p-8 text-center">

                        <div
                            class="mx-auto w-12 h-12 rounded-2xl bg-white/[.035] border border-white/10 flex items-center justify-center text-amber-400 text-lg">

                            ↑

                        </div>


                        <h2
                            class="mt-5 text-base font-extrabold text-zinc-100">

                            ${escapeHtml(
                                t("loginTitle")
                            )}

                        </h2>


                        <p
                            class="mt-2 max-w-sm mx-auto text-[10px] leading-relaxed text-zinc-500">

                            ${escapeHtml(
                                t("loginText")
                            )}

                        </p>


                        <div
                            class="mt-6 flex justify-center gap-2">

                            <button
                                id="user-upload-login"
                                type="button"
                                class="px-4 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-zinc-950 text-[10px] font-extrabold cursor-pointer">

                                ${escapeHtml(
                                    t("login")
                                )}

                            </button>


                            <button
                                id="user-upload-register"
                                type="button"
                                class="px-4 py-2.5 rounded-xl bg-white/[.035] hover:bg-white/[.06] text-zinc-300 border border-white/10 text-[10px] font-bold cursor-pointer">

                                ${escapeHtml(
                                    t("register")
                                )}

                            </button>

                        </div>

                    </div>


                    <div
                        class="grid grid-cols-3 border-t border-white/5">

                        <div
                            class="py-4 text-center">

                            <div
                                class="text-[10px] font-extrabold text-amber-400">

                                1

                            </div>

                            <div
                                class="mt-1 text-[8px] text-zinc-700">

                                ${escapeHtml(
                                    t("daily")
                                )}

                            </div>

                        </div>


                        <div
                            class="py-4 text-center">

                            <div
                                class="text-[10px] font-extrabold text-amber-400">

                                ◆

                            </div>

                            <div
                                class="mt-1 text-[8px] text-zinc-700">

                                ${escapeHtml(
                                    t("private")
                                )}

                            </div>

                        </div>


                        <div
                            class="py-4 text-center">

                            <div
                                class="text-[10px] font-extrabold text-amber-400">

                                CC

                            </div>

                            <div
                                class="mt-1 text-[8px] text-zinc-700">

                                ${escapeHtml(
                                    t("automatic")
                                )}

                            </div>

                        </div>

                    </div>

                </div>

            </div>
        `;


        document
            .getElementById(
                "user-upload-login"
            )
            ?.addEventListener(
                "click",
                function () {

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
            );


        document
            .getElementById(
                "user-upload-register"
            )
            ?.addEventListener(
                "click",
                function () {

                    if (
                        window.NushudAuth &&
                        typeof window.NushudAuth.open ===
                            "function"
                    ) {

                        window.NushudAuth.open(
                            "register"
                        );

                    }

                }
            );

    }


    /* =========================================================
       UPLOADER
       ========================================================= */

    function renderUploader() {

        uploadSection.innerHTML = `

            <div
                class="max-w-xl mx-auto">

                <div
                    class="flex items-end justify-between gap-4 mb-5">

                    <div>

                        <div
                            class="flex items-center gap-2">

                            <h2
                                class="text-xl font-extrabold tracking-tight text-zinc-100">

                                ${escapeHtml(
                                    t("title")
                                )}

                            </h2>


                            <span
                                class="px-2 py-1 rounded-lg bg-amber-500/10 border border-amber-500/15 text-[7px] font-extrabold tracking-wider text-amber-400">

                                ${escapeHtml(
                                    t("privateBadge")
                                )}

                            </span>

                        </div>


                        <p
                            class="mt-1 text-[10px] text-zinc-500">

                            ${escapeHtml(
                                t("subtitle")
                            )}

                        </p>

                    </div>


                    <span
                        class="shrink-0 px-2.5 py-1 rounded-lg bg-white/[.025] border border-white/5 text-[8px] font-bold text-zinc-600">

                        ${escapeHtml(
                            t("daily")
                        )}

                    </span>

                </div>


                <form
                    id="nushud-user-upload-form"
                    class="glass-panel rounded-2xl border border-white/5 overflow-hidden">

                    <div
                        class="p-5 space-y-5">


                        <!-- TÍTULO -->

                        <div>

                            <label
                                for="user-upload-title"
                                class="block text-[9px] font-bold uppercase tracking-wider text-zinc-500">

                                ${escapeHtml(
                                    t("titleLabel")
                                )}

                            </label>


                            <input
                                id="user-upload-title"
                                type="text"
                                maxlength="120"
                                required
                                placeholder="${escapeHtml(
                                    t("titlePlaceholder")
                                )}"
                                class="mt-2 w-full px-3.5 py-3 rounded-xl bg-zinc-950/80 border border-white/8 text-xs text-zinc-100 placeholder:text-zinc-700 outline-none focus:border-amber-500/40">

                        </div>


                        <!-- AUDIO -->

                        <div>

                            <label
                                class="block text-[9px] font-bold uppercase tracking-wider text-zinc-500">

                                ${escapeHtml(
                                    t("audio")
                                )}

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

                                        ${escapeHtml(
                                            t("audio")
                                        )}

                                    </span>


                                    <span
                                        class="block mt-1 text-[8px] text-zinc-600">

                                        ${escapeHtml(
                                            t("audioHelp")
                                        )}

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


                        <!-- PORTADA -->

                        <div>

                            <label
                                class="block text-[9px] font-bold uppercase tracking-wider text-zinc-500">

                                ${escapeHtml(
                                    t("cover")
                                )}

                                <span
                                    class="normal-case tracking-normal text-zinc-700">

                                    · ${escapeHtml(
                                        t("optional")
                                    )}

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

                                    ${escapeHtml(
                                        t("cover")
                                    )}

                                </span>

                            </label>


                            <input
                                id="user-upload-cover"
                                type="file"
                                accept="image/jpeg,image/png,image/webp"
                                class="hidden">

                        </div>


                        <!-- IDIOMAS -->

                        <div>

                            <label
                                class="block text-[9px] font-bold uppercase tracking-wider text-zinc-500">

                                ${escapeHtml(
                                    t("languages")
                                )}

                            </label>


                            <div
                                class="mt-2 grid grid-cols-3 gap-2">

                                <label
                                    class="flex items-center gap-2 p-2.5 rounded-xl bg-amber-500/[.045] border border-amber-500/10">

                                    <input
                                        type="checkbox"
                                        checked
                                        disabled
                                        class="accent-amber-500">

                                    <span>

                                        <span
                                            class="block text-[9px] font-bold text-zinc-300">

                                            ${escapeHtml(
                                                t("arabic")
                                            )}

                                        </span>


                                        <span
                                            class="block text-[7px] text-amber-500/70">

                                            ${escapeHtml(
                                                t("arabicRequired")
                                            )}

                                        </span>

                                    </span>

                                </label>


                                <label
                                    class="flex items-center gap-2 p-2.5 rounded-xl bg-white/[.018] border border-white/7 cursor-pointer hover:bg-white/[.035]">

                                    <input
                                        id="user-upload-es"
                                        type="checkbox"
                                        checked
                                        class="accent-amber-500">

                                    <span
                                        class="text-[9px] font-semibold text-zinc-400">

                                        ${escapeHtml(
                                            t("spanish")
                                        )}

                                    </span>

                                </label>


                                <label
                                    class="flex items-center gap-2 p-2.5 rounded-xl bg-white/[.018] border border-white/7 cursor-pointer hover:bg-white/[.035]">

                                    <input
                                        id="user-upload-en"
                                        type="checkbox"
                                        class="accent-amber-500">

                                    <span
                                        class="text-[9px] font-semibold text-zinc-400">

                                        ${escapeHtml(
                                            t("english")
                                        )}

                                    </span>

                                </label>


                                <label
                                    class="flex items-center gap-2 p-2.5 rounded-xl bg-white/[.018] border border-white/7 cursor-pointer hover:bg-white/[.035]">

                                    <input
                                        id="user-upload-ru"
                                        type="checkbox"
                                        class="accent-amber-500">

                                    <span
                                        class="text-[9px] font-semibold text-zinc-400">

                                        ${escapeHtml(
                                            t("russian")
                                        )}

                                    </span>

                                </label>

                            </div>

                        </div>


                    </div>


                    <div
                        class="border-t border-white/5 px-5 py-4">

                        <button
                            id="user-upload-submit"
                            type="submit"
                            class="w-full py-3 rounded-xl bg-amber-500 hover:bg-amber-400 text-zinc-950 text-[10px] font-extrabold shadow-lg shadow-amber-500/10 disabled:opacity-50 disabled:cursor-not-allowed">

                            ${escapeHtml(
                                t("submit")
                            )}

                        </button>


                        <div
                            id="user-upload-status"
                            class="min-h-[17px] mt-3 text-center text-[9px] text-zinc-600">

                        </div>

                    </div>

                </form>


                <!-- MIS NASHEEDS -->

                <div
                    class="mt-7">

                    <div
                        class="flex items-center justify-between mb-3">

                        <h3
                            class="text-[9px] font-extrabold uppercase tracking-widest text-zinc-500">

                            ${escapeHtml(
                                t("myNasheeds")
                            )}

                        </h3>


                        <span
                            class="text-[8px] text-zinc-700">

                            ${escapeHtml(
                                t("privateBadge")
                            )}

                        </span>

                    </div>


                    <div
                        id="user-upload-list"
                        class="space-y-2">

                    </div>

                </div>

            </div>
        `;


        bindUploader();

    }


    /* =========================================================
       EVENTOS DEL FORMULARIO
       ========================================================= */

    function bindUploader() {

        const form =
            document.getElementById(
                "nushud-user-upload-form"
            );


        const audioInput =
            document.getElementById(
                "user-upload-audio"
            );


        const coverInput =
            document.getElementById(
                "user-upload-cover"
            );


        if (
            form
        ) {

            form.addEventListener(
                "submit",
                handleSubmit
            );

        }


        if (
            audioInput
        ) {

            audioInput.addEventListener(
                "change",
                function () {

                    const name =
                        document.getElementById(
                            "user-upload-audio-name"
                        );


                    if (
                        this.files &&
                        this.files[0]
                    ) {

                        name.textContent =
                            this.files[0].name;

                        name.className =
                            "block text-[10px] font-bold text-amber-400 truncate";

                    }

                }
            );

        }


        if (
            coverInput
        ) {

            coverInput.addEventListener(
                "change",
                function () {

                    const name =
                        document.getElementById(
                            "user-upload-cover-name"
                        );


                    if (
                        this.files &&
                        this.files[0]
                    ) {

                        name.textContent =
                            this.files[0].name;

                        name.className =
                            "min-w-0 text-[10px] text-amber-400 truncate";

                    }

                }
            );

        }

    }


    /* =========================================================
       SUBIR
       ========================================================= */

    async function handleSubmit(
        event
    ) {

        event.preventDefault();


        currentUser =
            getCurrentUser();


        if (
            !currentUser
        ) {

            render();

            return;

        }


        const titleInput =
            document.getElementById(
                "user-upload-title"
            );


        const audioInput =
            document.getElementById(
                "user-upload-audio"
            );


        const coverInput =
            document.getElementById(
                "user-upload-cover"
            );


        const submitButton =
            document.getElementById(
                "user-upload-submit"
            );


        const title =
            String(
                titleInput?.value ||
                ""
            ).trim();


        const audio =
            audioInput?.files?.[0] ||
            null;


        const cover =
            coverInput?.files?.[0] ||
            null;


        if (
            !title ||
            !audio
        ) {

            setStatus(
                t("invalid"),
                true
            );

            return;

        }


        const translations =
            [];


        if (
            document.getElementById(
                "user-upload-es"
            )?.checked
        ) {

            translations.push(
                "es"
            );

        }


        if (
            document.getElementById(
                "user-upload-en"
            )?.checked
        ) {

            translations.push(
                "en"
            );

        }


        if (
            document.getElementById(
                "user-upload-ru"
            )?.checked
        ) {

            translations.push(
                "ru"
            );

        }


        if (
            submitButton
        ) {

            submitButton.disabled =
                true;

        }


        try {

            const token =
                await getAccessToken();


            if (
                !token
            ) {

                throw new Error(
                    t("loginRequired")
                );

            }


            setStatus(
                t("preparing")
            );


            /* =================================================
               PREPARAR
               ================================================= */

            const prepared =
                await apiJson(
                    "/api/user-nasheeds/prepare",
                    {

                        method:
                            "POST",

                        credentials:
                            "same-origin",

                        headers: {

                            "Content-Type":
                                "application/json",

                            Authorization:
                                `Bearer ${token}`

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


            /* =================================================
               CONFIG SUPABASE
               ================================================= */

            const configResponse =
                await fetch(
                    "/api/public-config",
                    {

                        method:
                            "GET",

                        credentials:
                            "same-origin",

                        cache:
                            "no-store"

                    }
                );


            if (
                !configResponse.ok
            ) {

                throw new Error(
                    t("server")
                );

            }


            const config =
                await configResponse.json();


            if (
                !config.supabaseUrl ||
                !config.supabasePublishableKey
            ) {

                throw new Error(
                    t("server")
                );

            }


            const client =
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


            /* =================================================
               SUBIR AUDIO
               ================================================= */

            setStatus(
                t("uploadingAudio")
            );


            const audioUpload =
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


            /* =================================================
               SUBIR PORTADA
               ================================================= */

            if (
                prepared.cover &&
                cover
            ) {

                setStatus(
                    t("uploadingCover")
                );


                const coverUpload =
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


            /* =================================================
               PROCESAR IA
               ================================================= */

            setStatus(
                t("generating")
            );


            await apiJson(
                `/api/user-nasheeds/${encodeURIComponent(
                    prepared.id
                )}/process`,
                {

                    method:
                        "POST",

                    credentials:
                        "same-origin",

                    headers: {

                        Authorization:
                            `Bearer ${token}`

                    }

                }
            );


            /* =================================================
               LIMPIAR FORMULARIO
               ================================================= */

            if (
                titleInput
            ) {

                titleInput.value =
                    "";

            }


            if (
                audioInput
            ) {

                audioInput.value =
                    "";

            }


            if (
                coverInput
            ) {

                coverInput.value =
                    "";

            }


            const audioName =
                document.getElementById(
                    "user-upload-audio-name"
                );


            const coverName =
                document.getElementById(
                    "user-upload-cover-name"
                );


            if (
                audioName
            ) {

                audioName.textContent =
                    t("audio");

                audioName.className =
                    "block text-[10px] font-bold text-zinc-300 truncate";

            }


            if (
                coverName
            ) {

                coverName.textContent =
                    t("cover");

                coverName.className =
                    "min-w-0 text-[10px] text-zinc-500 truncate";

            }


            setStatus(
                t("ready"),
                false
            );


            /* =================================================
               RECARGAR MIS NASHEEDS
               ================================================= */

            await loadMyNasheeds();


            /* =================================================
               RECARGAR LA BIBLIOTECA PRINCIPAL
               ================================================= */

            if (
                typeof window.fetchNasheeds ===
                    "function"
            ) {

                await window.fetchNasheeds();

            }


        } catch (
            error
        ) {

            console.error(
                "[NUSHUD USER UPLOAD]",
                error
            );


            setStatus(
                error?.message ||
                t("server"),
                true
            );

        } finally {

            if (
                submitButton
            ) {

                submitButton.disabled =
                    false;

            }

        }

    }


    /* =========================================================
       ESTADO DEL FORMULARIO
       ========================================================= */

    function setStatus(
        message,
        isError
    ) {

        const element =
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
            "min-h-[17px] mt-3 text-center text-[9px] " +
            (
                isError
                    ? "text-red-400"
                    : "text-zinc-600"
            );

    }


    /* =========================================================
       CARGAR MIS NASHEEDS
       ========================================================= */

    async function loadMyNasheeds() {

        const list =
            document.getElementById(
                "user-upload-list"
            );


        if (
            !list
        ) {

            return;

        }


        currentUser =
            getCurrentUser();


        if (
            !currentUser
        ) {

            list.innerHTML =
                "";

            return;

        }


        try {

            const token =
                await getAccessToken();


            if (
                !token
            ) {

                return;

            }


            const data =
                await apiJson(
                    "/api/user-nasheeds",
                    {

                        method:
                            "GET",

                        credentials:
                            "same-origin",

                        cache:
                            "no-store",

                        headers: {

                            Authorization:
                                `Bearer ${token}`

                        }

                    }
                );


            list.innerHTML =
                "";


            const items =
                Array.isArray(
                    data?.nasheeds
                )
                    ? data.nasheeds
                    : [];


            if (
                !items.length
            ) {

                list.innerHTML = `

                    <div
                        class="rounded-xl border border-white/5 bg-white/[.018] px-4 py-3 text-[9px] text-zinc-700 text-center">

                        ${escapeHtml(
                            t("noNasheeds")
                        )}

                    </div>

                `;

                return;

            }


            for (
                const item of
                items
            ) {

                list.appendChild(
                    createMyNasheedRow(
                        item
                    )
                );

            }

        } catch (
            error
        ) {

            console.error(
                "[NUSHUD USER NASHEEDS]",
                error
            );


            list.innerHTML = `

                <div
                    class="rounded-xl border border-red-500/10 bg-red-500/[.03] px-4 py-3 text-[9px] text-red-400">

                    ${escapeHtml(
                        error?.message ||
                        t("server")
                    )}

                </div>

            `;

        }

    }


    /* =========================================================
       FILA DE MIS NASHEEDS
       ========================================================= */

    function createMyNasheedRow(
        item
    ) {

        const row =
            document.createElement(
                "div"
            );


        row.className =
            "flex items-center justify-between gap-3 rounded-xl border border-white/5 bg-white/[.018] px-3.5 py-3";


        const left =
            document.createElement(
                "div"
            );


        left.className =
            "min-w-0 flex-1";


        const title =
            document.createElement(
                "div"
            );


        title.className =
            "truncate text-[10px] font-bold text-zinc-300";


        title.textContent =
            item.title ||
            "Nasheed";


        const status =
            document.createElement(
                "div"
            );


        status.className =
            "mt-1 text-[8px]";


        if (
            item.status ===
            "ready"
        ) {

            status.textContent =
                t("readyStatus");

            status.classList.add(
                "text-amber-500/70"
            );

        } else if (
            item.status ===
            "processing"
        ) {

            status.textContent =
                t("processingStatus");

            status.classList.add(
                "text-zinc-600"
            );

        } else {

            status.textContent =
                item.error ||
                t("errorStatus");

            status.classList.add(
                "text-red-400"
            );

        }


        left.appendChild(
            title
        );


        left.appendChild(
            status
        );


        row.appendChild(
            left
        );


        const badge =
            document.createElement(
                "span"
            );


        badge.className =
            "shrink-0 text-[7px] font-extrabold tracking-wider text-zinc-700";


        const today =
            new Date()
                .toISOString()
                .slice(
                    0,
                    10
                );


        if (
            item.upload_day ===
            today
        ) {

            badge.textContent =
                t("todayBadge");

        }


        row.appendChild(
            badge
        );


        return row;

    }


    /* =========================================================
       HACER DISPONIBLE GLOBALMENTE
       ========================================================= */

    window.NushudUserUpload = {

        render,

        loadMyNasheeds,

        getUser:
            function () {

                return getCurrentUser();

            }

    };


    /* =========================================================
       ARRANQUE
       ========================================================= */

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