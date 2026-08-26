"use strict";

const crypto = require("crypto");

const BUCKET = "UserNasheeds";

const MAX_AUDIO = 25 * 1024 * 1024;
const MAX_COVER = 5 * 1024 * 1024;

const AUDIO_TYPES = new Set([
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

const COVER_TYPES = new Set([
    "image/jpeg",
    "image/png",
    "image/webp"
]);

const LANGS = new Set([
    "es",
    "en",
    "ru"
]);

const GROQ_STT = "whisper-large-v3-turbo";
const GROQ_LLM = "openai/gpt-oss-20b";

function day() {
    return new Date().toISOString().slice(0, 10);
}

function rnd() {
    return crypto.randomBytes(10).toString("hex");
}

function ext(type, name) {

    const extension =
        String(name || "")
            .split(".")
            .pop()
            .toLowerCase();

    const allowed = [
        "mp3",
        "m4a",
        "mp4",
        "mpga",
        "mpeg",
        "ogg",
        "wav",
        "webm",
        "flac",
        "jpg",
        "jpeg",
        "png",
        "webp"
    ];

    if (
        allowed.includes(
            extension
        )
    ) {
        return extension === "jpeg"
            ? "jpg"
            : extension;
    }

    const byMime = {
        "audio/mpeg": "mp3",
        "audio/mp3": "mp3",
        "audio/mp4": "m4a",
        "audio/x-m4a": "m4a",
        "audio/m4a": "m4a",
        "audio/ogg": "ogg",
        "audio/wav": "wav",
        "audio/x-wav": "wav",
        "audio/webm": "webm",
        "audio/flac": "flac",
        "video/mp4": "mp4",
        "video/webm": "webm",
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp"
    };

    return byMime[type] || "bin";
}

async function getUser(
    req,
    supabase
) {

    const authorization =
        String(
            req.headers.authorization ||
            ""
        );

    if (
        !authorization.startsWith(
            "Bearer "
        )
    ) {
        return null;
    }

    const token =
        authorization
            .slice(7)
            .trim();

    if (!token) {
        return null;
    }

    try {

        const {
            data,
            error
        } =
            await supabase.auth.getUser(
                token
            );

        if (
            error ||
            !data ||
            !data.user
        ) {
            return null;
        }

        return data.user;

    } catch {

        return null;

    }
}

function normalizeLanguages(
    value
) {

    if (
        !Array.isArray(value)
    ) {
        return [];
    }

    return [
        ...new Set(
            value
                .map(
                    item =>
                        String(
                            item || ""
                        )
                            .trim()
                            .toLowerCase()
                )
                .filter(
                    item =>
                        LANGS.has(item)
                )
        )
    ];
}

function vttTime(
    value
) {

    const milliseconds =
        Math.max(
            0,
            Math.round(
                Number(
                    value || 0
                ) * 1000
            )
        );

    const hours =
        Math.floor(
            milliseconds /
                3600000
        );

    const minutes =
        Math.floor(
            (
                milliseconds %
                3600000
            ) / 60000
        );

    const seconds =
        Math.floor(
            (
                milliseconds %
                60000
            ) / 1000
        );

    const ms =
        milliseconds %
        1000;

    return (
        String(hours).padStart(2, "0") +
        ":" +
        String(minutes).padStart(2, "0") +
        ":" +
        String(seconds).padStart(2, "0") +
        "." +
        String(ms).padStart(3, "0")
    );
}

function cleanText(
    value
) {

    return String(
        value || ""
    )
        .replace(
            /\r|\n+/g,
            " "
        )
        .replace(
            /\s+/g,
            " "
        )
        .trim();
}

function makeVTT(
    segments
) {

    const lines = [
        "WEBVTT",
        ""
    ];

    for (
        const segment of segments
    ) {

        const text =
            cleanText(
                segment.text
            );

        const start =
            Number(
                segment.start
            );

        const end =
            Number(
                segment.end
            );

        if (
            !text ||
            !Number.isFinite(start) ||
            !Number.isFinite(end) ||
            end <= start
        ) {
            continue;
        }

        lines.push(
            `${vttTime(start)} --> ${vttTime(end)}`
        );

        lines.push(
            text
        );

        lines.push(
            ""
        );
    }

    return lines.join(
        "\n"
    );
}

async function groqRequest(
    url,
    options,
    apiKey
) {

    const response =
        await fetch(
            url,
            {
                ...options,
                headers: {
                    ...(options.headers || {}),
                    Authorization:
                        `Bearer ${apiKey}`
                }
            }
        );

    const raw =
        await response.text();

    let body;

    try {

        body =
            JSON.parse(
                raw
            );

    } catch {

        body = {
            error: {
                message: raw
            }
        };

    }

    if (
        !response.ok
    ) {

        const error =
            new Error(
                body?.error?.message ||
                `Groq HTTP ${response.status}`
            );

        error.status =
            response.status;

        throw error;
    }

    return body;
}

async function transcribeArabic(
    audioUrl,
    apiKey
) {

    const form =
        new FormData();

    form.append(
        "model",
        GROQ_STT
    );

    form.append(
        "url",
        audioUrl
    );

    form.append(
        "language",
        "ar"
    );

    form.append(
        "response_format",
        "verbose_json"
    );

    form.append(
        "timestamp_granularities",
        "segment"
    );

    form.append(
        "temperature",
        "0"
    );

    const result =
        await groqRequest(
            "https://api.groq.com/openai/v1/audio/transcriptions",
            {
                method: "POST",
                body: form
            },
            apiKey
        );

    const segments =
        Array.isArray(
            result.segments
        )
            ? result.segments
            : [];

    const cleanSegments =
        segments
            .map(
                segment => ({
                    start:
                        Number(
                            segment.start
                        ),
                    end:
                        Number(
                            segment.end
                        ),
                    text:
                        cleanText(
                            segment.text
                        )
                })
            )
            .filter(
                segment =>
                    segment.text &&
                    Number.isFinite(
                        segment.start
                    ) &&
                    Number.isFinite(
                        segment.end
                    ) &&
                    segment.end >
                        segment.start
            );

    if (
        !cleanSegments.length
    ) {
        throw new Error(
            "La IA no devolvió segmentos."
        );
    }

    return cleanSegments;
}

async function translateBatch(
    batch,
    language,
    apiKey
) {

    const languageNames = {
        es: "Spanish",
        en: "English",
        ru: "Russian"
    };

    const input =
        batch.map(
            (
                segment,
                index
            ) => ({
                i:
                    index,
                text:
                    segment.text
            })
        );

    const result =
        await groqRequest(
            "https://api.groq.com/openai/v1/chat/completions",
            {
                method: "POST",
                headers: {
                    "Content-Type":
                        "application/json"
                },
                body:
                    JSON.stringify({
                        model:
                            GROQ_LLM,
                        temperature:
                            0.1,
                        response_format: {
                            type:
                                "json_object"
                        },
                        messages: [
                            {
                                role:
                                    "system",
                                content:
                                    `Translate Arabic nasheed lyrics into ${languageNames[language]}. ` +
                                    "Return only JSON in the form " +
                                    '{"translations":[{"i":0,"text":"..."}]}. ' +
                                    "Keep every index and preserve the meaning. " +
                                    "Do not add explanations."
                            },
                            {
                                role:
                                    "user",
                                content:
                                    JSON.stringify({
                                        translations:
                                            input
                                    })
                            }
                        ]
                    })
            },
            apiKey
        );

    let content =
        result?.choices?.[0]?.message?.content ||
        "";

    content =
        content
            .trim()
            .replace(
                /^```(?:json)?\s*/i,
                ""
            )
            .replace(
                /\s*```$/,
                ""
            );

    let parsed;

    try {

        parsed =
            JSON.parse(
                content
            );

    } catch {

        throw new Error(
            `La traducción ${language} no devolvió JSON válido.`
        );
    }

    const map =
        new Map(
            (
                parsed.translations ||
                []
            ).map(
                item => [
                    Number(
                        item.i
                    ),
                    cleanText(
                        item.text
                    )
                ]
            )
        );

    return batch.map(
        (
            original,
            index
        ) => ({
            start:
                original.start,
            end:
                original.end,
            text:
                map.get(index) ||
                original.text
        })
    );
}

async function translateAll(
    segments,
    language,
    apiKey
) {

    const output = [];

    for (
        let i = 0;
        i < segments.length;
        i += 45
    ) {

        const batch =
            segments.slice(
                i,
                i + 45
            );

        const translated =
            await translateBatch(
                batch,
                language,
                apiKey
            );

        output.push(
            ...translated
        );
    }

    return output;
}

async function signUrl(
    supabase,
    path,
    seconds
) {

    const {
        data,
        error
    } =
        await supabase.storage
            .from(
                BUCKET
            )
            .createSignedUrl(
                path,
                seconds
            );

    if (
        error
    ) {
        throw error;
    }

    return data.signedUrl;
}

async function privateTrack(
    supabase,
    row
) {

    const subtitles =
        {};

    for (
        const [
            language,
            path
        ] of Object.entries(
            row.subtitles || {}
        )
    ) {

        if (
            language.startsWith(
                "__"
            )
        ) {
            continue;
        }

        subtitles[
            language
        ] =
            await signUrl(
                supabase,
                path,
                86400
            );
    }

    return {
        id:
            Number(
                row.id
            ),

        title:
            row.title,

        file:
            await signUrl(
                supabase,
                row.audio_path,
                86400
            ),

        cover:
            row.cover_path
                ? await signUrl(
                    supabase,
                    row.cover_path,
                    86400
                )
                : "",

        subtitles,

        warning:
            false,

        private:
            true,

        status:
            row.status,

        created_at:
            row.created_at
    };
}

function registerUserNasheedRoutes({
    app,
    supabase,
    groqApiKey
}) {

    /* =====================================================
       LISTA DEL USUARIO
       ===================================================== */

    app.get(
        "/api/user-nasheeds",
        async (
            req,
            res
        ) => {

            const currentUser =
                await getUser(
                    req,
                    supabase
                );

            if (
                !currentUser
            ) {
                return res
                    .status(401)
                    .json({
                        error:
                            "Debes iniciar sesión."
                    });
            }

            try {

                const {
                    data,
                    error
                } =
                    await supabase
                        .from(
                            "user_nasheeds"
                        )
                        .select(
                            "id,title,status,error_message,created_at,upload_day"
                        )
                        .eq(
                            "user_id",
                            currentUser.id
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
                    throw error;
                }

                return res.json({
                    nasheeds:
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
                                status:
                                    item.status,
                                error:
                                    item.error_message ||
                                    null,
                                created_at:
                                    item.created_at,
                                upload_day:
                                    item.upload_day
                            })
                        )
                });

            } catch (
                error
            ) {

                console.error(
                    "[USER NASHEEDS LIST]",
                    error
                );

                return res
                    .status(500)
                    .json({
                        error:
                            "No se pudieron cargar tus nasheeds."
                    });
            }
        }
    );


    /* =====================================================
       PREPARAR SUBIDA
       ===================================================== */

    app.post(
        "/api/user-nasheeds/prepare",
        async (
            req,
            res
        ) => {

            const currentUser =
                await getUser(
                    req,
                    supabase
                );

            if (
                !currentUser
            ) {
                return res
                    .status(401)
                    .json({
                        error:
                            "Debes iniciar sesión."
                    });
            }

            try {

                const title =
                    String(
                        req.body?.title ||
                        ""
                    ).trim();

                const audio =
                    req.body?.audio ||
                    {};

                const cover =
                    req.body?.cover ||
                    null;

                const translations =
                    normalizeLanguages(
                        req.body?.translations
                    );

                const audioSize =
                    Number(
                        audio.size
                    );

                const audioType =
                    String(
                        audio.type ||
                        ""
                    );

                if (
                    !title ||
                    title.length >
                        120
                ) {
                    return res
                        .status(400)
                        .json({
                            error:
                                "El título es obligatorio y debe tener como máximo 120 caracteres."
                        });
                }

                if (
                    !Number.isFinite(
                        audioSize
                    ) ||
                    audioSize <=
                        0 ||
                    audioSize >
                        MAX_AUDIO
                ) {
                    return res
                        .status(400)
                        .json({
                            error:
                                "El audio debe pesar como máximo 25 MB."
                        });
                }

                if (
                    !AUDIO_TYPES.has(
                        audioType
                    )
                ) {
                    return res
                        .status(400)
                        .json({
                            error:
                                "Formato de audio no compatible."
                        });
                }

                if (
                    cover
                ) {

                    const coverSize =
                        Number(
                            cover.size
                        );

                    const coverType =
                        String(
                            cover.type ||
                            ""
                        );

                    if (
                        !Number.isFinite(
                            coverSize
                        ) ||
                        coverSize <=
                            0 ||
                        coverSize >
                            MAX_COVER ||
                        !COVER_TYPES.has(
                            coverType
                        )
                    ) {
                        return res
                            .status(400)
                            .json({
                                error:
                                    "La portada debe ser JPG, PNG o WebP y pesar como máximo 5 MB."
                            });
                    }
                }

                const uploadDay =
                    day();

                const existing =
                    await supabase
                        .from(
                            "user_nasheeds"
                        )
                        .select(
                            "id,status,title"
                        )
                        .eq(
                            "user_id",
                            currentUser.id
                        )
                        .eq(
                            "upload_day",
                            uploadDay
                        )
                        .maybeSingle();

                if (
                    existing.error
                ) {
                    throw existing.error;
                }

                if (
                    existing.data
                ) {
                    return res
                        .status(409)
                        .json({
                            error:
                                "Ya tienes una subida para hoy.",
                            id:
                                Number(
                                    existing.data.id
                                ),
                            status:
                                existing.data.status
                        });
                }

                const inserted =
                    await supabase
                        .from(
                            "user_nasheeds"
                        )
                        .insert({
                            user_id:
                                currentUser.id,
                            title,
                            audio_path:
                                "",
                            cover_path:
                                null,
                            subtitles: {
                                __requested:
                                    translations
                            },
                            status:
                                "processing",
                            error_message:
                                null,
                            upload_day:
                                uploadDay
                        })
                        .select(
                            "id"
                        )
                        .single();

                if (
                    inserted.error
                ) {
                    throw inserted.error;
                }

                const prefix =
                    `${currentUser.id}/${uploadDay}/${inserted.data.id}-${rnd()}`;

                const audioPath =
                    `${prefix}/audio.${ext(
                        audioType,
                        audio.name
                    )}`;

                const coverPath =
                    cover
                        ? `${prefix}/cover.${ext(
                            cover.type,
                            cover.name
                        )}`
                        : null;

                const audioSigned =
                    await supabase
                        .storage
                        .from(
                            BUCKET
                        )
                        .createSignedUploadUrl(
                            audioPath,
                            {
                                upsert:
                                    false
                            }
                        );

                if (
                    audioSigned.error
                ) {
                    throw audioSigned.error;
                }

                let coverSigned =
                    null;

                if (
                    coverPath
                ) {

                    coverSigned =
                        await supabase
                            .storage
                            .from(
                                BUCKET
                            )
                            .createSignedUploadUrl(
                                coverPath,
                                {
                                    upsert:
                                        false
                                }
                            );

                    if (
                        coverSigned.error
                    ) {
                        throw coverSigned.error;
                    }
                }

                const updated =
                    await supabase
                        .from(
                            "user_nasheeds"
                        )
                        .update({
                            audio_path:
                                audioPath,
                            cover_path:
                                coverPath
                        })
                        .eq(
                            "id",
                            inserted.data.id
                        )
                        .eq(
                            "user_id",
                            currentUser.id
                        );

                if (
                    updated.error
                ) {
                    throw updated.error;
                }

                return res.json({
                    success:
                        true,

                    id:
                        Number(
                            inserted.data.id
                        ),

                    audio: {
                        path:
                            audioPath,
                        token:
                            audioSigned
                                .data
                                .token
                    },

                    cover:
                        coverSigned
                            ? {
                                path:
                                    coverPath,
                                token:
                                    coverSigned
                                        .data
                                        .token
                            }
                            : null
                });

            } catch (
                error
            ) {

                console.error(
                    "[USER NASHEED PREPARE]",
                    error
                );

                return res
                    .status(500)
                    .json({
                        error:
                            error.message ||
                            "No se pudo preparar la subida."
                    });
            }
        }
    );


    /* =====================================================
       PROCESAR
       ===================================================== */

    app.post(
        "/api/user-nasheeds/:id/process",
        async (
            req,
            res
        ) => {

            const currentUser =
                await getUser(
                    req,
                    supabase
                );

            if (
                !currentUser
            ) {
                return res
                    .status(401)
                    .json({
                        error:
                            "Debes iniciar sesión."
                    });
            }

            if (
                !groqApiKey
            ) {
                return res
                    .status(503)
                    .json({
                        error:
                            "GROQ_API_KEY no está configurada."
                    });
            }

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

            try {

                const query =
                    await supabase
                        .from(
                            "user_nasheeds"
                        )
                        .select(
                            "*"
                        )
                        .eq(
                            "id",
                            id
                        )
                        .eq(
                            "user_id",
                            currentUser.id
                        )
                        .single();

                if (
                    query.error ||
                    !query.data
                ) {
                    return res
                        .status(404)
                        .json({
                            error:
                                "Nasheed no encontrado."
                        });
                }

                const row =
                    query.data;

                if (
                    !row.audio_path
                ) {
                    return res
                        .status(400)
                        .json({
                            error:
                                "Falta el audio subido."
                        });
                }

                const signedAudio =
                    await supabase
                        .storage
                        .from(
                            BUCKET
                        )
                        .createSignedUrl(
                            row.audio_path,
                            600
                        );

                if (
                    signedAudio.error
                ) {
                    throw signedAudio.error;
                }

                const arabic =
                    await transcribeArabic(
                        signedAudio
                            .data
                            .signedUrl,
                        groqApiKey
                    );

                const prefix =
                    row.audio_path
                        .split(
                            "/"
                        )
                        .slice(
                            0,
                            -1
                        )
                        .join(
                            "/"
                        );

                const subtitlePaths =
                    {};

                const arabicPath =
                    `${prefix}/subtitles/ar.vtt`;

                const arabicUpload =
                    await supabase
                        .storage
                        .from(
                            BUCKET
                        )
                        .upload(
                            arabicPath,
                            Buffer.from(
                                makeVTT(
                                    arabic
                                )
                            ),
                            {
                                contentType:
                                    "text/vtt; charset=utf-8",
                                upsert:
                                    true
                            }
                        );

                if (
                    arabicUpload.error
                ) {
                    throw arabicUpload.error;
                }

                subtitlePaths.ar =
                    arabicPath;

                const requested =
                    normalizeLanguages(
                        row
                            .subtitles
                            ?.__requested
                    );

                for (
                    const language of
                    requested
                ) {

                    const translated =
                        await translateAll(
                            arabic,
                            language,
                            groqApiKey
                        );

                    const path =
                        `${prefix}/subtitles/${language}.vtt`;

                    const upload =
                        await supabase
                            .storage
                            .from(
                                BUCKET
                            )
                            .upload(
                                path,
                                Buffer.from(
                                    makeVTT(
                                        translated
                                    )
                                ),
                                {
                                    contentType:
                                        "text/vtt; charset=utf-8",
                                    upsert:
                                        true
                                }
                            );

                    if (
                        upload.error
                    ) {
                        throw upload.error;
                    }

                    subtitlePaths[
                        language
                    ] =
                        path;
                }

                const saved =
                    await supabase
                        .from(
                            "user_nasheeds"
                        )
                        .update({
                            subtitles:
                                subtitlePaths,
                            status:
                                "ready",
                            error_message:
                                null
                        })
                        .eq(
                            "id",
                            id
                        )
                        .eq(
                            "user_id",
                            currentUser.id
                        );

                if (
                    saved.error
                ) {
                    throw saved.error;
                }

                return res.json({
                    success:
                        true,
                    id,
                    title:
                        row.title,
                    status:
                        "ready"
                });

            } catch (
                error
            ) {

                console.error(
                    "[USER NASHEED PROCESS]",
                    error
                );

                await supabase
                    .from(
                        "user_nasheeds"
                    )
                    .update({
                        status:
                            "error",
                        error_message:
                            String(
                                error.message ||
                                "Error"
                            ).slice(
                                0,
                                500
                            )
                    })
                    .eq(
                        "id",
                        id
                    )
                    .eq(
                        "user_id",
                        currentUser.id
                    );

                return res
                    .status(
                        error.status ===
                            429
                            ? 429
                            : 500
                    )
                    .json({
                        error:
                            error.message ||
                            "No se pudo procesar el nasheed."
                    });
            }
        }
    );


    /* =====================================================
       NASHEEDS PUBLICOS + PRIVADOS DEL USUARIO
       ===================================================== */

    app.get(
        "/api/nasheeds",
        async (
            req,
            res
        ) => {

            try {

                const publicRows =
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
                    publicRows.error
                ) {
                    throw publicRows.error;
                }

                const publicTracks =
                    (
                        publicRows.data ||
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
                            private:
                                false
                        })
                    );

                const currentUser =
                    await getUser(
                        req,
                        supabase
                    );

                if (
                    !currentUser
                ) {
                    return res.json(
                        publicTracks
                    );
                }

                const privateRows =
                    await supabase
                        .from(
                            "user_nasheeds"
                        )
                        .select(
                            "id,title,audio_path,cover_path,subtitles,status,created_at"
                        )
                        .eq(
                            "user_id",
                            currentUser.id
                        )
                        .eq(
                            "status",
                            "ready"
                        )
                        .order(
                            "created_at",
                            {
                                ascending:
                                    false
                            }
                        );

                if (
                    privateRows.error
                ) {
                    throw privateRows.error;
                }

                const privateTracks =
                    [];

                for (
                    const row of
                    privateRows.data ||
                    []
                ) {

                    privateTracks.push(
                        await privateTrack(
                            supabase,
                            row
                        )
                    );
                }

                return res.json([
                    ...privateTracks,
                    ...publicTracks
                ]);

            } catch (
                error
            ) {

                console.error(
                    "[NASHEEDS API]",
                    error
                );

                return res
                    .status(500)
                    .json({
                        error:
                            "No se pudieron cargar los nasheeds."
                    });
            }
        }
    );
}

module.exports = {
    registerUserNasheedRoutes
};