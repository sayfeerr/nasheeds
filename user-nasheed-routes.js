"use strict";

const crypto = require("crypto");

/* =========================================================
   CONFIGURACIÓN
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
 * Whisper principal.
 * Turbo es el modelo económico/rápido.
 */
const GROQ_STT_PRIMARY =
    process.env.GROQ_STT_MODEL ||
    "whisper-large-v3-turbo";

/*
 * Respaldo para casos en los que Turbo devuelva
 * principalmente transliteración latina.
 */
const GROQ_STT_FALLBACK =
    "whisper-large-v3";

/*
 * Modelo de traducción.
 *
 * GPT-OSS 20B está disponible actualmente en Groq
 * y soporta Structured Outputs.
 */
const GROQ_TRANSLATION =
    process.env.GROQ_TRANSLATION_MODEL ||
    "openai/gpt-oss-20b";

/*
 * Número máximo de reintentos.
 */
const GROQ_MAX_RETRIES = 5;

/*
 * Timeout máximo por petición.
 */
const GROQ_TIMEOUT_MS = 90000;

/*
 * Backoff inicial.
 */
const GROQ_RETRY_BASE_MS = 2500;

/*
 * Separación mínima entre peticiones de traducción.
 */
const TRANSLATION_MIN_DELAY_MS = 1200;

/*
 * Tamaño máximo aproximado de cada bloque
 * de traducción.
 */
const TRANSLATION_BATCH_SIZE = 25;

/* =========================================================
   UTILIDADES
   ========================================================= */

