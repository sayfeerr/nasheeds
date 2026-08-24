const express = require("express");
const crypto = require("crypto");
const path = require("path");
require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");

const app = express();

const PORT =
    process.env.PORT ||
    3000;

const SUPABASE_URL =
    process.env.SUPABASE_URL;

const SUPABASE_SECRET_KEY =
    process.env.SUPABASE_SECRET_KEY;

const SUPABASE_PUBLISHABLE_KEY =
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    "";

const STORAGE_BUCKET =
    "Nasheeds";

const ADMIN_PIN =
    process.env.ADMIN_PIN ||
    "7777";

const ADMIN_PATH =
    process.env.ADMIN_PATH ||
    "/panel-oculto-propietario-xyz";

const SESSION_SECRET =
    process.env.SESSION_SECRET ||
    "nushud-super-secret-key-change-it";


/* =========================================================
   SUPABASE
   ========================================================= */

if (
    !SUPABASE_URL ||
    !SUPABASE_SECRET_KEY
) {

    console.error(
        "Faltan SUPABASE_URL o SUPABASE_SECRET_KEY."
    );

}


const supabase =
    createClient(
        SUPABASE_URL,
        SUPABASE_SECRET_KEY,
        {
            auth: {
                persistSession:
                    false,

                autoRefreshToken:
                    false
            }
        }
    );


/* =========================================================
   MIDDLEWARE
   ========================================================= */

app.use(
    express.json({
        limit:
            "1mb"
    })
);


app.use(
    express.urlencoded({
        extended:
            true,

        limit:
            "1mb"
    })
);


/* =========================================================
   COOKIE
   ========================================================= */

const ADMIN_COOKIE =
    "nushud_admin";


function base64UrlEncode(
    value
) {

    return Buffer
        .from(value)
        .toString("base64")
        .replace(
            /\+/g,
            "-"
        )
        .replace(
            /\//g,
            "_"
        )
        .replace(
            /=+$/g,
            ""
        );

}


function base64UrlDecode(
    value
) {

    value =
        value
            .replace(
                /-/g,
                "+"
            )
            .replace(
                /_/g,
                "/"
            );


    while (
        value.length %
        4
    ) {

        value += "=";

    }


    return Buffer
        .from(
            value,
            "base64"
        )
        .toString(
            "utf8"
        );

}


function signValue(
    value
) {

    return crypto
        .createHmac(
            "sha256",
            SESSION_SECRET
        )
        .update(
            value
        )
        .digest("base64")
        .replace(
            /\+/g,
            "-"
        )
        .replace(
            /\//g,
            "_"
        )
        .replace(
            /=+$/g,
            ""
        );

}


function createAdminToken() {

    const payload = {

        admin:
            true,

        exp:
            Date.now() +
            (
                1000 *
                60 *
                60 *
                24 *
                7
            )

    };


    const encoded =
        base64UrlEncode(
            JSON.stringify(
                payload
            )
        );


    const signature =
        signValue(
            encoded
        );


    return (
        encoded +
        "." +
        signature
    );

}


function verifyAdminToken(
    token
) {

    if (
        typeof token !==
        "string"
    ) {

        return false;

    }


    const parts =
        token.split(".");


    if (
        parts.length !==
        2
    ) {

        return false;

    }


    const encoded =
        parts[0];

    const signature =
        parts[1];


    const expected =
        signValue(
            encoded
        );


    const a =
        Buffer.from(
            signature
        );

    const b =
        Buffer.from(
            expected
        );


    if (
        a.length !==
        b.length
    ) {

        return false;

    }


    if (
        !crypto.timingSafeEqual(
            a,
            b
        )
    ) {

        return false;

    }


    try {

        const payload =
            JSON.parse(
                base64UrlDecode(
                    encoded
                )
            );


        if (
            payload.admin !==
            true
        ) {

            return false;

        }


        if (
            !Number.isFinite(
                payload.exp
            )
        ) {

            return false;

        }


        if (
            Date.now() >=
            payload.exp
        ) {

            return false;

        }


        return true;

    } catch {

        return false;

    }

}


