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
    process.env.SUPABASE_URL ||
    "";

const SUPABASE_SECRET_KEY =
    process.env.SUPABASE_SECRET_KEY ||
    "";

const SUPABASE_PUBLISHABLE_KEY =
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    "";

const STORAGE_BUCKET =
    "Nasheeds";

const ADMIN_PIN =
    process.env.ADMIN_PIN ||
    "";

const ADMIN_PATH =
    process.env.ADMIN_PATH ||
    "/panel-oculto-propietario-xyz";

const SESSION_SECRET =
    process.env.SESSION_SECRET ||
    "nasheed-change-this-secret";


if (
    !SUPABASE_URL ||
    !SUPABASE_SECRET_KEY
) {

    console.error(
        "Faltan SUPABASE_URL o SUPABASE_SECRET_KEY en las variables de entorno."
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
   ADMIN SESSION
   ========================================================= */

const ADMIN_COOKIE =
    "nasheed_admin";


function base64UrlEncode(
    value
) {

    return Buffer
        .from(
            value
        )
        .toString(
            "base64"
        )
        .replace(
            /\+/g,
            "-"
        )
        .replace(
            /\//g,
            "_"
        )
        .replace(
            /=+$/,
            ""
        );

}


function base64UrlDecode(
    value
) {

    let normalized =
        String(
            value
        )
            .replace(
                /-/g,
                "+"
            )
            .replace(
                /_/g,
                "/"
            );

    while (
        normalized.length %
        4
    ) {

        normalized +=
            "=";

    }

    return Buffer
        .from(
            normalized,
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
        .digest(
            "base64"
        )
        .replace(
            /\+/g,
            "-"
        )
        .replace(
            /\//g,
            "_"
        )
        .replace(
            /=+$/,
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
                7 *
                24 *
                60 *
                60 *
                1000
            )

    };

    const encoded =
        base64UrlEncode(
            JSON.stringify(
                payload
            )
        );

    return (
        encoded +
        "." +
        signValue(
            encoded
        )
    );

}


function verifyAdminToken(
    token
) {

    if (
        !token
    ) {

        return false;

    }

    const parts =
        String(
            token
        ).split(
            "."
        );

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

        return (
            payload.admin ===
                true &&
            Number.isFinite(
                payload.exp
            ) &&
            Date.now() <
                payload.exp
        );

    } catch {

        return false;

    }

}


function getCookie(
    req,
    name
) {

    const cookieHeader =
        req.headers.cookie;

    if (
        !cookieHeader
    ) {

        return "";

    }

    const cookies =
        cookieHeader.split(
            ";"
        );

    for (
        const cookie of
        cookies
    ) {

        const index =
            cookie.indexOf(
                "="
            );

        if (
            index ===
            -1
        ) {

            continue;

        }

        const key =
            cookie
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
            cookie
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

    const isProduction =
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
            isProduction
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

    const isProduction =
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
            isProduction
                ? "Secure"
                : ""
        ]
            .filter(Boolean)
            .join("; ")
    );

}


/* =========================================================
   ADMIN LOGIN PAGE
   ========================================================= */

function sendLoginPage(
    res
) {

    return res.send(`
<!DOCTYPE html>
<html lang="es" class="dark">

<head>

    <meta charset="UTF-8">

    <meta
        name="viewport"
        content="width=device-width, initial-scale=1.0">

    <title>NASHEED - Admin</title>

    <script
        src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4">
    </script>

</head>

<body
    class="min-h-screen bg-[#060608] text-zinc-100 flex items-center justify-center p-6">

<div
    class="w-full max-w-sm rounded-3xl p-8 bg-zinc-900/80 backdrop-blur-2xl border border-amber-500/20 shadow-2xl">

    <div
        class="text-center mb-7">

        <div
            class="w-14 h-14 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-amber-400 to-amber-600 flex items-center justify-center text-zinc-950 font-black text-xl">

            N

        </div>

        <h1
            class="text-sm font-extrabold tracking-[.22em] text-amber-400">

            NASHEED

        </h1>

        <p
            class="text-xs text-zinc-500 mt-2">

            Acceso privado

        </p>

    </div>


    <input
        id="pin"
        type="password"
        inputmode="numeric"
        placeholder="PIN"
        class="w-full bg-zinc-950 border border-white/10 rounded-xl px-4 py-3 text-sm text-center tracking-[.35em] outline-none focus:border-amber-500">


    <button
        id="loginButton"
        onclick="login()"
        class="w-full mt-3 bg-amber-500 hover:bg-amber-400 text-zinc-950 font-bold py-3 rounded-xl text-xs">

        Entrar

    </button>


    <div
        id="error"
        class="text-center text-xs text-red-400 min-h-4 mt-3">

    </div>

</div>


<script>

const pin =
    document.getElementById(
        "pin"
    );

const button =
    document.getElementById(
        "loginButton"
    );

const error =
    document.getElementById(
        "error"
    );


async function login() {

    button.disabled =
        true;

    button.textContent =
        "Comprobando...";

    error.textContent =
        "";


    try {

        const response =
            await fetch(
                "/api/login",
                {

                    method:
                        "POST",

                    credentials:
                        "same-origin",

                    headers: {

                        "Content-Type":
                            "application/json"

                    },

                    body:
                        JSON.stringify({

                            pin:
                                pin.value

                        })

                }
            );


        const data =
            await response.json();


        if (
            response.ok &&
            data.success
        ) {

            window.location.href =
                data.redirect;

            return;

        }


        error.textContent =
            data.error ||
            "PIN incorrecto.";

    } catch {

        error.textContent =
            "Error de conexión.";

    }


    button.disabled =
        false;

    button.textContent =
        "Entrar";

}


pin.addEventListener(
    "keydown",
    event => {

        if (
            event.key ===
            "Enter"
        ) {

            login();

        }

    }
);

</script>

</body>

</html>
    `);

}


