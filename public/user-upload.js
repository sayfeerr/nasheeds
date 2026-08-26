"use strict";

(() => {

    let clientPromise = null;


    async function client() {

        if (
            clientPromise
        ) {
            return clientPromise;
        }

        clientPromise =
            fetch(
                "/api/public-config",
                {
                    cache:
                        "no-store"
                }
            )
                .then(
                    response =>
                        response.json()
                )
                .then(
                    config =>
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
                        )
                );

        return clientPromise;
    }


    async function session() {

        const c =
            await client();

        const {
            data,
            error
        } =
            await c.auth.getSession();

        if (
            error
        ) {
            throw error;
        }

        return (
            data.session ||
            null
        );
    }


    window.NushudUserApi = {

        getAccessToken:
            async () => {

                const s =
                    await session();

                return s
                    ? s.access_token
                    : null;
            }

    };


    function setStatus(
        message,
        error = false
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
            message || "";

        element.className =
            "text-[10px] mt-4 min-h-[16px] " +
            (
                error
                    ? "text-red-400"
                    : "text-zinc-500"
            );
    }


    function buildUploadUI() {

        const section =
            document.getElementById(
                "section-upload"
            );

        if (
            !section ||
            document.getElementById(
                "nushud-user-upload"
            )
        ) {
            return;
        }


        section.innerHTML = `
            <div class="glass-panel max-w-xl mx-auto rounded-2xl p-6 border border-white/5">

                <div class="mb-6">

                    <h2 class="text-xl font-extrabold text-zinc-100">
                        Subir nasheed
                    </h2>

                    <p class="mt-1 text-xs text-zinc-500">
                        Una subida diaria por cuenta.
                    </p>

                </div>


                <form
                    id="nushud-user-upload"
                    class="space-y-4">


                    <div>

                        <label
                            class="text-[10px] font-bold text-zinc-400">

                            Título

                        </label>

                        <input
                            id="user-upload-title"
                            required
                            maxlength="120"
                            class="mt-2 w-full rounded-xl border border-white/10 bg-zinc-950 px-3 py-2.5 text-xs text-zinc-100 outline-none"
                            placeholder="Nombre del nasheed">

                    </div>


                    <div>

                        <label
                            class="text-[10px] font-bold text-zinc-400">

                            Audio

                        </label>

                        <input
                            id="user-upload-audio"
                            required
                            type="file"
                            accept="audio/*,video/mp4,video/webm"
                            class="mt-2 w-full text-[10px] text-zinc-500">

                        <p class="mt-1 text-[9px] text-zinc-600">
                            Máximo 25 MB.
                        </p>

                    </div>


                    <div>

                        <label
                            class="text-[10px] font-bold text-zinc-400">

                            Portada (opcional)

                        </label>

                        <input
                            id="user-upload-cover"
                            type="file"
                            accept="image/jpeg,image/png,image/webp"
                            class="mt-2 w-full text-[10px] text-zinc-500">

                    </div>


                    <div>

                        <p
                            class="text-[10px] font-bold text-zinc-400">

                            Subtítulos

                        </p>

                        <div
                            class="mt-2 grid grid-cols-2 gap-2 text-[10px] text-zinc-400">

                            <label class="flex items-center gap-2">

                                <input
                                    type="checkbox"
                                    checked
                                    disabled>

                                Árabe obligatorio

                            </label>


                            <label class="flex items-center gap-2">

                                <input
                                    id="user-upload-es"
                                    type="checkbox"
                                    checked>

                                Español

                            </label>


                            <label class="flex items-center gap-2">

                                <input
                                    id="user-upload-en"
                                    type="checkbox">

                                English

                            </label>


                            <label class="flex items-center gap-2">

                                <input
                                    id="user-upload-ru"
                                    type="checkbox">

                                Русский

                            </label>

                        </div>

                    </div>


                    <button
                        id="user-upload-submit"
                        type="submit"
                        class="w-full rounded-xl bg-amber-500 px-4 py-3 text-xs font-extrabold text-zinc-950 hover:bg-amber-400">

                        Subir y procesar

                    </button>


                    <div
                        id="user-upload-status"
                        class="text-[10px] min-h-[16px] text-zinc-500">

                    </div>

                </form>


                <div class="mt-8">

                    <h3
                        class="mb-3 text-xs font-extrabold uppercase tracking-wider text-zinc-300">

                        Mis nasheeds

                    </h3>

                    <div
                        id="user-upload-list"
                        class="space-y-2">

                    </div>

                </div>

            </div>
        `;


        document
            .getElementById(
                "nushud-user-upload"
            )
            .addEventListener(
                "submit",
                async event => {

                    event.preventDefault();

                    await upload();

                }
            );
    }


    async function upload() {

        const title =
            document.getElementById(
                "user-upload-title"
            )
                .value
                .trim();

        const audio =
            document.getElementById(
                "user-upload-audio"
            )
                .files[0];

        const cover =
            document.getElementById(
                "user-upload-cover"
            )
                .files[0] ||
            null;

        const es =
            document.getElementById(
                "user-upload-es"
            )
                .checked;

        const en =
            document.getElementById(
                "user-upload-en"
            )
                .checked;

        const ru =
            document.getElementById(
                "user-upload-ru"
            )
                .checked;

        const button =
            document.getElementById(
                "user-upload-submit"
            );


        if (
            !title ||
            !audio
        ) {

            setStatus(
                "Escribe un título y selecciona un audio.",
                true
            );

            return;
        }


        button.disabled =
            true;


        try {

            const userSession =
                await session();


            if (
                !userSession
            ) {

                window.NushudAuth.open(
                    "login"
                );

                return;
            }


            const translations =
                [];


            if (es) {
                translations.push(
                    "es"
                );
            }

            if (en) {
                translations.push(
                    "en"
                );
            }

            if (ru) {
                translations.push(
                    "ru"
                );
            }


            setStatus(
                "Preparando subida..."
            );


            let response =
                await fetch(
                    "/api/user-nasheeds/prepare",
                    {
                        method:
                            "POST",

                        headers: {
                            "Content-Type":
                                "application/json",

                            "Authorization":
                                `Bearer ${userSession.access_token}`
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


            let data =
                await response.json();


            if (
                !response.ok
            ) {
                throw new Error(
                    data.error ||
                    "No se pudo preparar la subida."
                );
            }


            const supabase =
                await client();


            setStatus(
                "Subiendo audio..."
            );


            let upload =
                await supabase
                    .storage
                    .from(
                        "UserNasheeds"
                    )
                    .uploadToSignedUrl(
                        data.audio.path,
                        data.audio.token,
                        audio,
                        {
                            contentType:
                                audio.type
                        }
                    );


            if (
                upload.error
            ) {
                throw upload.error;
            }


            if (
                data.cover &&
                cover
            ) {

                setStatus(
                    "Subiendo portada..."
                );


                upload =
                    await supabase
                        .storage
                        .from(
                            "UserNasheeds"
                        )
                        .uploadToSignedUrl(
                            data.cover.path,
                            data.cover.token,
                            cover,
                            {
                                contentType:
                                    cover.type
                            }
                        );


                if (
                    upload.error
                ) {
                    throw upload.error;
                }
            }


            setStatus(
                "La IA está transcribiendo el árabe y generando las traducciones..."
            );


            response =
                await fetch(
                    `/api/user-nasheeds/${data.id}/process`,
                    {
                        method:
                            "POST",

                        headers: {
                            "Authorization":
                                `Bearer ${userSession.access_token}`
                        }
                    }
                );


            data =
                await response.json();


            if (
                !response.ok
            ) {
                throw new Error(
                    data.error ||
                    "No se pudo procesar el nasheed."
                );
            }


            setStatus(
                "Nasheed listo. Recargando..."
            );


            setTimeout(
                () => {
                    location.reload();
                },
                700
            );

        } catch (
            error
        ) {

            console.error(
                "[NUSHUD UPLOAD]",
                error
            );


            setStatus(
                error.message ||
                "Error durante la subida.",
                true
            );

        } finally {

            button.disabled =
                false;
        }
    }


    async function loadMine() {

        const list =
            document.getElementById(
                "user-upload-list"
            );

        if (
            !list
        ) {
            return;
        }


        try {

            const token =
                await window.NushudUserApi
                    .getAccessToken();


            if (
                !token
            ) {

                list.innerHTML =
                    `
                    <div class="text-[10px] text-zinc-600">
                        Inicia sesión para ver tus nasheeds.
                    </div>
                    `;

                return;
            }


            const response =
                await fetch(
                    "/api/user-nasheeds",
                    {
                        headers: {
                            "Authorization":
                                `Bearer ${token}`
                        },

                        cache:
                            "no-store"
                    }
                );


            const data =
                await response.json();


            if (
                !response.ok
            ) {
                throw new Error(
                    data.error ||
                    "Error"
                );
            }


            list.innerHTML =
                "";


            if (
                !data.nasheeds.length
            ) {

                list.innerHTML =
                    `
                    <div class="text-[10px] text-zinc-600">
                        Todavía no has subido ningún nasheed.
                    </div>
                    `;

                return;
            }


            data.nasheeds.forEach(
                item => {

                    const row =
                        document.createElement(
                            "div"
                        );


                    row.className =
                        "flex items-center justify-between gap-3 rounded-xl border border-white/5 bg-white/[.02] px-3 py-2.5";


                    const info =
                        document.createElement(
                            "div"
                        );


                    info.className =
                        "min-w-0";


                    const name =
                        document.createElement(
                            "div"
                        );


                    name.className =
                        "truncate text-[10px] font-bold text-zinc-300";


                    name.textContent =
                        item.title;


                    const state =
                        document.createElement(
                            "div"
                        );


                    state.className =
                        "mt-1 text-[9px] text-zinc-600";


                    state.textContent =
                        item.status ===
                            "ready"
                            ? "Disponible"
                            : item.status ===
                                "processing"
                                ? "Procesando..."
                                : "Error";


                    info.appendChild(
                        name
                    );

                    info.appendChild(
                        state
                    );

                    row.appendChild(
                        info
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
                "[USER NASHEEDS LIST]",
                error
            );

        }
    }


    window.addEventListener(
        "nushud-auth-changed",
        () => {

            buildUploadUI();

            loadMine();


            if (
                typeof window.fetchNasheeds ===
                "function"
            ) {

                window.fetchNasheeds();

            }

        }
    );


    document.addEventListener(
        "DOMContentLoaded",
        () => {

            buildUploadUI();

            setTimeout(
                loadMine,
                500
            );

        }
    );

})();