function getCookie(
    req,
    name
) {

    const header =
        req.headers.cookie;


    if (
        !header
    ) {

        return "";

    }


    const parts =
        header.split(";");


    for (
        const part of
        parts
    ) {

        const index =
            part.indexOf("=");


        if (
            index ===
            -1
        ) {

            continue;

        }


        const key =
            part
                .slice(
                    0,
                    index
                )
                .trim();


        if (
            key !==
            name
        ) {

            continue;

        }


        return decodeURIComponent(
            part
                .slice(
                    index + 1
                )
                .trim()
        );

    }


    return "";

}


function isAdmin(
    req
) {

    return verifyAdminToken(
        getCookie(
            req,
            ADMIN_COOKIE
        )
    );

}


function setAdminCookie(
    res
) {

    const secure =
        process.env.NODE_ENV ===
        "production";


    res.setHeader(
        "Set-Cookie",
        [
            `${ADMIN_COOKIE}=${encodeURIComponent(createAdminToken())}`,
            "Path=/",
            "HttpOnly",
            "SameSite=Lax",
            "Max-Age=604800",
            secure
                ? "Secure"
                : ""
        ]
            .filter(Boolean)
            .join("; ")
    );

}


function clearAdminCookie(
    res
) {

    const secure =
        process.env.NODE_ENV ===
        "production";


    res.setHeader(
        "Set-Cookie",
        [
            `${ADMIN_COOKIE}=`,
            "Path=/",
            "HttpOnly",
            "SameSite=Lax",
            "Max-Age=0",
            secure
                ? "Secure"
                : ""
        ]
            .filter(Boolean)
            .join("; ")
    );

}


/* =========================================================
   PÁGINA LOGIN ADMIN
   ========================================================= */

function sendAdminLoginPage(
    res
) {

    res.send(`
<!DOCTYPE html>
<html lang="es" class="dark">

<head>

    <meta charset="UTF-8">

    <meta
        name="viewport"
        content="width=device-width, initial-scale=1.0">

    <title>Acceso Restringido</title>

    <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>

    <style>

        body {

            font-family:
                sans-serif;

            background-color:
                #060608;

            color:
                #f4f4f5;

        }

    </style>

</head>


<body
    class="min-h-screen flex items-center justify-center p-6">


<div
    class="bg-zinc-900 border border-amber-500/30 p-8 rounded-3xl max-w-sm w-full space-y-4 shadow-2xl">


    <h1
        class="text-sm font-bold text-amber-400 uppercase tracking-wider text-center">

        Identificación Requerida

    </h1>


    <input
        type="password"
        id="pin-input"
        placeholder="Introduce tu PIN"
        autocomplete="current-password"
        class="w-full bg-zinc-950 border border-white/10 rounded-xl px-4 py-3 text-sm text-zinc-100 focus:outline-none focus:border-amber-500 text-center tracking-widest">


    <button
        onclick="loginAdmin()"
        id="login-button"
        class="w-full bg-amber-500 hover:bg-amber-400 text-zinc-950 font-bold py-3 rounded-xl text-xs cursor-pointer">

        Acceder al Panel

    </button>


    <p
        id="error-msg"
        class="text-xs text-red-400 text-center min-h-4">

    </p>


</div>


<script>

"use strict";


const pinInput =
    document.getElementById(
        "pin-input"
    );


const loginButton =
    document.getElementById(
        "login-button"
    );


const errorMsg =
    document.getElementById(
        "error-msg"
    );


async function loginAdmin() {

    const pin =
        pinInput.value;


    if (
        !pin
    ) {

        errorMsg.textContent =
            "Introduce tu PIN.";

        return;

    }


    loginButton.disabled =
        true;


    loginButton.textContent =
        "Comprobando...";


    errorMsg.textContent =
        "";


    try {

        const res =
            await fetch(
                "/api/login",
                {

                    method:
                        "POST",

                    credentials:
                        "same-origin",

                    headers: {

                        "Content-Type":
                            "application/json",

                        "Accept":
                            "application/json"

                    },

                    body:
                        JSON.stringify({
                            pin
                        })

                }
            );


        const data =
            await res.json();


        if (
            res.ok &&
            data.success
        ) {

            window.location.href =
                data.redirect;

            return;

        }


        errorMsg.textContent =
            data.error ||
            "PIN incorrecto.";

    } catch (
        error
    ) {

        console.error(
            error
        );


        errorMsg.textContent =
            "Error de conexión.";

    }


    loginButton.disabled =
        false;


    loginButton.textContent =
        "Acceder al Panel";

}


pinInput.addEventListener(
    "keydown",
    event => {

        if (
            event.key ===
            "Enter"
        ) {

            loginAdmin();

        }

    }
);

</script>


</body>

</html>
    `);

}