const sleep = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms));

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

    if (allowed.includes(extension)) {
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

/* =========================================================
   AUTH USER
   ========================================================= */

async function getUser(req, supabase) {
    const authorization =
        String(
            req.headers.authorization || ""
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

/* =========================================================
   IDIOMAS
   ========================================================= */

function normalizeLanguages(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    return [
        ...new Set(
            value
                .map((item) =>
                    String(item || "")
                        .trim()
                        .toLowerCase()
                )
                .filter((item) =>
                    LANGS.has(item)
                )
        )
    ];
}

/* =========================================================
   TEXTO
   ========================================================= */

function cleanText(value) {
    return String(value || "")
        .replace(/\r/g, " ")
        .replace(/\n+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/*
 * Limpia posibles etiquetas que algunos modelos
 * pueden devolver.
 */
function cleanModelText(value) {
    return String(value || "")
        .replace(/^```[a-zA-Z]*\s*/i, "")
        .replace(/\s*```$/i, "")
        .replace(/^["']+|["']+$/g, "")
        .trim();
}

/* =========================================================
   DETECCIÓN DE ÁRABE
   ========================================================= */

function countArabicCharacters(text) {
    const value = String(text || "");

    const arabicMatches =
        value.match(
            /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g
        );

    return arabicMatches
        ? arabicMatches.length
        : 0;
}

function countLatinLetters(text) {
    const value = String(text || "");

    const latinMatches =
        value.match(
            /[A-Za-zÀ-ÖØ-öø-ÿ]/g
        );

    return latinMatches
        ? latinMatches.length
        : 0;
}

function arabicRatio(text) {
    const value = String(text || "");

    const arabic =
        countArabicCharacters(value);

    const latin =
        countLatinLetters(value);

    const letters =
        arabic + latin;

    if (!letters) {
        return 0;
    }

    return arabic / letters;
}

function containsArabic(text) {
    return (
        countArabicCharacters(text) >= 2
    );
}

function isProbablyTransliteration(text) {
    const value =
        cleanText(text);

    if (!value) {
        return false;
    }

    const arabic =
        countArabicCharacters(value);

    const latin =
        countLatinLetters(value);

    if (arabic === 0 && latin >= 3) {
        return true;
    }

    if (
        latin > 0 &&
        arabic > 0 &&
        arabicRatio(value) < 0.25
    ) {
        return true;
    }

    return false;
}

function arabicQualityScore(segments) {
    if (!Array.isArray(segments) || !segments.length) {
        return 0;
    }

    let totalChars = 0;
    let arabicChars = 0;
    let transliterationSegments = 0;
    let validTextSegments = 0;

    for (const segment of segments) {
        const text =
            cleanText(segment?.text);

        if (!text) {
            continue;
        }

        validTextSegments++;

        const arabic =
            countArabicCharacters(text);

        const latin =
            countLatinLetters(text);

        totalChars +=
            arabic + latin;

        arabicChars += arabic;

        if (
            isProbablyTransliteration(
                text
            )
        ) {
            transliterationSegments++;
        }
    }

    if (!validTextSegments) {
        return 0;
    }

    const characterRatio =
        totalChars > 0
            ? arabicChars / totalChars
            : 0;

    const transliterationRatio =
        transliterationSegments /
        validTextSegments;

    /*
     * Penalizamos fuertemente la transliteración.
     */
    return Math.max(
        0,
        characterRatio -
            transliterationRatio * 0.5
    );
}

/* =========================================================
   SEGMENTOS
   ========================================================= */

function normalizeSegments(segments) {
    if (!Array.isArray(segments)) {
        return [];
    }

    return segments
        .map((segment) => ({
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
        }))
        .filter(
            (segment) =>
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
                a.start - b.start
        );
}

/*
 * Evita huecos/solapamientos graves.
 */
function repairSegments(segments) {
    const normalized =
        normalizeSegments(
            segments
        );

    if (!normalized.length) {
        return [];
    }

    const result = [];

    for (
        let i = 0;
        i < normalized.length;
        i++
    ) {
        const current =
            normalized[i];

        const next =
            normalized[i + 1] ||
            null;

        let start =
            Math.max(
                0,
                current.start
            );

        let end =
            Math.max(
                start + 0.05,
                current.end
            );

        if (
            next &&
            next.start > start &&
            end > next.start
        ) {
            end =
                Math.max(
                    start + 0.05,
                    next.start
                );
        }

        if (
            !Number.isFinite(
                start
            ) ||
            !Number.isFinite(
                end
            ) ||
            end <= start
        ) {
            continue;
        }

        result.push({
            start,
            end,
            text:
                cleanText(
                    current.text
                )
        });
    }

    return result;
}

/* =========================================================
   VTT TIME
   ========================================================= */

function vttTime(value) {
    const milliseconds =
        Math.max(
            0,
            Math.round(
                Number(value || 0) *
                    1000
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
            ) /
                60000
        );

    const seconds =
        Math.floor(
            (
                milliseconds %
                    60000
            ) /
                1000
        );

    const ms =
        milliseconds % 1000;

    return (
        String(hours).padStart(
            2,
            "0"
        ) +
        ":" +
        String(minutes).padStart(
            2,
            "0"
        ) +
        ":" +
        String(seconds).padStart(
            2,
            "0"
        ) +
        "." +
        String(ms).padStart(
            3,
            "0"
        )
    );
}

/* =========================================================
   CREAR VTT
   ========================================================= */

function makeVTT(segments) {
    const validSegments =
        repairSegments(
            segments
        );

    if (!validSegments.length) {
        throw new Error(
            "No hay segmentos válidos para crear el VTT."
        );
    }

    const lines = [
        "WEBVTT",
        ""
    ];

    for (
        let i = 0;
        i < validSegments.length;
        i++
    ) {
        const segment =
            validSegments[i];

        lines.push(
            `${vttTime(
                segment.start
            )} --> ${vttTime(
                segment.end
            )}`
        );

        lines.push(
            segment.text
        );

        lines.push("");
    }

    const vtt =
        lines.join("\n");

    if (
        !vtt ||
        !vtt.includes(
            "WEBVTT"
        ) ||
        vtt.trim().split("\n").length <
            4
    ) {
        throw new Error(
            "No se pudo generar un VTT válido."
        );
    }

    return vtt;
}

/* =========================================================
   CONTROL GLOBAL DE PETICIONES
   ========================================================= */

let lastGroqRequestAt = 0;

async function waitForGroqSlot(
    minimumDelay =
        TRANSLATION_MIN_DELAY_MS
) {
    const now =
        Date.now();

    const elapsed =
        now -
        lastGroqRequestAt;

    if (
        elapsed <
        minimumDelay
    ) {
        await sleep(
            minimumDelay -
                elapsed
        );
    }

    lastGroqRequestAt =
        Date.now();
}

/* =========================================================
   GROQ REQUEST
   ========================================================= */

async function groqRequest(
    url,
    options,
    apiKey,
    maxRetries = GROQ_MAX_RETRIES
) {
    if (!apiKey) {
        throw new Error(
            "GROQ_API_KEY no está configurada."
        );
    }

    let lastError =
        null;

    for (
        let attempt = 1;
        attempt <= maxRetries;
        attempt++
    ) {
        let controller =
            null;

        let timeout =
            null;

        try {
            await waitForGroqSlot();

            controller =
                new AbortController();

            timeout =
                setTimeout(
                    () =>
                        controller.abort(),
                    GROQ_TIMEOUT_MS
                );

            const response =
                await fetch(
                    url,
                    {
                        ...options,
                        signal:
                            controller.signal,
                        headers: {
                            ...(options.headers ||
                                {}),
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
                    raw
                        ? JSON.parse(raw)
                        : null;
            } catch {
                body = {
                    error: {
                        message:
                            raw ||
                            "Respuesta no JSON de Groq."
                    }
                };
            }

            if (
                response.ok
            ) {
                return body;
            }

            const message =
                body?.error
                    ?.message ||
                `Groq HTTP ${response.status}`;

            const error =
                new Error(
                    message
                );

            error.status =
                response.status;

            error.retryAfter =
                Number(
                    response.headers.get(
                        "retry-after"
                    )
                ) || 0;

            /*
             * No tiene sentido reintentar errores
             * permanentes de autenticación o modelo.
             */
            if (
                response.status ===
                    401 ||
                response.status ===
                    403 ||
                response.status ===
                    400
            ) {
                throw error;
            }

            lastError =
                error;

            if (
                attempt >=
                maxRetries
            ) {
                throw error;
            }

            const retryAfterMs =
                error.retryAfter > 0
                    ? error.retryAfter *
                      1000
                    : 0;

            const exponential =
                GROQ_RETRY_BASE_MS *
                Math.pow(
                    2,
                    attempt - 1
                );

            const jitter =
                Math.floor(
                    Math.random() *
                        1000
                );

            const waitTime =
                Math.max(
                    retryAfterMs,
                    exponential +
                        jitter
                );

            console.warn(
                `[GROQ] HTTP ${response.status}. Reintento ${attempt}/${maxRetries} en ${Math.ceil(
                    waitTime / 1000
                )}s.`
            );

            await sleep(
                waitTime
            );
        } catch (error) {
            if (
                error?.name ===
                "AbortError"
            ) {
                lastError =
                    new Error(
                        "Timeout de Groq."
                    );
            } else {
                lastError =
                    error;
            }

            if (
                error?.status ===
                    400 ||
                error?.status ===
                    401 ||
                error?.status ===
                    403
            ) {
                throw error;
            }

            if (
                attempt >=
                maxRetries
            ) {
                throw lastError;
            }

            const exponential =
                GROQ_RETRY_BASE_MS *
                Math.pow(
                    2,
                    attempt - 1
                );

            const jitter =
                Math.floor(
                    Math.random() *
                        1000
                );

            const waitTime =
                exponential +
                jitter;

            console.warn(
                `[GROQ] Error de red/timeout. Reintento ${attempt}/${maxRetries} en ${Math.ceil(
                    waitTime / 1000
                )}s: ${
                    lastError?.message ||
                    "Error desconocido"
                }`
            );

            await sleep(
                waitTime
            );
        } finally {
            if (timeout) {
                clearTimeout(
                    timeout
                );
            }
        }
    }

    throw (
        lastError ||
        new Error(
            "Groq no respondió."
        )
    );
}

/* =========================================================
   TRANSCRIPCIÓN WHISPER
   ========================================================= */

async function transcribeWithModel(
    audioUrl,
    apiKey,
    model,
    retryCount = GROQ_MAX_RETRIES
) {
    const form =
        new FormData();

    form.append(
        "model",
        model
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
        "timestamp_granularities[]",
        "segment"
    );

    form.append(
        "temperature",
        "0"
    );

    form.append(
        "prompt",
        [
            "Arabic language.",
            "Arabic Islamic nasheed.",
            "The output MUST be written using Arabic script.",
            "Transcribe Arabic speech and singing.",
            "DO NOT transliterate Arabic into Latin letters.",
            "DO NOT translate the lyrics.",
            "DO NOT write pronunciation in Latin alphabet.",
            "Use Arabic letters such as ا ب ت ث ج ح خ د ذ ر ز س ش ص ض ط ظ ع غ ف ق ك ل م ن ه و ي.",
            "Preserve repeated verses.",
            "Preserve repeated religious phrases.",
            "Preserve names and Islamic expressions.",
            "Return the spoken/sung Arabic words as Arabic text."
        ].join(" ")
    );

    const result =
        await groqRequest(
            "https://api.groq.com/openai/v1/audio/transcriptions",
            {
                method:
                    "POST",
                body:
                    form
            },
            apiKey,
            retryCount
        );

    if (
        !result ||
        !Array.isArray(
            result.segments
        )
    ) {
        throw new Error(
            `Groq no devolvió segmentos usando ${model}.`
        );
    }

    const segments =
        repairSegments(
            result.segments
        );

    if (!segments.length) {
        throw new Error(
            `La transcripción de ${model} no contiene segmentos válidos.`
        );
    }

    return {
        segments,
        duration:
            result?.duration ??
            null,
        model
    };
}

/* =========================================================
   TRANSCRIPCIÓN ÁRABE ROBUSTA
   ========================================================= */

async function transcribeArabic(
    audioUrl,
    apiKey
) {
    let primaryError =
        null;

    /*
     * Primer intento: Turbo.
     */
    try {
        console.log(
            `[USER NASHEED] Whisper usando ${GROQ_STT_PRIMARY}...`
        );

        const primary =
            await transcribeWithModel(
                audioUrl,
                apiKey,
                GROQ_STT_PRIMARY
            );

        const score =
            arabicQualityScore(
                primary.segments
            );

        console.log(
            "[USER NASHEED] Calidad árabe Turbo:",
            score.toFixed(3)
        );

        /*
         * Consideramos válida la transcripción
         * si contiene una cantidad razonable de árabe.
         */
        if (
            score >= 0.25 &&
            primary.segments.some(
                (segment) =>
                    containsArabic(
                        segment.text
                    )
            )
        ) {
            return primary.segments;
        }

        primaryError =
            new Error(
                "Whisper Turbo devolvió principalmente transliteración latina."
            );

        console.warn(
            "[USER NASHEED]",
            primaryError.message
        );
    } catch (error) {
        primaryError =
            error;

        console.warn(
            "[USER NASHEED] Falló Whisper Turbo:",
            error.message
        );
    }

    /*
     * Segundo modelo: Large V3.
     *
     * Se utiliza únicamente como respaldo cuando
     * Turbo no produce árabe suficientemente bueno.
     */
    try {
        console.log(
            `[USER NASHEED] Activando respaldo ${GROQ_STT_FALLBACK}...`
        );

        const fallback =
            await transcribeWithModel(
                audioUrl,
                apiKey,
                GROQ_STT_FALLBACK
            );

        const score =
            arabicQualityScore(
                fallback.segments
            );

        console.log(
            "[USER NASHEED] Calidad árabe Large V3:",
            score.toFixed(3)
        );

        if (
            score >= 0.15 &&
            fallback.segments.some(
                (segment) =>
                    containsArabic(
                        segment.text
                    )
            )
        ) {
            return fallback.segments;
        }

        throw new Error(
            "Whisper Large V3 tampoco devolvió suficiente texto árabe."
        );
    } catch (fallbackError) {
        console.error(
            "[USER NASHEED] Falló también el respaldo árabe:",
            fallbackError.message
        );

        throw new Error(
            `No se pudo obtener una transcripción árabe fiable. Turbo: ${
                primaryError?.message ||
                "error desconocido"
            }. Respaldo: ${
                fallbackError?.message ||
                "error desconocido"
            }`
        );
    }
}

/* =========================================================
   TRADUCCIÓN ESTRUCTURADA
   ========================================================= */

function getLanguageName(language) {
    const names = {
        es: "Spanish",
        en: "English",
        ru: "Russian"
    };

    return names[language] || null;
}

/*
 * Valida que el resultado de traducción sea realmente
 * texto y no una respuesta vacía.
 */
function normalizeTranslationResult(
    value,
    expectedCount
) {
    if (
        !Array.isArray(value)
    ) {
        return null;
    }

    const result =
        value.map(
            (item) =>
                cleanModelText(
                    item
                )
        );

    if (
        result.length !==
        expectedCount
    ) {
        return null;
    }

    if (
        result.some(
            (text) => !text
        )
    ) {
        return null;
    }

    return result;
}

/* =========================================================
   TRADUCIR BLOQUE
   ========================================================= */

async function translateBatch(
    segments,
    language,
    apiKey
) {
    const targetLanguage =
        getLanguageName(
            language
        );

    if (!targetLanguage) {
        throw new Error(
            `Idioma no soportado: ${language}`
        );
    }

    if (
        !Array.isArray(
            segments
        ) ||
        !segments.length
    ) {
        return [];
    }

    const sourceLines =
        segments.map(
            (segment, index) =>
                `${index + 1}. ${cleanText(
                    segment.text
                )}`
        );

    const schema = {
        type: "object",
        properties: {
            translations: {
                type: "array",
                items: {
                    type: "string"
                }
            }
        },
        required: [
            "translations"
        ],
        additionalProperties:
            false
    };

    const requestBody = {
        model:
            GROQ_TRANSLATION,
        temperature:
            0.1,
        max_completion_tokens:
            4000,
        reasoning_effort:
            "low",
        messages: [
            {
                role:
                    "system",
                content:
                    [
                        "You are a professional translator.",
                        `Translate Arabic nasheed lyrics into ${targetLanguage}.`,
                        "",
                        "IMPORTANT RULES:",
                        "1. Translate the MEANING.",
                        "2. NEVER transliterate Arabic pronunciation.",
                        "3. NEVER return Arabic pronunciation written with Latin letters.",
                        "4. NEVER invent missing lines.",
                        "5. Preserve the exact number and order of lines.",
                        "6. Every input line must have exactly one translation.",
                        "7. Do not merge lines.",
                        "8. Do not split lines.",
                        "9. Do not add explanations.",
                        "10. Return only the structured translations array."
                    ].join("\n")
            },
            {
                role:
                    "user",
                content:
                    sourceLines.join(
                        "\n"
                    )
            }
        ],
        response_format: {
            type:
                "json_schema",
            json_schema: {
                name:
                    "nasheed_translation",
                strict:
                    true,
                schema
            }
        }
    };

    let lastError =
        null;

    for (
        let attempt = 1;
        attempt <= GROQ_MAX_RETRIES;
        attempt++
    ) {
        try {
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
                                requestBody
                            )
                    },
                    apiKey
                );

            const content =
                cleanModelText(
                    result
                        ?.choices?.[0]
                        ?.message
                        ?.content
                );

            if (!content) {
                throw new Error(
                    `Groq no devolvió traducción al ${targetLanguage}.`
                );
            }

            let parsed;

            try {
                parsed =
                    JSON.parse(
                        content
                    );
            } catch {
                throw new Error(
                    "Groq devolvió una respuesta de traducción que no es JSON válido."
                );
            }

            const translations =
                normalizeTranslationResult(
                    parsed?.translations,
                    segments.length
                );

            if (!translations) {
                throw new Error(
                    `Groq no devolvió ${segments.length} traducciones válidas al ${targetLanguage}.`
                );
            }

            return translations;
        } catch (error) {
            lastError =
                error;

            console.warn(
                `[TRANSLATION] ${language} intento ${attempt}/${GROQ_MAX_RETRIES}: ${
                    error.message
                }`
            );

            if (
                attempt <
                GROQ_MAX_RETRIES
            ) {
                const wait =
                    GROQ_RETRY_BASE_MS *
                    Math.pow(
                        2,
                        attempt - 1
                    ) +
                    Math.floor(
                        Math.random() *
                            1000
                    );

                await sleep(
                    wait
                );
            }
        }
    }

    throw (
        lastError ||
        new Error(
            `No se pudo traducir el bloque al ${targetLanguage}.`
        )
    );
}

/* =========================================================
   TRADUCCIÓN COMPLETA
   ========================================================= */

async function translateAllBatch(
    segments,
    language,
    apiKey
) {
    if (
        !Array.isArray(
            segments
        ) ||
        !segments.length
    ) {
        return [];
    }

    const allTranslations =
        [];

    for (
        let start = 0;
        start < segments.length;
        start +=
            TRANSLATION_BATCH_SIZE
    ) {
        const batch =
            segments.slice(
                start,
                start +
                    TRANSLATION_BATCH_SIZE
            );

        console.log(
            `[USER NASHEED] Traducción ${language}: bloque ${
                Math.floor(
                    start /
                        TRANSLATION_BATCH_SIZE
                ) + 1
            }/${Math.ceil(
                segments.length /
                    TRANSLATION_BATCH_SIZE
            )}`
        );

        let translations;

        try {
            translations =
                await translateBatch(
                    batch,
                    language,
                    apiKey
                );
        } catch (error) {
            /*
             * Segundo intento del bloque completo
             * con un retraso adicional.
             */
            console.warn(
                `[USER NASHEED] Reintentando bloque ${language} tras error:`,
                error.message
            );

            await sleep(
                5000
            );

            try {
                translations =
                    await translateBatch(
                        batch,
                        language,
                        apiKey
                    );
            } catch (secondError) {
                /*
                 * Último recurso:
                 * traducimos individualmente.
                 *
                 * Esto evita que un solo segmento
                 * destruya todo el VTT.
                 */
                console.warn(
                    `[USER NASHEED] El bloque ${language} sigue fallando. Activando recuperación individual.`
                );

                translations =
                    [];

                for (
                    let i = 0;
                    i < batch.length;
                    i++
                ) {
                    const single =
                        [
                            batch[i]
                        ];

                    try {
                        const one =
                            await translateBatch(
                                single,
                                language,
                                apiKey
                            );

                        if (
                            Array.isArray(
                                one
                            ) &&
                            one[0]
                        ) {
                            translations.push(
                                one[0]
                            );
                        } else {
                            translations.push(
                                cleanText(
                                    batch[i]
                                        .text
                                )
                            );
                        }
                    } catch (
                        individualError
                    ) {
                        console.error(
                            `[TRANSLATION] No pudo recuperar el segmento ${
                                start + i + 1
                            }: ${
                                individualError.message
                            }`
                        );

                        /*
                         * Fallback seguro.
                         *
                         * Nunca devolvemos undefined.
                         * El VTT seguirá funcionando.
                         */
                        translations.push(
                            cleanText(
                                batch[i]
                                    .text
                            )
                        );

                        /*
                         * Pausa adicional para no
                         * golpear el rate limit.
                         */
                        await sleep(
                            2500
                        );
                    }
                }
            }
        }

        allTranslations.push(
            ...translations
        );

        /*
         * Pausa entre bloques.
         */
        if (
            start +
                TRANSLATION_BATCH_SIZE <
            segments.length
        ) {
            await sleep(
                TRANSLATION_MIN_DELAY_MS
            );
        }
    }

    /*
     * Garantizamos que el número de segmentos
     * coincida exactamente.
     */
    if (
        allTranslations.length !==
        segments.length
    ) {
        while (
            allTranslations.length <
            segments.length
        ) {
            const index =
                allTranslations.length;

            allTranslations.push(
                cleanText(
                    segments[index]
                        ?.text ||
                    ""
                )
            );
        }

        if (
            allTranslations.length >
            segments.length
        ) {
            allTranslations.length =
                segments.length;
        }
    }

    return segments.map(
        (segment, index) => ({
            start:
                segment.start,
            end:
                segment.end,
            text:
                cleanText(
                    allTranslations[
                        index
                    ] ||
                    segment.text
                )
        })
    );
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
            .from(BUCKET)
            .createSignedUrl(
                storagePath,
                seconds
            );

    if (error) {
        throw error;
    }

    if (
        !data ||
        !data.signedUrl
    ) {
        throw new Error(
            "Supabase no devolvió una URL firmada."
        );
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
    const subtitles =
        {};

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

        try {
            subtitles[
                language
            ] =
                await signUrl(
                    supabase,
                    storagePath,
                    86400
                );
        } catch (
            subtitleError
        ) {
            console.error(
                `[PRIVATE TRACK] Error firmando subtítulo ${language}:`,
                subtitleError.message
            );
        }
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
   PROGRESO
   ========================================================= */

async function updateProgress(
    supabase,
    id,
    userId,
    percentage
) {
    try {
        await supabase
            .from(
                "user_nasheeds"
            )
            .update({
                status:
                    `processing_${percentage}%`
            })
            .eq(
                "id",
                id
            )
            .eq(
                "user_id",
                userId
            );
    } catch (error) {
        console.warn(
            "[PROGRESS] No se pudo actualizar:",
            error.message
        );
    }
}

/* =========================================================
   CANCELACIÓN
   ========================================================= */

async function checkIfCanceled(
    supabase,
    id,
    userId
) {
    const {
        data
    } =
        await supabase
            .from(
                "user_nasheeds"
            )
            .select(
                "status"
            )
            .eq(
                "id",
                id
            )
            .eq(
                "user_id",
                userId
            )
            .single();

    if (
        data &&
        data.status ===
            "canceled"
    ) {
        throw new Error(
            "PROCESO_CANCELADO"
        );
    }
}

/* =========================================================
   RUTAS
   ========================================================= */

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
                            (item) => ({
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
                        req.body
                            ?.translations
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
                    existing.data &&
                    (
                        String(
                            existing.data
                                .status ||
                            ""
                        ).startsWith(
                            "processing"
                        ) ||
                        existing.data
                            .status ===
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
                    (
                        existing.data
                            .status ===
                            "error" ||
                        existing.data
                            .status ===
                            "canceled"
                    )
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
                                    "processing_0%",
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

                if (
                    !uploadId
                ) {
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
                                    "processing_0%",
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
       CANCELAR
       ===================================================== */

    app.post(
        "/api/user-nasheeds/:id/cancel",
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

            const result =
                await supabase
                    .from(
                        "user_nasheeds"
                    )
                    .update({
                        status:
                            "canceled",
                        error_message:
                            "Proceso cancelado por el usuario."
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
                result.error
            ) {
                return res
                    .status(500)
                    .json({
                        error:
                            result.error.message
                    });
            }

            return res.json({
                success:
                    true,
                message:
                    "Proceso cancelado."
            });
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
                await checkIfCanceled(
                    supabase,
                    id,
                    currentUser.id
                );

                await updateProgress(
                    supabase,
                    id,
                    currentUser.id,
                    5
                );

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

                if (
                    !signedAudio.data ||
                    !signedAudio.data
                        .signedUrl
                ) {
                    throw new Error(
                        "No se pudo obtener la URL temporal del audio."
                    );
                }

                await checkIfCanceled(
                    supabase,
                    id,
                    currentUser.id
                );

                await updateProgress(
                    supabase,
                    id,
                    currentUser.id,
                    20
                );

                console.log(
                    "[USER NASHEED] Transcribiendo:",
                    row.title
                );

                /*
                 * OBTENCIÓN DEL ÁRABE.
                 */
                const arabic =
                    await transcribeArabic(
                        signedAudio
                            .data
                            .signedUrl,
                        groqApiKey
                    );

                if (
                    !arabic.length
                ) {
                    throw new Error(
                        "Whisper no devolvió segmentos árabes válidos."
                    );
                }

                const arabicScore =
                    arabicQualityScore(
                        arabic
                    );

                console.log(
                    "[USER NASHEED] Segmentos árabes:",
                    arabic.length
                );

                console.log(
                    "[USER NASHEED] Calidad árabe final:",
                    arabicScore.toFixed(
                        3
                    )
                );

                if (
                    !arabic.some(
                        (segment) =>
                            containsArabic(
                                segment.text
                            )
                    )
                ) {
                    throw new Error(
                        "La transcripción final no contiene texto árabe."
                    );
                }

                await checkIfCanceled(
                    supabase,
                    id,
                    currentUser.id
                );

                await updateProgress(
                    supabase,
                    id,
                    currentUser.id,
                    45
                );

                const prefix =
                    row.audio_path
                        .split("/")
                        .slice(
                            0,
                            -1
                        )
                        .join("/");

                const subtitlePaths =
                    {};

                /* =================================================
                   SUBTÍTULO ÁRABE
                   ================================================= */

                const arabicPath =
                    `${prefix}/subtitles/ar.vtt`;

                const arabicVtt =
                    makeVTT(
                        arabic
                    );

                const arabicUpload =
                    await supabase
                        .storage
                        .from(
                            BUCKET
                        )
                        .upload(
                            arabicPath,
                            Buffer.from(
                                arabicVtt,
                                "utf8"
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

                /* =================================================
                   TRADUCCIONES
                   ================================================= */

                const requested =
                    normalizeLanguages(
                        row.subtitles
                            ?.__requested
                    );

                console.log(
                    "[USER NASHEED] Idiomas solicitados:",
                    requested
                );

                const totalLangs =
                    requested.length;

                if (
                    totalLangs === 0
                ) {
                    await updateProgress(
                        supabase,
                        id,
                        currentUser.id,
                        90
                    );
                }

                for (
                    let i = 0;
                    i < totalLangs;
                    i++
                ) {
                    const language =
                        requested[i];

                    if (
                        language ===
                        "ar"
                    ) {
                        continue;
                    }

                    await checkIfCanceled(
                        supabase,
                        id,
                        currentUser.id
                    );

                    const progressPct =
                        Math.min(
                            90,
                            Math.round(
                                50 +
                                (
                                    (
                                        i +
                                        1
                                    ) /
                                    totalLangs
                                ) *
                                40
                            )
                        );

                    await updateProgress(
                        supabase,
                        id,
                        currentUser.id,
                        progressPct
                    );

                    console.log(
                        `[USER NASHEED] Traduciendo a ${language}...`
                    );

                    let translated;

                    try {
                        translated =
                            await translateAllBatch(
                                arabic,
                                language,
                                groqApiKey
                            );
                    } catch (
                        translationError
                    ) {
                        /*
                         * Un idioma que falle no debe
                         * destruir el VTT árabe ni
                         * los demás idiomas.
                         */
                        console.error(
                            `[USER NASHEED] Error traduciendo ${language}:`,
                            translationError.message
                        );

                        /*
                         * Segundo intento global.
                         */
                        await sleep(
                            5000
                        );

                        try {
                            translated =
                                await translateAllBatch(
                                    arabic,
                                    language,
                                    groqApiKey
                                );
                        } catch (
                            secondTranslationError
                        ) {
                            console.error(
                                `[USER NASHEED] Segundo intento fallido para ${language}:`,
                                secondTranslationError.message
                            );

                            /*
                             * Fallback final:
                             * conservamos los tiempos y
                             * el texto original para que
                             * el procesamiento no quede
                             * corrupto.
                             */
                            translated =
                                arabic.map(
                                    (
                                        segment
                                    ) => ({
                                        start:
                                            segment.start,
                                        end:
                                            segment.end,
                                        text:
                                            segment.text
                                    })
                                );
                        }
                    }

                    const translationPath =
                        `${prefix}/subtitles/${language}.vtt`;

                    const translationVtt =
                        makeVTT(
                            translated
                        );

                    const upload =
                        await supabase
                            .storage
                            .from(
                                BUCKET
                            )
                            .upload(
                                translationPath,
                                Buffer.from(
                                    translationVtt,
                                    "utf8"
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

                /* =================================================
                   GUARDAR READY
                   ================================================= */

                await checkIfCanceled(
                    supabase,
                    id,
                    currentUser.id
                );

                await updateProgress(
                    supabase,
                    id,
                    currentUser.id,
                    95
                );

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

                await updateProgress(
                    supabase,
                    id,
                    currentUser.id,
                    100
                );

                return res.json({
                    success:
                        true,
                    id,
                    title:
                        row.title,
                    status:
                        "ready",
                    subtitles:
                        Object.keys(
                            subtitlePaths
                        )
                });
            } catch (
                error
            ) {
                if (
                    error.message ===
                    "PROCESO_CANCELADO"
                ) {
                    console.log(
                        `[USER NASHEED] Subida ${id} abortada por el usuario.`
                    );

                    return res.json({
                        success:
                            false,
                        message:
                            "Proceso cancelado por el usuario."
                    });
                }

                console.error(
                    "[USER NASHEED PROCESS]",
                    error
                );

                try {
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
                } catch (
                    updateError
                ) {
                    console.error(
                        "[USER NASHEED ERROR UPDATE]",
                        updateError
                    );
                }

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
       PÚBLICOS + PRIVADOS
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
                        (item) => ({
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
                    if (
                        !row.audio_path
                    ) {
                        continue;
                    }

                    try {
                        privateTracks.push(
                            await privateTrack(
                                supabase,
                                row
                            )
                        );
                    } catch (
                        trackError
                    ) {
                        console.error(
                            `[PRIVATE TRACK] Error cargando ${row.id}:`,
                            trackError.message
                        );
                    }
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