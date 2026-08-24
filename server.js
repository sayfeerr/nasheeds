const express = require("express");
const crypto = require("crypto");
const path = require("path");
require("dotenv").config();

const {
    createClient
} = require("@supabase/supabase-js");

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
    process.env.SUPABASE_ANON_KEY ||
    "";

const STORAGE_BUCKET =
    "nushud";

const ADMIN_PIN =
    process.env.ADMIN_PIN ||
    "7777";

const ADMIN_PATH =
    process.env.ADMIN_PATH ||
    "/panel-oculto-propietario-xyz";

const SESSION_SECRET =
    process.env.SESSION_SECRET ||
    "nushud-super-secret-key-change-it";

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
                persistSession: false,
                autoRefreshToken: false
            }
        }
    );


// =========================================================
// MIDDLEWARE
// =========================================================

app.use(
    express.json({
        limit: "1mb"
    })
);

app.use(
    express.urlencoded({
        extended: true,
        limit: "1mb"
    })
);


// =========================================================
// COOKIE ADMIN
// =========================================================

const ADMIN_COOKIE =
    "nushud_admin";


function base64UrlEncode(
    value
) {
    return Buffer
        .from(value)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}


function base64UrlDecode(
    value
) {
    value =
        value
            .replace(/-/g, "+")
            .replace(/_/g, "/");

    while (
        value.length % 4
    ) {
        value += "=";
    }

    return Buffer
        .from(value, "base64")
        .toString("utf8");
}


function signValue(
    value
) {
    return crypto
        .createHmac(
            "sha256",
            SESSION_SECRET
        )
        .update(value)
        .digest("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}


function createAdminToken() {

    const payload = {

        admin: true,

        exp:
            Date.now() +
            1000 *
            60 *
            60 *
            24 *
            7

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
        parts.length !== 2
    ) {
        return false;
    }

    const [
        encoded,
        signature
    ] = parts;

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
            !payload.admin
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
        const part of parts
    ) {

        const index =
            part.indexOf("=");

        if (
            index === -1
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
                .slice(index + 1)
                .trim()
        );
    }

    return "";
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


// =========================================================
// REQUIRE ADMIN
// =========================================================

function requireAdmin(
    req,
    res,
    next
) {

    const token =
        getCookie(
            req,
            ADMIN_COOKIE
        );

    if (
        verifyAdminToken(
            token
        )
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


// =========================================================
// ADMIN PAGE
// =========================================================

app.get(
    ADMIN_PATH,
    (req, res) => {

        return res.sendFile(
            path.join(
                __dirname,
                "public",
                "admin.html"
            )
        );

    }
);


// =========================================================
// ARCHIVOS PÚBLICOS
// =========================================================

app.use(
    express.static(
        path.join(
            __dirname,
            "public"
        )
    )
);


// =========================================================
// CONFIG PÚBLICA
// =========================================================

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


// =========================================================
// API PÚBLICA - NASHEEDS
// =========================================================

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

            const result =
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
                    );

            return res.json(
                result
            );

        } catch (
            error
        ) {

            console.error(
                "API pública:",
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


// =========================================================
// LOGIN
// =========================================================

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


// =========================================================
// CHECK SESSION
// =========================================================

app.get(
    "/api/check-session",
    (req, res) => {

        const token =
            getCookie(
                req,
                ADMIN_COOKIE
            );

        return res.json({

            isAdmin:
                verifyAdminToken(
                    token
                )

        });

    }
);


// =========================================================
// LOGOUT
// =========================================================

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


// =========================================================
// ADMIN - LISTAR
// =========================================================

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
                    "Supabase admin list:",
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


// =========================================================
// PREPARAR SUBIDA DIRECTA
// =========================================================

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
                            "No hay archivos para subir."
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
                const file
                of files
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
                    size <= 0
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
                                    `Idioma inválido para ${originalName}.`
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
                                    `El subtítulo ${originalName} debe ser .vtt`
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
                                    "La carátula no parece una imagen."
                            });

                    }

                }

                const extension =
                    path
                        .extname(
                            originalName
                        )
                        .toLowerCase() ||
                    ".bin";

                const safeRandom =
                    crypto.randomBytes(
                        10
                    ).toString(
                        "hex"
                    );

                const safeName =
                    `${Date.now()}-${safeRandom}${extension}`;

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
                        "subtitles/" +
                        language;

                }

                const storagePath =
                    `${folder}/${safeName}`;

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
                        "createSignedUploadUrl:",
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
                "upload-prepare:",
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


// =========================================================
// COMPLETAR PUBLICACIÓN
// =========================================================

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
                            "Falta el subtítulo árabe."
                    });

            }

            const subtitleMap =
                {};

            for (
                const file of subtitles
            ) {

                subtitleMap[
                    file.language
                ] =
                    file.publicUrl;

            }

            const id =
                Date.now();

            const record = {

                id,

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
                    "Supabase insert:",
                    error
                );

                /*
                 * Intentamos borrar
                 * los archivos si
                 * la DB falla.
                 */

                await cleanupStorageFiles(
                    files
                        .map(
                            file =>
                                file.path
                        )
                        .filter(Boolean)
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
                "upload-complete:",
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


// =========================================================
// DELETE
// =========================================================

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
                        "Error borrando Storage:",
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
                "DELETE:",
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


// =========================================================
// LIMPIAR STORAGE
// =========================================================

async function cleanupStorageFiles(
    paths
) {

    const uniquePaths =
        [
            ...new Set(
                paths
                    .filter(Boolean)
            )
        ];

    if (
        !uniquePaths.length
    ) {

        return;

    }

    try {

        await supabase
            .storage
            .from(
                STORAGE_BUCKET
            )
            .remove(
                uniquePaths
            );

    } catch (
        error
    ) {

        console.error(
            "cleanupStorageFiles:",
            error
        );

    }

}


// =========================================================
// EXTRAER PATH DE URL
// =========================================================

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
        index === -1
    ) {

        return;

    }

    const pathValue =
        url.slice(
            index +
            marker.length
        );

    if (
        pathValue
    ) {

        output.push(
            decodeURIComponent(
                pathValue
            )
        );

    }

}


// =========================================================
// ERRORES
// =========================================================

app.use(
    (
        err,
        req,
        res,
        next
    ) => {

        console.error(
            "Unhandled error:",
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


// =========================================================
// LOCAL
// =========================================================

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