/* =========================================================
   RUTA ADMIN
   ========================================================= */

app.get(
    ADMIN_PATH,
    (req, res) => {

        /*
         * SI NO ESTÁ LOGUEADO:
         * mostrar login.
         */

        if (
            !isAdmin(req)
        ) {

            return sendAdminLoginPage(
                res
            );

        }


        /*
         * SI ESTÁ LOGUEADO:
         * mostrar admin.html.
         */

        return res.sendFile(
            path.join(
                __dirname,
                "public",
                "admin.html"
            )
        );

    }
);


/* =========================================================
   ARCHIVOS PÚBLICOS
   ========================================================= */

app.use(
    express.static(
        path.join(
            __dirname,
            "public"
        )
    )
);


/* =========================================================
   CONFIG PÚBLICA
   ========================================================= */

app.get(
    "/api/public-config",
    (req, res) => {

        return res.json({

            supabaseUrl:
                SUPABASE_URL,

            supabasePublishableKey:
                SUPABASE_PUBLISHABLE_KEY,

            bucket:
                STORAGE_BUCKET

        });

    }
);


/* =========================================================
   API PÚBLICA
   ========================================================= */

app.get(
    "/api/nasheeds",
    async (
        req,
        res
    ) => {

        try {

            const {
                data,
                error
            } =
                await supabase
                    .from("nasheeds")
                    .select(
                        "id,title,audio_url,cover_url,subtitles,created_at"
                    )
                    .order(
                        "created_at",
                        {
                            ascending:
                                false
                        }
                    );


            if (
                error
            ) {

                console.error(
                    "Supabase GET nasheeds:",
                    error
                );


                return res
                    .status(500)
                    .json({
                        error:
                            "No se pudieron cargar los nasheeds."
                    });

            }


            return res.json(

                (data || [])
                    .map(
                        item => ({

                            id:
                                Number(
                                    item.id
                                ),

                            title:
                                item.title,

                            file:
                                item.audio_url,

                            cover:
                                item.cover_url ||
                                "",

                            subtitles:
                                item.subtitles ||
                                {}

                        })
                    )

            );

        } catch (
            error
        ) {

            console.error(
                error
            );


            return res
                .status(500)
                .json({
                    error:
                        "Error interno."
                });

        }

    }
);


/* =========================================================
   LOGIN
   ========================================================= */

app.post(
    "/api/login",
    (req, res) => {

        const pin =
            String(
                req.body?.pin ||
                ""
            );


        if (
            pin !==
            ADMIN_PIN
        ) {

            return res
                .status(401)
                .json({

                    success:
                        false,

                    error:
                        "PIN incorrecto"

                });

        }


        setAdminCookie(
            res
        );


        return res.json({

            success:
                true,

            redirect:
                ADMIN_PATH

        });

    }
);


/* =========================================================
   CHECK SESSION
   ========================================================= */

app.get(
    "/api/check-session",
    (req, res) => {

        return res.json({

            isAdmin:
                isAdmin(req)

        });

    }
);


/* =========================================================
   LOGOUT
   ========================================================= */

app.post(
    "/api/logout",
    (req, res) => {

        clearAdminCookie(
            res
        );


        return res.json({

            success:
                true

        });

    }
);


/* =========================================================
   REQUIRE ADMIN
   ========================================================= */

function requireAdmin(
    req,
    res,
    next
) {

    if (
        isAdmin(req)
    ) {

        return next();

    }


    return res
        .status(403)
        .json({

            error:
                "Acceso denegado. No autorizado."

        });

}


/* =========================================================
   ADMIN - LISTAR
   ========================================================= */