/* =========================================================
   STATIC / ADMIN
   ========================================================= */

app.get(
    ADMIN_PATH,
    (
        req,
        res
    ) => {

        if (
            !isAdmin(req)
        ) {

            return sendLoginPage(
                res
            );

        }

        return res.sendFile(
            path.join(
                __dirname,
                "public",
                "admin.html"
            )
        );

    }
);


app.use(
    express.static(
        path.join(
            __dirname,
            "public"
        )
    )
);


/* =========================================================
   LOGIN
   ========================================================= */

app.post(
    "/api/login",
    (
        req,
        res
    ) => {

        const pin =
            String(
                req.body?.pin ||
                ""
            );

        if (
            !ADMIN_PIN ||
            pin !==
                ADMIN_PIN
        ) {

            return res
                .status(401)
                .json({
                    success:
                        false,

                    error:
                        "PIN incorrecto."
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
   LOGOUT
   ========================================================= */

app.post(
    "/api/logout",
    (
        req,
        res
    ) => {

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
   PUBLIC CONFIG
   ========================================================= */

app.get(
    "/api/public-config",
    (
        req,
        res
    ) => {

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
                "Acceso denegado."
        });

}


/* =========================================================
   PUBLIC NASHEEDS
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
                    .from(
                        "nasheeds"
                    )
                    .select(
                        "id,title,audio_url,cover_url,subtitles,warning_enabled,created_at"
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
                (
                    data ||
                    []
                ).map(
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

                        warning:
                            Boolean(
                                item.warning_enabled
                            )

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
   ADMIN LIST
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
                    .from(
                        "nasheeds"
                    )
                    .select(
                        "id,title,audio_url,cover_url,subtitles,warning_enabled,created_at"
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
                (
                    data ||
                    []
                ).map(
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

                        warning:
                            Boolean(
                                item.warning_enabled
                            ),

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
   PREPARE UPLOAD
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


            let hasArabic =
                false;


            const languages =
                new Set();


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
                    );


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
                    size >
                    50 *
                    1024 *
                    1024
                ) {

                    return res
                        .status(400)
                        .json({
                            error:
                                `El archivo "${originalName}" supera los 50 MB.`
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
                        languages.has(
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


                    languages.add(
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
                                    `${originalName} debe ser un VTT.`
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
                    path.extname(
                        originalName
                    ) ||
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
                            "Debes añadir el subtítulo árabe."
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
   COMPLETE UPLOAD
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


            const warningEnabled =
                Boolean(
                    req.body?.warningEnabled
                );


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
                !audio
            ) {

                return res
                    .status(400)
                    .json({
                        error:
                            "Falta el audio."
                    });

            }


            if (
                !subtitles.some(
                    file =>
                        file.language ===
                        "ar"
                )
            ) {

                return res
                    .status(400)
                    .json({
                        error:
                            "Falta el subtítulo árabe."
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


            const insertData = {

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
                    subtitleMap,

                warning_enabled:
                    warningEnabled

            };


            const {
                data,
                error
            } =
                await supabase
                    .from(
                        "nasheeds"
                    )
                    .insert(
                        insertData
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
                        {},

                    warning:
                        Boolean(
                            data.warning_enabled
                        )

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
                        "Error guardando el nasheed."
                });

        }

    }
);


/* =========================================================
   CAMBIAR ADVERTENCIA
   ========================================================= */

app.patch(
    "/api/admin/nasheeds/:id/warning",
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


            const enabled =
                Boolean(
                    req.body?.enabled
                );


            const {
                data,
                error
            } =
                await supabase
                    .from(
                        "nasheeds"
                    )
                    .update({

                        warning_enabled:
                            enabled

                    })
                    .eq(
                        "id",
                        id
                    )
                    .select(
                        "id,warning_enabled"
                    )
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
                            "No se pudo actualizar la advertencia."
                    });

            }


            return res.json({

                success:
                    true,

                id:
                    Number(
                        data.id
                    ),

                warning:
                    Boolean(
                        data.warning_enabled
                    )

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
   DELETE
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
                    findError
            } =
                await supabase
                    .from(
                        "nasheeds"
                    )
                    .select(
                        "id,audio_url,cover_url,subtitles"
                    )
                    .eq(
                        "id",
                        id
                    )
                    .maybeSingle();


            if (
                findError
            ) {

                console.error(
                    findError
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


            addStoragePath(
                track.audio_url,
                paths
            );


            addStoragePath(
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

                        addStoragePath(
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
                    .from(
                        "nasheeds"
                    )
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
   STORAGE URL -> PATH
   ========================================================= */

function addStoragePath(
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
   ERROR HANDLER
   ========================================================= */

app.use(
    (
        error,
        req,
        res,
        next
    ) => {

        console.error(
            error
        );


        if (
            res.headersSent
        ) {

            return next(
                error
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
                `NASHEED activo en puerto ${PORT}`
            );

        }
    );

}


module.exports =
    app;