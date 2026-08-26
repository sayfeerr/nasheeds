"use strict";

const crypto = require("crypto");

/* =========================================================
   CONFIG
   ========================================================= */

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

/*
 * Whisper para transcripción árabe.
 */
const GROQ_STT = "whisper-large-v3-turbo";

/*
 * Modelo separado para traducción.
 * Lo mantenemos distinto de Whisper.
 */
const GROQ_TRANSLATION = "llama-3.3-70b-versatile";


/* =========================================================
   UTILIDADES
   ========================================================= */

function day() {

    return new Date()
        .toISOString()
        .slice(0, 10);

}


function rnd() {

    return crypto
        .randomBytes(10)
        .toString("hex");

}


function ext(
    type,
    name
) {

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

        "audio/mpeg":
            "mp3",

        "audio/mp3":
            "mp3",

        "audio/mp4":
            "m4a",

        "audio/x-m4a":
            "m4a",

        "audio/m4a":
            "m4a",

        "audio/ogg":
            "ogg",

        "audio/wav":
            "wav",

        "audio/x-wav":
            "wav",

        "audio/webm":
            "webm",

        "audio/flac":
            "flac",

        "video/mp4":
            "mp4",

        "video/webm":
            "webm",

        "image/jpeg":
            "jpg",

        "image/png":
            "png",

        "image/webp":
            "webp"

    };

    return byMime[type] || "bin";

}


/* =========================================================
   AUTH USER
   ========================================================= */