app.get(
    "/api/admin/nasheeds",
    requireAdmin,
    async (
        req,
        res
    ) => {

        try {

            const {
                data,
                error
            } =
                await supabase
                    .from("nasheeds")
                    .select(
                        "id,title,audio_url,cover_url,subtitles,created_at"
                    )
                    .order(
                        "created_at",
                        {
                            ascending:
                                false
                        }
                    );


            if (
                error
            ) {

                console.error(
                    error
                );


                return res
                    .status(500)
                    .json({
                        error:
                            "No se pudieron cargar los nasheeds."
                    });

            }


            return res.json(

                (data || [])
                    .map(
                        item => ({

                            id:
                                Number(
                                    item.id
                                ),

                            title:
                                item.title,

                            file:
                                item.audio_url,

                            cover:
                                item.cover_url ||
                                "",

                            subtitles:
                                item.subtitles ||
                                {},

                            created_at:
                                item.created_at

                        })
                    )

            );

        } catch (
            error
        ) {

            console.error(
                error
            );


            return res
                .status(500)
                .json({
                    error:
                        "Error interno."
                });

        }

    }
);


/* =========================================================
   PREPARAR SUBIDA
   ========================================================= */

app.post(
    "/api/upload-prepare",
    requireAdmin,
    async (
        req,
        res
    ) => {

        try {

            const title =
                String(
                    req.body?.title ||
                    ""
                ).trim();


            const files =
                Array.isArray(
                    req.body?.files
                )
                    ? req.body.files
                    : [];


            if (
                !title
            ) {

                return res
                    .status(400)
                    .json({
                        error:
                            "Falta el título."
                    });

            }


            if (
                !files.length
            ) {

                return res
                    .status(400)
                    .json({
                        error:
                            "No hay archivos."
                    });

            }


            if (
                files.length >
                22
            ) {

                return res
                    .status(400)
                    .json({
                        error:
                            "Demasiados archivos."
                    });

            }


            const seenLanguages =
                new Set();


            let hasArabic =
                false;


            const prepared =
                [];


            for (
                const file of
                files
            ) {

                const field =
                    String(
                        file?.field ||
                        ""
                    ).trim();


                const language =
                    String(
                        file?.language ||
                        ""
                    )
                        .trim()
                        .toLowerCase();


                const originalName =
                    String(
                        file?.name ||
                        ""
                    ).trim();


                const contentType =
                    String(
                        file?.type ||
                        "application/octet-stream"
                    ).trim();


                const size =
                    Number(
                        file?.size
                    );


                if (
                    !field ||
                    !originalName ||
                    !Number.isFinite(
                        size
                    )
                ) {

                    return res
                        .status(400)
                        .json({
                            error:
                                "Datos de archivo inválidos."
                        });

                }


                if (
                    size <=
                    0
                ) {

                    return res
                        .status(400)
                        .json({
                            error:
                                `Archivo vacío: ${originalName}`
                        });

                }


                if (
                    size >
                    50 *
                    1024 *
                    1024
                ) {

                    return res
                        .status(400)
                        .json({
                            error:
                                `El archivo ${originalName} supera los 50 MB.`
                        });

                }


                if (
                    field ===
                    "subtitles"
                ) {

                    if (
                        !/^[a-z]{2,10}$/.test(
                            language
                        )
                    ) {

                        return res
                            .status(400)
                            .json({
                                error:
                                    `Idioma inválido: ${language}`
                            });

                    }


                    if (
                        seenLanguages.has(
                            language
                        )
                    ) {

                        return res
                            .status(400)
                            .json({
                                error:
                                    `Idioma duplicado: ${language}`
                            });

                    }


                    seenLanguages.add(
                        language
                    );


                    if (
                        language ===
                        "ar"
                    ) {

                        hasArabic =
                            true;

                    }


                    if (
                        !originalName
                            .toLowerCase()
                            .endsWith(
                                ".vtt"
                            )
                    ) {

                        return res
                            .status(400)
                            .json({
                                error:
                                    `${originalName} debe ser .vtt`
                            });

                    }

                }


                if (
                    field ===
                    "audio"
                ) {

                    if (
                        !(
                            contentType.startsWith(
                                "audio/"
                            ) ||
                            /\.(mp3|m4a|aac|wav|ogg|opus|flac)$/i.test(
                                originalName
                            )
                        )
                    ) {

                        return res
                            .status(400)
                            .json({
                                error:
                                    "El archivo de audio no parece válido."
                            });

                    }

                }


                if (
                    field ===
                    "cover"
                ) {

                    if (
                        !(
                            contentType.startsWith(
                                "image/"
                            ) ||
                            /\.(png|jpe?g|webp|gif)$/i.test(
                                originalName
                            )
                        )
                    ) {

                        return res
                            .status(400)
                            .json({
                                error:
                                    "La carátula no parece válida."
                            });

                    }

                }


                let folder =
                    "other";


                if (
                    field ===
                    "audio"
                ) {

                    folder =
                        "audio";

                }


                if (
                    field ===
                    "cover"
                ) {

                    folder =
                        "covers";

                }


                if (
                    field ===
                    "subtitles"
                ) {

                    folder =
                        `subtitles/${language}`;

                }


                const extension =
                    path
                        .extname(
                            originalName
                        )
                        .toLowerCase() ||
                    ".bin";


                const random =
                    crypto
                        .randomBytes(
                            10
                        )
                        .toString(
                            "hex"
                        );


                const storagePath =
                    `${folder}/${Date.now()}-${random}${extension}`;


                const {
                    data,
                    error
                } =
                    await supabase
                        .storage
                        .from(
                            STORAGE_BUCKET
                        )
                        .createSignedUploadUrl(
                            storagePath,
                            {
                                upsert:
                                    false
                            }
                        );


                if (
                    error
                ) {

                    console.error(
                        error
                    );


                    return res
                        .status(500)
                        .json({
                            error:
                                `No se pudo preparar ${originalName}.`
                        });

                }


                const publicUrl =
                    `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${storagePath}`;


                prepared.push({

                    field,

                    language:
                        field ===
                        "subtitles"
                            ? language
                            : "",

                    originalName,

                    contentType,

                    size,

                    path:
                        storagePath,

                    token:
                        data.token,

                    publicUrl

                });

            }


            if (
                !hasArabic
            ) {

                return res
                    .status(400)
                    .json({
                        error:
                            "El VTT árabe es obligatorio."
                    });

            }


            return res.json({

                success:
                    true,

                files:
                    prepared

            });

        } catch (
            error
        ) {

            console.error(
                error
            );


            return res
                .status(500)
                .json({
                    error:
                        "No se pudo preparar la subida."
                });

        }

    }
);


