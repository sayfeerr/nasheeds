"use strict";

/*
 * ============================================================
 * NUSHUD - USER UPLOAD
 * ============================================================
 *
 * Compatible con:
 *   /api/user-nasheeds
 *   /api/user-nasheeds/prepare
 *   /api/user-nasheeds/:id/process
 *
 * El servidor controla:
 *   - autenticación
 *   - 1 subida diaria
 *   - almacenamiento
 *   - transcripción
 *   - traducciones
 *   - nasheeds privados
 *
 * Este archivo SOLO controla la interfaz.
 * ============================================================
 */

(function () {

    const CONTENT_ID =
        "nushud-upload-content";

    const BUCKET =
        "UserNasheeds";

    const MAX_AUDIO =
        25 * 1024 * 1024;

    const MAX_COVER =
        5 * 1024 * 1024;

    let isInitialized =
        false;

    let isUploading =
        false;

    let currentUser =
        null;

    let currentList =
        [];


    /* ========================================================
       UTILIDADES
       ======================================================== */

    function getContent() {

        return document.getElementById(
            CONTENT_ID
        );

    }


    function escapeHtml(
        value
    ) {

        const div =
            document.createElement(
                "div"
            );

        div.textContent =
            String(
                value ?? ""
            );

        return div.innerHTML;

    }


    function formatDate(
        value
    ) {

        if (!value) {
            return "";
        }

        try {

            const date =
                new Date(
                    value
                );

            if (
                Number.isNaN(
                    date.getTime()
                )
            ) {
                return "";
            }

            return date.toLocaleDateString(
                undefined,
                {
                    year: "numeric",
                    month: "short",
                    day: "numeric"
                }
            );

        } catch {

            return "";

        }

    }


    function getStatusLabel(
        status
    ) {

        switch (
            String(
                status || ""
            ).toLowerCase()
        ) {

            case "processing":

                return "Procesando…";

            case "ready":

                return "Disponible";

            case "error":

                return "Error";

            default:

                return "Preparando…";

        }

    }


    function getStatusClass(
        status
    ) {

        switch (
            String(
                status || ""
            ).toLowerCase()
        ) {

            case "ready":

                return "text-amber-400";

            case "error":

                return "text-red-400";

            case "processing":

                return "text-zinc-400";

            default:

                return "text-zinc-500";

        }

    }


    async function getAccessToken() {

        try {

            /*
             * Primero usamos la API de autenticación
             * que ya utiliza NASHEED.
             */

            if (
                window.NushudUserApi &&
                typeof
                    window.NushudUserApi
                        .getAccessToken ===
                    "function"
            ) {

                const token =
                    await
                    window.NushudUserApi
                        .getAccessToken();

                if (token) {
                    return token;
                }

            }


            /*
             * Fallback directo a Supabase.
             */

            if (
                window.NushudClient &&
                window.NushudClient.auth
            ) {

                const sessionResult =
                    await
                    window.NushudClient
                        .auth
                        .getSession();

                return (
                    sessionResult
                        ?.data
                        ?.session
                        ?.access_token ||
                    ""
                );

            }


            /*
             * Último fallback:
             * crear cliente usando public-config.
             */

            if (
                window.supabase &&
                typeof
                    window.supabase
                        .createClient ===
                    "function"
            ) {

                const response =
                    await fetch(
                        "/api/public-config",
                        {
                            method:
                                "GET",

                            cache:
                                "no-store",

                            credentials:
                                "same-origin"
                        }
                    );

                if (!response.ok) {
                    return "";
                }

                const config =
                    await response.json();

                if (
                    !config.supabaseUrl ||
                    !config.supabasePublishableKey
                ) {
                    return "";
                }

                if (
                    !window.NushudUploadClient
                ) {

                    window.NushudUploadClient =
                        window.supabase
                            .createClient(
                                config.supabaseUrl,
                                config.supabasePublishableKey,
                                {
                                    auth: {
                                        persistSession:
                                            true,

                                        autoRefreshToken:
                                            true,

                                        detectSessionInUrl:
                                            true,

                                        flowType:
                                            "pkce"
                                    }
                                }
                            );

                }

                const sessionResult =
                    await
                    window.NushudUploadClient
                        .auth
                        .getSession();

                return (
                    sessionResult
                        ?.data
                        ?.session
                        ?.access_token ||
                    ""
                );

            }

        } catch (
            error
        ) {

            console.error(
                "[NUSHUD UPLOAD TOKEN]",
                error
            );

        }

        return "";

    }


    async function getSupabaseClient() {

        if (
            window.NushudUploadClient
        ) {

            return
                window.NushudUploadClient;

        }

        if (
            !window.supabase ||
            typeof
                window.supabase
                    .createClient !==
                "function"
        ) {

            throw new Error(
                "Supabase JS no está disponible."
            );

        }

        const response =
            await fetch(
                "/api/public-config",
                {
                    method:
                        "GET",

                    cache:
                        "no-store",

                    credentials:
                        "same-origin"
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
                "Configuración de Supabase incompleta."
            );

        }

        window.NushudUploadClient =
            window.supabase
                .createClient(
                    config.supabaseUrl,
                    config.supabasePublishableKey,
                    {
                        auth: {
                            persistSession:
                                true,

                            autoRefreshToken:
                                true,

                            detectSessionInUrl:
                                true,

                            flowType:
                                "pkce"
                        }
                    }
                );

        return
            window.NushudUploadClient;

    }


    async function getCurrentUser() {

        try {

            /*
             * API propia de auth.
             */

            if (
                window.NushudAuth &&
                typeof
                    window.NushudAuth
                        .getUser ===
                    "function"
            ) {

                const user =
                    window.NushudAuth
                        .getUser();

                if (user) {
                    return user;
                }

            }


            /*
             * Supabase directo.
             */

            const client =
                await getSupabaseClient();

            const result =
                await
                client.auth.getUser();

            if (
                result &&
                result.data &&
                result.data.user
            ) {

                return result.data.user;

            }

        } catch (
            error
        ) {

            console.error(
                "[NUSHUD CURRENT USER]",
                error
            );

        }

        return null;

    }


    async function authRequired() {

        const user =
            await getCurrentUser();

        if (user) {

            currentUser =
                user;

            return true;

        }

        currentUser =
            null;

        return false;

    }


    function openLogin() {

        if (
            window.NushudAuth &&
            typeof
                window.NushudAuth
                    .open ===
                "function"
        ) {

            window.NushudAuth.open(
                "login"
            );

            return;

        }

        alert(
            "Debes iniciar sesión."
        );

    }


    /* ========================================================
       ESTADO DE LA INTERFAZ
       ======================================================== */

    function renderLoading() {

        const container =
            getContent();

        if (!container) {
            return;
        }

        container.innerHTML = `

            <div class="
                glass-panel
                rounded-2xl
                border border-white/5
                p-6
                text-center
            ">

                <div class="
                    w-8
                    h-8
                    mx-auto
                    mb-3
                    rounded-full
                    border-2
                    border-amber-500/20
                    border-t-amber-500
                    animate-spin
                "></div>

                <p class="
                    text-xs
                    text-zinc-400
                ">
                    Cargando…
                </p>

            </div>

        `;

    }


    function renderLoggedOut() {

        const container =
            getContent();

        if (!container) {
            return;
        }

        container.innerHTML = `

            <div class="
                nushud-upload-shell
            ">

                <div class="
                    nushud-upload-card
                ">

                    <div class="
                        nushud-upload-body
                        text-center
                        py-10
                    ">

                        <div class="
                            w-14
                            h-14
                            mx-auto
                            mb-4
                            rounded-2xl
                            bg-amber-500/10
                            border
                            border-amber-500/20
                            text-amber-400
                            flex
                            items-center
                            justify-center
                            text-xl
                        ">
                            ↑
                        </div>

                        <h3 class="
                            text-sm
                            font-extrabold
                            text-zinc-100
                        ">
                            Inicia sesión para subir
                        </h3>

                        <p class="
                            text-[10px]
                            text-zinc-500
                            mt-2
                            max-w-xs
                            mx-auto
                            leading-relaxed
                        ">
                            Tus nasheeds subidos son
                            privados y solo tú podrás
                            escucharlos.
                        </p>

                        <button
                            id="nushud-upload-login"
                            type="button"
                            class="
                                nushud-upload-button
                                mt-5
                            "
                        >
                            Iniciar sesión
                        </button>

                    </div>

                </div>

            </div>

        `;


        document
            .getElementById(
                "nushud-upload-login"
            )
            ?.addEventListener(
                "click",
                openLogin
            );

    }


    function renderForm(
        existingRows
    ) {

        const container =
            getContent();

        if (!container) {
            return;
        }

        const hasTodayUpload =
            Array.isArray(
                existingRows
            ) &&
            existingRows.some(
                item =>
                    String(
                        item.status
                    ).toLowerCase() ===
                    "processing"
            ) ||
            false;


        /*
         * El backend es quien realmente controla
         * si el día ya está utilizado.
         */

        container.innerHTML = `

            <div class="
                nushud-upload-shell
            ">

                <div class="
                    nushud-upload-card
                ">

                    <div class="
                        nushud-upload-header
                    ">

                        <div class="
                            flex
                            items-start
                            justify-between
                            gap-4
                        ">

                            <div>

                                <div class="
                                    nushud-upload-title
                                ">
                                    Nueva subida
                                </div>

                                <div class="
                                    nushud-upload-description
                                ">
                                    Sube un nasheed y genera
                                    automáticamente los subtítulos
                                    en árabe y las traducciones
                                    que elijas.
                                </div>

                            </div>

                            <span class="
                                shrink-0
                                px-2.5
                                py-1
                                rounded-lg
                                bg-amber-500/10
                                border
                                border-amber-500/15
                                text-[8px]
                                font-bold
                                text-amber-400
                                uppercase
                            ">
                                1 al día
                            </span>

                        </div>

                    </div>


                    <form
                        id="nushud-upload-form"
                        class="
                            nushud-upload-body
                        "
                    >

                        <div class="
                            nushud-upload-field
                        ">

                            <label
                                for="nushud-title"
                                class="
                                    nushud-upload-label
                                "
                            >
                                Título del nasheed
                            </label>

                            <input
                                id="nushud-title"
                                name="title"
                                type="text"
                                maxlength="120"
                                autocomplete="off"
                                class="
                                    nushud-upload-input
                                "
                                placeholder="Ej. Kuntu Maitan"
                                required
                            >

                        </div>


                        <div class="
                            nushud-upload-field
                        ">

                            <label
                                for="nushud-audio"
                                class="
                                    nushud-upload-label
                                "
                            >
                                Audio
                            </label>

                            <input
                                id="nushud-audio"
                                name="audio"
                                type="file"
                                accept="audio/*,video/mp4,video/webm"
                                class="
                                    nushud-upload-file
                                "
                                required
                            >

                            <p class="
                                text-[9px]
                                text-zinc-600
                                mt-2
                            ">
                                Máximo 25 MB.
                            </p>

                        </div>


                        <div class="
                            nushud-upload-field
                        ">

                            <label
                                for="nushud-cover"
                                class="
                                    nushud-upload-label
                                "
                            >
                                Portada
                                <span class="
                                    font-normal
                                    text-zinc-600
                                ">
                                    (opcional)
                                </span>
                            </label>

                            <input
                                id="nushud-cover"
                                name="cover"
                                type="file"
                                accept="image/jpeg,image/png,image/webp"
                                class="
                                    nushud-upload-file
                                "
                            >

                            <p class="
                                text-[9px]
                                text-zinc-600
                                mt-2
                            ">
                                JPG, PNG o WebP · máximo 5 MB.
                            </p>

                        </div>


                        <div class="
                            nushud-upload-field
                        ">

                            <label
                                class="
                                    nushud-upload-label
                                "
                            >
                                Traducciones
                            </label>

                            <div class="
                                nushud-upload-language-grid
                            ">

                                <div class="
                                    nushud-upload-language
                                ">

                                    <input
                                        id="upload-es"
                                        type="checkbox"
                                        value="es"
                                        checked
                                    >

                                    <label for="upload-es">
                                        Español
                                    </label>

                                </div>


                                <div class="
                                    nushud-upload-language
                                ">

                                    <input
                                        id="upload-en"
                                        type="checkbox"
                                        value="en"
                                    >

                                    <label for="upload-en">
                                        English
                                    </label>

                                </div>


                                <div class="
                                    nushud-upload-language
                                ">

                                    <input
                                        id="upload-ru"
                                        type="checkbox"
                                        value="ru"
                                    >

                                    <label for="upload-ru">
                                        Русский
                                    </label>

                                </div>

                            </div>

                            <p class="
                                text-[9px]
                                text-zinc-600
                                mt-2
                            ">
                                El árabe es obligatorio y se genera automáticamente.
                            </p>

                        </div>


                        <div
                            id="nushud-upload-status"
                            class="
                                nushud-upload-status
                            "
                        ></div>


                        <div class="
                            nushud-upload-actions
                        ">

                            <button
                                type="submit"
                                id="nushud-upload-submit"
                                class="
                                    nushud-upload-button
                                "
                            >
                                Subir nasheed
                            </button>

                        </div>

                    </form>

                </div>


                <div
                    id="nushud-private-list-wrapper"
                    class="
                        mt-4
                    "
                ></div>

            </div>

        `;


        bindForm();

        renderPrivateList(
            existingRows
        );

    }


    function renderProcessing(
        row
    ) {

        const container =
            getContent();

        if (!container) {
            return;
        }

        container.innerHTML = `

            <div class="
                nushud-upload-shell
            ">

                <div class="
                    nushud-upload-card
                ">

                    <div class="
                        nushud-upload-body
                        text-center
                        py-10
                    ">

                        <div class="
                            w-12
                            h-12
                            mx-auto
                            mb-4
                            rounded-2xl
                            bg-amber-500/10
                            border
                            border-amber-500/20
                            flex
                            items-center
                            justify-center
                            text-amber-400
                            text-lg
                        ">
                            ✦
                        </div>

                        <h3 class="
                            text-sm
                            font-extrabold
                            text-zinc-100
                        ">
                            Procesando tu nasheed
                        </h3>

                        <p class="
                            text-[10px]
                            text-zinc-500
                            mt-2
                            max-w-sm
                            mx-auto
                            leading-relaxed
                        ">
                            Estamos generando el subtítulo
                            árabe y las traducciones.
                            Puedes dejar esta página abierta.
                        </p>

                        <div class="
                            mt-5
                            h-1.5
                            max-w-xs
                            mx-auto
                            overflow-hidden
                            rounded-full
                            bg-white/5
                        ">

                            <div class="
                                h-full
                                w-1/2
                                rounded-full
                                bg-amber-500
                                animate-pulse
                            "></div>

                        </div>

                        <p class="
                            text-[9px]
                            text-zinc-600
                            mt-4
                        ">
                            ${escapeHtml(
                                row?.title ||
                                "Nasheed"
                            )}
                        </p>

                    </div>

                </div>

            </div>

        `;

    }


    function renderPrivateList(
        rows
    ) {

        const wrapper =
            document.getElementById(
                "nushud-private-list-wrapper"
            );

        if (!wrapper) {
            return;
        }

        if (
            !Array.isArray(rows) ||
            !rows.length
        ) {

            wrapper.replaceChildren();

            return;

        }

        const readyRows =
            rows.filter(
                row =>
                    row &&
                    row.status ===
                        "ready"
            );

        if (!readyRows.length) {

            wrapper.replaceChildren();

            return;

        }

        wrapper.innerHTML = `

            <div class="
                glass-panel
                rounded-2xl
                border
                border-white/5
                p-4
            ">

                <div class="
                    text-[9px]
                    font-extrabold
                    uppercase
                    tracking-widest
                    text-zinc-500
                    mb-3
                ">
                    Mis nasheeds
                </div>

                <div class="
                    nushud-private-list
                ">

                    ${readyRows.map(
                        row => `

                            <div class="
                                nushud-private-item
                            ">

                                <div class="
                                    min-w-0
                                ">

                                    <div class="
                                        nushud-private-item-title
                                    ">
                                        ${escapeHtml(
                                            row.title
                                        )}
                                    </div>

                                    <div class="
                                        text-[8px]
                                        text-zinc-600
                                        mt-1
                                    ">
                                        Privado
                                        ${
                                            row.created_at
                                                ? " · " +
                                                  escapeHtml(
                                                      formatDate(
                                                          row.created_at
                                                      )
                                                  )
                                                : ""
                                        }
                                    </div>

                                </div>

                                <div class="
                                    nushud-private-item-status
                                    ${getStatusClass(
                                        row.status
                                    )}
                                ">
                                    Disponible
                                </div>

                            </div>

                        `
                    ).join("")}

                </div>

            </div>

        `;

    }


    /* ========================================================
       LISTADO
       ======================================================== */

    async function loadUserNasheeds() {

        const token =
            await getAccessToken();

        if (!token) {

            currentList = [];

            return {
                rows: [],
                authenticated: false
            };

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

        const raw =
            await response.text();

        let data;

        try {

            data =
                JSON.parse(
                    raw
                );

        } catch {

            throw new Error(
                "El servidor devolvió una respuesta no válida."
            );

        }

        if (!response.ok) {

            throw new Error(
                data?.error ||
                "No se pudieron cargar tus nasheeds."
            );

        }

        currentList =
            Array.isArray(
                data?.nasheeds
            )
                ? data.nasheeds
                : [];

        return {
            rows:
                currentList,
            authenticated:
                true
        };

    }


    /* ========================================================
       VALIDACIÓN
       ======================================================== */

    function validateAudio(
        file
    ) {

        if (!file) {

            return "Selecciona un archivo de audio.";

        }

        if (
            file.size <= 0
        ) {

            return "El archivo de audio está vacío.";

        }

        if (
            file.size >
            MAX_AUDIO
        ) {

            return "El audio no puede superar los 25 MB.";

        }

        const allowed =
            new Set([
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

        if (
            file.type &&
            !allowed.has(
                file.type
            )
        ) {

            return "El formato de audio no es compatible.";

        }

        return "";

    }


    function validateCover(
        file
    ) {

        if (!file) {
            return "";
        }

        if (
            file.size <= 0
        ) {

            return "La portada está vacía.";

        }

        if (
            file.size >
            MAX_COVER
        ) {

            return "La portada no puede superar los 5 MB.";

        }

        const allowed =
            new Set([
                "image/jpeg",
                "image/png",
                "image/webp"
            ]);

        if (
            file.type &&
            !allowed.has(
                file.type
            )
        ) {

            return "La portada debe ser JPG, PNG o WebP.";

        }

        return "";

    }


    /* ========================================================
       SUBIDA A STORAGE
       ======================================================== */

    async function uploadSignedFile(
        client,
        path,
        token,
        file
    ) {

        if (
            !path ||
            !token ||
            !file
        ) {

            throw new Error(
                "Datos de subida incompletos."
            );

        }

        const result =
            await client
                .storage
                .from(
                    BUCKET
                )
                .uploadToSignedUrl(
                    path,
                    token,
                    file
                );

        if (
            result.error
        ) {

            throw result.error;

        }

        return true;

    }


    /* ========================================================
       FORMULARIO
       ======================================================== */

    function bindForm() {

        const form =
            document.getElementById(
                "nushud-upload-form"
            );

        if (!form) {
            return;
        }

        form.addEventListener(
            "submit",
            handleSubmit
        );

    }


    async function handleSubmit(
        event
    ) {

        event.preventDefault();

        if (isUploading) {
            return;
        }

        const token =
            await getAccessToken();

        if (!token) {

            openLogin();

            return;

        }

        const user =
            await getCurrentUser();

        if (!user) {

            openLogin();

            return;

        }

        const titleInput =
            document.getElementById(
                "nushud-title"
            );

        const audioInput =
            document.getElementById(
                "nushud-audio"
            );

        const coverInput =
            document.getElementById(
                "nushud-cover"
            );

        const submitButton =
            document.getElementById(
                "nushud-upload-submit"
            );

        const status =
            document.getElementById(
                "nushud-upload-status"
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


        const audioError =
            validateAudio(
                audioFile
            );

        if (audioError) {

            setStatus(
                status,
                audioError,
                true
            );

            return;

        }


        const coverError =
            validateCover(
                coverFile
            );

        if (coverError) {

            setStatus(
                status,
                coverError,
                true
            );

            return;

        }


        if (
            !title ||
            title.length >
                120
        ) {

            setStatus(
                status,
                "El título es obligatorio y debe tener como máximo 120 caracteres.",
                true
            );

            return;

        }


        const translations =
            [];

        if (
            document.getElementById(
                "upload-es"
            )?.checked
        ) {

            translations.push(
                "es"
            );

        }

        if (
            document.getElementById(
                "upload-en"
            )?.checked
        ) {

            translations.push(
                "en"
            );

        }

        if (
            document.getElementById(
                "upload-ru"
            )?.checked
        ) {

            translations.push(
                "ru"
            );

        }


        isUploading =
            true;

        if (submitButton) {

            submitButton.disabled =
                true;

            submitButton.textContent =
                "Preparando…";

        }

        setStatus(
            status,
            "Preparando la subida…",
            false
        );


        try {

            /*
             * Comprobamos que el servidor ve
             * exactamente al mismo usuario.
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

                            Accept:
                                "application/json",

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
                                        audioFile.name,

                                    type:
                                        audioFile.type,

                                    size:
                                        audioFile.size

                                },

                                cover:
                                    coverFile
                                        ? {

                                            name:
                                                coverFile.name,

                                            type:
                                                coverFile.type,

                                            size:
                                                coverFile.size

                                        }
                                        : null

                            })

                    }
                );


            const prepareRaw =
                await prepareResponse.text();

            let prepareData;

            try {

                prepareData =
                    JSON.parse(
                        prepareRaw
                    );

            } catch {

                throw new Error(
                    "El servidor devolvió una respuesta no válida al preparar la subida."
                );

            }


            if (
                !prepareResponse.ok
            ) {

                throw new Error(
                    prepareData?.error ||
                    "No se pudo preparar la subida."
                );

            }


            if (
                !prepareData.success ||
                !prepareData.id ||
                !prepareData.audio?.path ||
                !prepareData.audio?.token
            ) {

                throw new Error(
                    "La respuesta de preparación está incompleta."
                );

            }


            setStatus(
                status,
                "Subiendo el audio…",
                false
            );


            const client =
                await getSupabaseClient();


            await uploadSignedFile(
                client,
                prepareData.audio.path,
                prepareData.audio.token,
                audioFile
            );


            if (
                prepareData.cover &&
                coverFile
            {

                setStatus(
                    status,
                    "Subiendo la portada…",
                    false
                );


                await uploadSignedFile(
                    client,
                    prepareData.cover.path,
                    prepareData.cover.token,
                    coverFile
                );

            }


            setStatus(
                status,
                "Enviando a la IA…",
                false
            );


            if (submitButton) {

                submitButton.textContent =
                    "Procesando…";

            }


            const processResponse =
                await fetch(
                    `/api/user-nasheeds/${encodeURIComponent(
                        prepareData.id
                    )}/process`,
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


            const processRaw =
                await processResponse.text();

            let processData;

            try {

                processData =
                    JSON.parse(
                        processRaw
                    );

            } catch {

                throw new Error(
                    "El servidor devolvió una respuesta no válida al procesar el nasheed."
                );

            }


            if (
                !processResponse.ok
            ) {

                throw new Error(
                    processData?.error ||
                    "La IA no pudo procesar el nasheed."
                );

            }


            setStatus(
                status,
                "Nasheed procesado correctamente.",
                false,
                true
            );


            form.reset();


            /*
             * Recargar lista privada.
             */

            try {

                await refresh();

            } catch {

                /* ignore */

            }


            /*
             * Recargar la biblioteca principal
             * para que aparezca inmediatamente.
             */

            if (
                typeof
                    window.fetchNasheeds ===
                    "function"
            ) {

                try {

                    await
                        window.fetchNasheeds();

                } catch {

                    /* ignore */

                }

            }

            /*
             * Disparamos el mismo evento usado
             * por el resto de la aplicación.
             */

            window.dispatchEvent(
                new CustomEvent(
                    "nushud-user-nasheed-ready"
                )
            );


            setTimeout(
                () => {

                    const statusElement =
                        document.getElementById(
                            "nushud-upload-status"
                        );

                    if (statusElement) {

                        statusElement.textContent =
                            "";

                    }

                },
                5000
            );


        } catch (
            error
        ) {

            console.error(
                "[NUSHUD USER UPLOAD]",
                error
            );

            setStatus(
                status,
                error?.message ||
                    "No se pudo completar la subida.",
                true
            );

        } finally {

            isUploading =
                false;

            const currentSubmit =
                document.getElementById(
                    "nushud-upload-submit"
                );

            if (currentSubmit) {

                currentSubmit.disabled =
                    false;

                currentSubmit.textContent =
                    "Subir nasheed";

            }

        }

    }


    function setStatus(
        element,
        message,
        isError,
        success
    ) {

        if (!element) {
            return;
        }

        element.textContent =
            String(
                message || ""
            );

        element.classList.toggle(
            "error",
            Boolean(
                isError
            )
        );

        element.classList.toggle(
            "success",
            Boolean(
                success
            )
        );

    }


    /* ========================================================
       REFRESH
       ======================================================== */

    async function refresh() {

        const container =
            getContent();

        if (!container) {
            return;
        }

        if (isUploading) {
            return;
        }

        renderLoading();

        const authenticated =
            await authRequired();

        if (!authenticated) {

            renderLoggedOut();

            return;

        }

        try {

            const result =
                await
                loadUserNasheeds();

            const rows =
                result.rows || [];


            /*
             * Buscamos el nasheed del día que
             * todavía esté procesándose.
             */

            const processing =
                rows.find(
                    row =>
                        String(
                            row.status
                        ).toLowerCase() ===
                        "processing"
                );


            if (processing) {

                renderProcessing(
                    processing
                );

                startProcessingWatcher(
                    processing.id
                );

                return;

            }


            /*
             * Si el servidor tiene un "ready"
             * de hoy, renderizamos el formulario
             * bloqueado por el backend al intentar
             * subir, pero mantenemos visible la lista.
             *
             * Esto evita perder la interfaz.
             */

            renderForm(
                rows
            );


        } catch (
            error
        ) {

            console.error(
                "[NUSHUD USER UPLOAD REFRESH]",
                error
            );

            container.innerHTML = `

                <div class="
                    glass-panel
                    rounded-2xl
                    border
                    border-red-500/10
                    p-6
                    text-center
                ">

                    <div class="
                        text-red-400
                        text-lg
                        mb-3
                    ">
                        !
                    </div>

                    <h3 class="
                        text-xs
                        font-extrabold
                        text-zinc-200
                    ">
                        No se pudo cargar la subida
                    </h3>

                    <p class="
                        text-[10px]
                        text-zinc-500
                        mt-2
                        leading-relaxed
                    ">
                        ${escapeHtml(
                            error?.message ||
                            "Error desconocido."
                        )}
                    </p>

                    <button
                        id="nushud-upload-retry"
                        type="button"
                        class="
                            nushud-upload-button
                            mt-5
                        "
                    >
                        Reintentar
                    </button>

                </div>

            `;

            document
                .getElementById(
                    "nushud-upload-retry"
                )
                ?.addEventListener(
                    "click",
                    refresh
                );

        }

    }


    /* ========================================================
       WATCHER
       ======================================================== */

    let processingTimer =
        null;


    function startProcessingWatcher(
        id
    ) {

        if (
            processingTimer
        ) {

            clearInterval(
                processingTimer
            );

        }

        let checks =
            0;

        processingTimer =
            setInterval(
                async () => {

                    checks++;

                    if (
                        checks >
                        120
                    ) {

                        clearInterval(
                            processingTimer
                        );

                        processingTimer =
                            null;

                        return;

                    }

                    try {

                        const token =
                            await
                            getAccessToken();

                        if (!token) {

                            return;

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

                        if (
                            !response.ok
                        ) {

                            return;

                        }

                        const data =
                            await
                            response.json();

                        const row =
                            (
                                data?.nasheeds ||
                                []
                            ).find(
                                item =>
                                    Number(
                                        item.id
                                    ) ===
                                    Number(
                                        id
                                    )
                            );

                        if (
                            !row
                        ) {

                            return;

                        }

                        if (
                            row.status !==
                                "processing"
                        ) {

                            clearInterval(
                                processingTimer
                            );

                            processingTimer =
                                null;

                            await
                                refresh();

                            if (
                                typeof
                                    window.fetchNasheeds ===
                                    "function"
                            ) {

                                await
                                    window.fetchNasheeds();

                            }

                        }

                    } catch (
                        error
                    ) {

                        console.error(
                            "[NUSHUD PROCESS WATCHER]",
                            error
                        );

                    }

                },
                5000
            );

    }


    /* ========================================================
       AUTH EVENT
       ======================================================== */

    window.addEventListener(
        "nushud-auth-changed",
        async event => {

            currentUser =
                event
                    ?.detail
                    ?.user ||
                null;

            await refresh();

        }
    );


    /* ========================================================
       EVENTO DE SUBIDA
       ======================================================== */

    window.addEventListener(
        "nushud-user-nasheed-ready",
        async () => {

            await refresh();

        }
    );


    /* ========================================================
       API PUBLICA
       ======================================================== */

    window.NushudUserUpload = {

        refresh,

        getCurrentUser,

        getAccessToken,

        isUploading() {

            return isUploading;

        }

    };


    /* ========================================================
       INICIO
       ======================================================== */

    function initialize() {

        if (isInitialized) {
            return;
        }

        isInitialized =
            true;

        /*
         * No esperamos a que auth.js nos dispare
         * un evento. Comprobamos el estado nosotros.
         */

        setTimeout(
            () => {

                refresh();

            },
            0
        );

        /*
         * Segundo intento para cubrir el caso
         * en que Supabase termina restaurando
         * la sesión un poco después.
         */

        setTimeout(
            () => {

                refresh();

            },
            700
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
                once: true
            }
        );

    } else {

        initialize();

    }

})();