async function getUser(
    req,
    supabase
) {

    const authorization =
        String(
            req.headers.authorization || ""
        );

    if (
        !authorization.startsWith("Bearer ")
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


/* =========================================================
   LANGUAGES
   ========================================================= */

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


/* =========================================================
   VTT
   ========================================================= */

function vttTime(
    value
) {

    const milliseconds =
        Math.max(
            0,
            Math.round(
                Number(value || 0) * 1000
            )
        );

    const hours =
        Math.floor(
            milliseconds / 3600000
        );

    const minutes =
        Math.floor(
            (
                milliseconds % 3600000
            ) / 60000
        );

    const seconds =
        Math.floor(
            (
                milliseconds % 60000
            ) / 1000
        );

    const ms =
        milliseconds % 1000;

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


function normalizeSegments(
    segments
) {

    if (
        !Array.isArray(segments)
    ) {

        return [];

    }

    return segments
        .map(
            segment => ({

                start:
                    Number(
                        segment?.start
                    ),

                end:
                    Number(
                        segment?.end
                    ),

                text:
                    cleanText(
                        segment?.text
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
        )
        .sort(
            (a, b) =>
                a.start -
                b.start
        );

}


function makeVTT(
    segments
) {

    const validSegments =
        normalizeSegments(
            segments
        );

    const lines = [
        "WEBVTT",
        ""
    ];

    const MAX_GAP_EXTENSION =
        15;

    for (
        let i = 0;
        i < validSegments.length;
        i++
    ) {

        const segment =
            validSegments[i];

        const next =
            validSegments[i + 1] || null;

        let start =
            segment.start;

        let end =
            segment.end;

        if (
            next &&
            next.start > end
        ) {

            const gap =
                next.start - end;

            if (
                gap <= MAX_GAP_EXTENSION
            ) {

                end =
                    next.start;

            } else {

                end =
                    segment.end +
                    MAX_GAP_EXTENSION;

            }

        }

        if (
            end <= start
        ) {

            continue;

        }

        lines.push(
            `${vttTime(start)} --> ${vttTime(end)}`
        );

        lines.push(
            segment.text
        );

        lines.push("");

    }

    return lines.join("\n");

}


/* =========================================================
   GROQ REQUEST
   ========================================================= */

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
            JSON.parse(raw);

    } catch {

        body = {
            error: {
                message:
                    raw
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


/* =========================================================
   TRANSCRIPCIÓN ÁRABE
   ========================================================= */

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
        normalizeSegments(
            result?.segments
        );

    if (
        !segments.length
    ) {

        throw new Error(
            "La IA no devolvió segmentos de transcripción."
        );

    }

    return segments;

}


/* =========================================================
   PARSE TRANSLATION JSON
   ========================================================= */

function parseTranslationResponse(
    content,
    expectedCount
) {

    let parsed;

    let cleaned =
        String(
            content || ""
        )
            .trim()
            .replace(
                /^```json\s*/i,
                ""
            )
            .replace(
                /^```\s*/i,
                ""
            )
            .replace(
                /\s*```$/i,
                ""
            )
            .trim();

    try {

        parsed =
            JSON.parse(
                cleaned
            );

    } catch {

        /*
         * Intentamos localizar el JSON aunque
         * el modelo haya escrito algo antes/después.
         */

        const start =
            cleaned.indexOf("{");

        const end =
            cleaned.lastIndexOf("}");

        if (
            start !== -1 &&
            end > start
        ) {

            parsed =
                JSON.parse(
                    cleaned.slice(
                        start,
                        end + 1
                    )
                );

        } else {

            throw new Error(
                "La IA no devolvió JSON válido."
            );

        }

    }

    if (
        !parsed ||
        !Array.isArray(
            parsed.translations
        )
    ) {

        throw new Error(
            "La respuesta no contiene translations."
        );

    }

    const map =
        new Map();

    for (
        const item of
        parsed.translations
    ) {

        const index =
            Number(
                item?.i
            );

        const text =
            cleanText(
                item?.text
            );

        if (
            !Number.isInteger(
                index
            )
        ) {

            continue;

        }

        if (
            index < 0 ||
            index >= expectedCount
        ) {

            continue;

        }

        if (!text) {

            continue;

        }

        if (
            !map.has(index)
        ) {

            map.set(
                index,
                text
            );

        }

    }

    return map;

}


/* =========================================================
   TRADUCCIÓN
   ========================================================= */

async function requestTranslation(
    items,
    language,
    apiKey
) {

    const names = {

        es:
            "Spanish",

        en:
            "English",

        ru:
            "Russian"

    };

    const target =
        names[language];

    if (!target) {

        throw new Error(
            `Idioma no soportado: ${language}`
        );

    }

    const input =
        items.map(
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

    const body = {

        model:
            GROQ_TRANSLATION,

        temperature:
            0,

        max_tokens:
            4096,

        response_format: {
            type:
                "json_object"
        },

        messages: [

            {

                role:
                    "system",

                content:
                    `Translate Arabic nasheed lyrics into ${target}.

The input contains numbered subtitle segments.

Return ONLY JSON in exactly this form:

{
  "translations": [
    {
      "i": 0,
      "text": "translation"
    }
  ]
}

Rules:
- Translate every input segment.
- Keep every index.
- Do not omit any segment.
- Do not repeat any index.
- Do not answer in Arabic.
- Do not explain anything.
- Do not use markdown.
- Do not use code fences.
- Preserve religious terminology and meaning faithfully.
- The number of translations must equal the number of input segments.`
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

    };

    const result =
        await groqRequest(
            "https://api.groq.com/openai/v1/chat/completions",
            {
                method:
                    "POST",

                headers: {
                    "Content-Type":
                        "application/json"
                },

                body:
                    JSON.stringify(
                        body
                    )
            },
            apiKey
        );

    const content =
        result
            ?.choices
            ?.[0]
            ?.message
            ?.content ||
        "";

    if (!content) {

        throw new Error(
            `Groq no devolvió traducción para ${target}.`
        );

    }

    return parseTranslationResponse(
        content,
        items.length
    );

}


async function translateBatch(
    batch,
    language,
    apiKey
) {

    const translated =
        new Map();

    /*
     * Primer intento: lote de 10.
     */

    const BATCH_SIZE =
        10;

    for (
        let start = 0;
        start < batch.length;
        start += BATCH_SIZE
    ) {

        const part =
            batch.slice(
                start,
                start + BATCH_SIZE
            );

        let map =
            new Map();

        try {

            map =
                await requestTranslation(
                    part,
                    language,
                    apiKey
                );

        } catch (
            error
        ) {

            console.error(
                `[TRANSLATION ${language}] lote ${start}:`,
                error
            );

        }

        /*
         * Guardamos lo que sí llegó.
         */

        for (
            const [
                index,
                text
            ] of map.entries()
        ) {

            translated.set(
                start + index,
                text
            );

        }

        /*
         * Buscar los que faltan.
         */

        const missing = [];

        for (
            let i = 0;
            i < part.length;
            i++
        ) {

            if (
                !translated.has(
                    start + i
                )
            ) {

                missing.push(i);

            }

        }

        /*
         * Reintentos individuales.
         */

        for (
            const localIndex of
            missing
        ) {

            const globalIndex =
                start + localIndex;

            const segment =
                batch[
                    globalIndex
                ];

            let recovered =
                false;

            for (
                let attempt = 1;
                attempt <= 4;
                attempt++
            ) {

                try {

                    const map =
                        await requestTranslation(
                            [
                                segment
                            ],
                            language,
                            apiKey
                        );

                    const text =
                        map.get(
                            0
                        );

                    if (text) {

                        translated.set(
                            globalIndex,
                            text
                        );

                        recovered =
                            true;

                        console.log(
                            `[TRANSLATION ${language}] segmento ${globalIndex} recuperado en intento ${attempt}`
                        );

                        break;

                    }

                } catch (
                    error
                ) {

                    console.error(
                        `[TRANSLATION ${language}] segmento ${globalIndex}, intento ${attempt}:`,
                        error
                    );

                }

            }

            if (!recovered) {

                /*
                 * Último intento usando JSON Schema estricto.
                 *
                 * GPT-OSS soporta actualmente Structured
                 * Outputs estrictos según la documentación
                 * de Groq.
                 */

                try {

                    const strictBody = {

                        model:
                            "openai/gpt-oss-20b",

                        temperature:
                            0,

                        response_format: {

                            type:
                                "json_schema",

                            json_schema: {

                                name:
                                    "subtitle_translation",

                                strict:
                                    true,

                                schema: {

                                    type:
                                        "object",

                                    properties: {

                                        translations: {

                                            type:
                                                "array",

                                            items: {

                                                type:
                                                    "object",

                                                properties: {

                                                    i: {
                                                        type:
                                                            "integer"
                                                    },

                                                    text: {
                                                        type:
                                                            "string"
                                                    }

                                                },

                                                required: [
                                                    "i",
                                                    "text"
                                                ],

                                                additionalProperties:
                                                    false

                                            }

                                        }

                                    },

                                    required: [
                                        "translations"
                                    ],

                                    additionalProperties:
                                        false

                                }

                            }

                        },

                        messages: [

                            {

                                role:
                                    "system",

                                content:
                                    `Translate this Arabic nasheed subtitle into ${
                                        language === "es"
                                            ? "Spanish"
                                            : language === "en"
                                                ? "English"
                                                : "Russian"
                                    }.

Return the requested JSON structure.
Translate the Arabic text.
Do not return Arabic.
Do not explain anything.`

                            },

                            {

                                role:
                                    "user",

                                content:
                                    JSON.stringify({

                                        translations: [

                                            {

                                                i:
                                                    0,

                                                text:
                                                    segment.text

                                            }

                                        ]

                                    })

                            }

                        ]

                    };

                    const strictResult =
                        await groqRequest(
                            "https://api.groq.com/openai/v1/chat/completions",
                            {
                                method:
                                    "POST",

                                headers: {
                                    "Content-Type":
                                        "application/json"
                                },

                                body:
                                    JSON.stringify(
                                        strictBody
                                    )
                            },
                            apiKey
                        );

                    const content =
                        strictResult
                            ?.choices
                            ?.[0]
                            ?.message
                            ?.content ||
                        "";

                    const map =
                        parseTranslationResponse(
                            content,
                            1
                        );

                    const text =
                        map.get(
                            0
                        );

                    if (text) {

                        translated.set(
                            globalIndex,
                            text
                        );

                        recovered =
                            true;

                    }

                } catch (
                    error
                ) {

                    console.error(
                        `[TRANSLATION ${language}] último intento segmento ${globalIndex}:`,
                        error
                    );

                }

            }

            if (!recovered) {

                throw new Error(
                    `La traducción ${language} no pudo recuperar el segmento ${globalIndex}.`
                );

            }

        }

    }

    /*
     * Verificación final.
     */

    for (
        let i = 0;
        i < batch.length;
        i++
    ) {

        if (
            !translated.has(
                i
            )
        ) {

            throw new Error(
                `La traducción ${language} no pudo recuperar el segmento ${i}.`
            );

        }

    }

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
                translated.get(
                    index
                )

        })
    );

}


async function translateAll(
    segments,
    language,
    apiKey
) {

    const output = [];

    const CHUNK =
        30;

    for (
        let i = 0;
        i < segments.length;
        i += CHUNK
    ) {

        const batch =
            segments.slice(
                i,
                i + CHUNK
            );

        console.log(
            `[TRANSLATION ${language}] Procesando ${i} - ${i + batch.length - 1}`
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


/* =========================================================
   SIGNED URL
   ========================================================= */

async function signUrl(
    supabase,
    storagePath,
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
                storagePath,
                seconds
            );

    if (
        error
    ) {

        throw error;

    }

    return data.signedUrl;

}


/* =========================================================
   PRIVATE TRACK
   ========================================================= */

async function privateTrack(
    supabase,
    row
) {

    const subtitles = {};

    for (
        const [
            language,
            storagePath
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

        if (
            typeof storagePath !==
                "string" ||
            !storagePath
        ) {

            continue;

        }

        subtitles[
            language
        ] =
            await signUrl(
                supabase,
                storagePath,
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


/* =========================================================
   ROUTES
   ========================================================= */

function registerUserNasheedRoutes({
    app,
    supabase,
    groqApiKey
}) {

    /* =====================================================
       USER NASHEEDS
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

            if (!currentUser) {

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

                if (error) {

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
       PREPARE
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

            if (!currentUser) {

                return res
                    .status(401)
                    .json({
                        error:
                            "Debes iniciar sesión."
                    });

            }

            let uploadId =
                null;

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
                    audioSize <= 0 ||
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

                if (cover) {

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
                        coverSize <= 0 ||
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
                    existing.data &&
                    (
                        existing.data.status ===
                            "processing" ||
                        existing.data.status ===
                            "ready"
                    )
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

                if (
                    existing.data &&
                    existing.data.status ===
                        "error"
                ) {

                    uploadId =
                        Number(
                            existing.data.id
                        );

                    const reset =
                        await supabase
                            .from(
                                "user_nasheeds"
                            )
                            .update({

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
                                    null

                            })
                            .eq(
                                "id",
                                uploadId
                            )
                            .eq(
                                "user_id",
                                currentUser.id
                            );

                    if (
                        reset.error
                    ) {

                        throw reset.error;

                    }

                }

                if (!uploadId) {

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

                    uploadId =
                        Number(
                            inserted.data.id
                        );

                }

                const prefix =
                    `${currentUser.id}/${uploadDay}/${uploadId}-${rnd()}`;

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
                            uploadId
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
                        uploadId,

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

                if (
                    uploadId
                ) {

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
                                    "Error preparando la subida."
                                ).slice(
                                    0,
                                    500
                                )

                        })
                        .eq(
                            "id",
                            uploadId
                        )
                        .eq(
                            "user_id",
                            currentUser.id
                        );

                }

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
       PROCESS
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

            if (!currentUser) {

                return res
                    .status(401)
                    .json({

                        error:
                            "Debes iniciar sesión."

                    });

            }

            if (!groqApiKey) {

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

                console.log(
                    "[USER NASHEED] Transcribiendo:",
                    row.title
                );

                const arabic =
                    await transcribeArabic(
                        signedAudio
                            .data
                            .signedUrl,
                        groqApiKey
                    );

                console.log(
                    "[USER NASHEED] Segmentos:",
                    arabic.length
                );

                const prefix =
                    row.audio_path
                        .split("/")
                        .slice(0, -1)
                        .join("/");

                const subtitlePaths =
                    {};

                /*
                 * ÁRABE
                 */

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

                /*
                 * TRADUCCIONES
                 */

                const requested =
                    normalizeLanguages(
                        row
                            .subtitles
                            ?.__requested
                    );

                console.log(
                    "[USER NASHEED] Idiomas:",
                    requested
                );

                for (
                    const language of
                    requested
                ) {

                    console.log(
                        `[USER NASHEED] Traduciendo ${language}`
                    );

                    const translated =
                        await translateAll(
                            arabic,
                            language,
                            groqApiKey
                        );

                    const translationPath =
                        `${prefix}/subtitles/${language}.vtt`;

                    const upload =
                        await supabase
                            .storage
                            .from(
                                BUCKET
                            )
                            .upload(

                                translationPath,

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
                        translationPath;

                }

                /*
                 * READY
                 */

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
       PÚBLICOS + PRIVADOS DEL USUARIO
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
                    privateRows.data || []
                ) {

                    if (
                        !row.audio_path
                    ) {

                        continue;

                    }

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


/* =========================================================
   EXPORT
   ========================================================= */

module.exports = {
    registerUserNasheedRoutes
};