/* =========================================================
   COMPLETAR SUBIDA
   ========================================================= */

app.post(
    "/api/upload-complete",
    requireAdmin,
    async (
        req,
        res
    ) => {

        try {

            const title =
                String(
                    req.body?.title ||
                    ""
                ).trim();


            const files =
                Array.isArray(
                    req.body?.files
                )
                    ? req.body.files
                    : [];


            if (
                !title
            ) {

                return res
                    .status(400)
                    .json({
                        error:
                            "Falta el título."
                    });

            }


            const audio =
                files.find(
                    file =>
                        file.field ===
                        "audio"
                );


            const cover =
                files.find(
                    file =>
                        file.field ===
                        "cover"
                );


            const subtitles =
                files.filter(
                    file =>
                        file.field ===
                        "subtitles"
                );


            if (
                !audio
            ) {

                return res
                    .status(400)
                    .json({
                        error:
                            "Falta el audio."
                    });

            }


            const arabic =
                subtitles.find(
                    file =>
                        file.language ===
                        "ar"
                );


            if (
                !arabic
            ) {

                return res
                    .status(400)
                    .json({
                        error:
                            "Falta el VTT árabe."
                    });

            }


            const subtitleMap =
                {};


            subtitles.forEach(
                file => {

                    subtitleMap[
                        file.language
                    ] =
                        file.publicUrl;

                }
            );


            const record = {

                id:
                    Date.now(),

                title,

                audio_url:
                    audio.publicUrl,

                cover_url:
                    cover
                        ? cover.publicUrl
                        : null,

                subtitles:
                    subtitleMap

            };


            const {
                data,
                error
            } =
                await supabase
                    .from("nasheeds")
                    .insert(
                        record
                    )
                    .select()
                    .single();


            if (
                error
            ) {

                console.error(
                    error
                );


                return res
                    .status(500)
                    .json({
                        error:
                            "No se pudo guardar el nasheed."
                    });

            }


            return res.json({

                success:
                    true,

                track: {

                    id:
                        Number(
                            data.id
                        ),

                    title:
                        data.title,

                    file:
                        data.audio_url,

                    cover:
                        data.cover_url ||
                        "",

                    subtitles:
                        data.subtitles ||
                        {}

                }

            });

        } catch (
            error
        ) {

            console.error(
                error
            );


            return res
                .status(500)
                .json({
                    error:
                        "Error completando la publicación."
                });

        }

    }
);


/* =========================================================
   ELIMINAR NASHEED
   ========================================================= */

app.delete(
    "/api/nasheeds/:id",
    requireAdmin,
    async (
        req,
        res
    ) => {

        try {

            const id =
                Number(
                    req.params.id
                );


            if (
                !Number.isSafeInteger(
                    id
                )
            ) {

                return res
                    .status(400)
                    .json({
                        error:
                            "ID no válido."
                    });

            }


            const {
                data: track,
                error:
                    fetchError
            } =
                await supabase
                    .from("nasheeds")
                    .select(
                        "id,title,audio_url,cover_url,subtitles"
                    )
                    .eq(
                        "id",
                        id
                    )
                    .maybeSingle();


            if (
                fetchError
            ) {

                console.error(
                    fetchError
                );


                return res
                    .status(500)
                    .json({
                        error:
                            "No se pudo obtener el nasheed."
                    });

            }


            if (
                !track
            ) {

                return res
                    .status(404)
                    .json({
                        error:
                            "Nasheed no encontrado."
                    });

            }


            const paths =
                [];


            addStoragePathFromPublicUrl(
                track.audio_url,
                paths
            );


            addStoragePathFromPublicUrl(
                track.cover_url,
                paths
            );


            if (
                track.subtitles &&
                typeof track.subtitles ===
                    "object"
            ) {

                Object.values(
                    track.subtitles
                ).forEach(
                    url => {

                        addStoragePathFromPublicUrl(
                            url,
                            paths
                        );

                    }
                );

            }


            if (
                paths.length
            ) {

                const {
                    error:
                        storageError
                } =
                    await supabase
                        .storage
                        .from(
                            STORAGE_BUCKET
                        )
                        .remove(
                            paths
                        );


                if (
                    storageError
                ) {

                    console.error(
                        storageError
                    );

                }

            }


            const {
                error:
                    deleteError
            } =
                await supabase
                    .from("nasheeds")
                    .delete()
                    .eq(
                        "id",
                        id
                    );


            if (
                deleteError
            ) {

                console.error(
                    deleteError
                );


                return res
                    .status(500)
                    .json({
                        error:
                            "No se pudo eliminar el registro."
                    });

            }


            return res.json({

                success:
                    true

            });

        } catch (
            error
        ) {

            console.error(
                error
            );


            return res
                .status(500)
                .json({
                    error:
                        "Error interno."
                });

        }

    }
);


/* =========================================================
   EXTRAER PATH DE STORAGE
   ========================================================= */

function addStoragePathFromPublicUrl(
    url,
    output
) {

    if (
        typeof url !==
            "string" ||
        !url
    ) {

        return;

    }


    const marker =
        `/storage/v1/object/public/${STORAGE_BUCKET}/`;


    const index =
        url.indexOf(
            marker
        );


    if (
        index ===
        -1
    ) {

        return;

    }


    const storagePath =
        url.slice(
            index +
            marker.length
        );


    if (
        storagePath
    ) {

        output.push(
            decodeURIComponent(
                storagePath
            )
        );

    }

}


/* =========================================================
   ERRORES
   ========================================================= */

app.use(
    (
        err,
        req,
        res,
        next
    ) => {

        console.error(
            "Error interno:",
            err
        );


        if (
            res.headersSent
        ) {

            return next(
                err
            );

        }


        return res
            .status(500)
            .json({
                error:
                    "Error interno del servidor."
            });

    }
);


/* =========================================================
   LOCAL
   ========================================================= */

if (
    require.main ===
    module
) {

    app.listen(
        PORT,
        () => {

            console.log(
                `Servidor Nushud activo en puerto ${PORT}`
            );

        }
    );

}


module.exports =
    app;