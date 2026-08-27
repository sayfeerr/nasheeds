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
 * WHISPER:
 * Se utiliza SOLO para transcribir el audio.
 *
 * TRADUCCIÓN:
 * GPT-OSS 20B está disponible en Groq y aparece
 * dentro de los límites del plan gratuito.
 *
 * IMPORTANTE:
 * El modelo de texto NO genera timestamps.
 * Los timestamps vienen directamente de Whisper.
 */
const GROQ_STT = "whisper-large-v3-turbo";
const GROQ_TRANSLATION = "openai/gpt-oss-20b";

/*
 * Número máximo aproximado de segmentos enviados
 * a GPT en cada bloque.
 *
 * Esto evita respuestas demasiado largas,
 * segmentos perdidos y desorden de numeración.
 */
const TRANSLATION_BATCH_SIZE = 20;


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
    const extension = String(name || "")
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
    const authorization = String(
        req.headers.authorization || ""
    );

    if (!authorization.startsWith("Bearer ")) {
        return null;
    }

    const token = authorization
        .slice(7)
        .trim();

    if (!token) {
        return null;
    }

    try {
        const {
            data,
            error
        } = await supabase.auth.getUser(token);

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
        .replace(/\r|\n+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
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
            start: Number(segment?.start),
            end: Number(segment?.end),
            text: cleanText(segment?.text)
        }))
        .filter(
            (segment) =>
                segment.text &&
                Number.isFinite(segment.start) &&
                Number.isFinite(segment.end) &&
                segment.end > segment.start
        )
        .sort(
            (a, b) =>
                a.start - b.start
        );
}


/* =========================================================
   VTT TIME
   ========================================================= */

function vttTime(value) {
    const milliseconds = Math.max(
        0,
        Math.round(
            Number(value || 0) * 1000
        )
    );

    const hours = Math.floor(
        milliseconds / 3600000
    );

    const minutes = Math.floor(
        (milliseconds % 3600000) / 60000
    );

    const seconds = Math.floor(
        (milliseconds % 60000) / 1000
    );

    const ms = milliseconds % 1000;

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


/* =========================================================
   CREAR VTT
   ========================================================= */

function makeVTT(segments) {
    const validSegments =
        normalizeSegments(segments);

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

        const next =
            validSegments[i + 1] || null;

        const start =
            segment.start;

        let end =
            segment.end;

        /*
         * Nunca permitimos que un subtítulo
         * invada el comienzo del siguiente.
         */
        if (
            next &&
            end > next.start
        ) {
            end = next.start;
        }

        if (end <= start) {
            continue;
        }

        lines.push(
            `${vttTime(start)} --> ${vttTime(end)}`
        );

        lines.push(segment.text);
        lines.push("");
    }

    const vtt =
        lines.join("\n");

    if (
        !vtt ||
        !vtt.includes("WEBVTT")
    ) {
        throw new Error(
            "No se pudo generar el archivo VTT."
        );
    }

    return vtt;
}


/* =========================================================
   GROQ REQUEST
   ========================================================= */

async function groqRequest(
    url,
    options,
    apiKey,
    maxRetries = 5
) {
    for (
        let attempt = 1;
        attempt <= maxRetries;
        attempt++
    ) {
        const response = await fetch(
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

        /*
         * Rate limit.
         */
        if (
            response.status === 429 &&
            attempt < maxRetries
        ) {
            const retryAfterHeader =
                response.headers.get("retry-after");

            const retryAfter =
                Number(retryAfterHeader);

            const waitTime =
                Number.isFinite(retryAfter) &&
                retryAfter > 0
                    ? retryAfter * 1000
                    : attempt * 2000;

            console.warn(
                `[GROQ RATE LIMIT 429] Reintentando ` +
                `(${attempt}/${maxRetries}) en ` +
                `${Math.ceil(waitTime / 1000)}s...`
            );

            await sleep(waitTime);
            continue;
        }

        const raw =
            await response.text();

        let body;

        try {
            body = JSON.parse(raw);
        } catch {
            body = {
                error: {
                    message: raw
                }
            };
        }

        if (!response.ok) {
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

    throw new Error(
        "Groq no respondió después de varios intentos."
    );
}


/* =========================================================
   CONTROL DE PROGRESO
   ========================================================= */

async function updateProgress(
    supabase,
    id,
    userId,
    percentage
) {
    await supabase
        .from("user_nasheeds")
        .update({
            status:
                `processing_${percentage}%`
        })
        .eq("id", id)
        .eq("user_id", userId);
}


async function checkIfCanceled(
    supabase,
    id,
    userId
) {
    const { data } =
        await supabase
            .from("user_nasheeds")
            .select("status")
            .eq("id", id)
            .eq("user_id", userId)
            .single();

    if (
        data &&
        data.status === "canceled"
    ) {
        throw new Error(
            "PROCESO_CANCELADO"
        );
    }
}


/* =========================================================
   DETECCIÓN BÁSICA DE ÁRABE
   ========================================================= */

/*
 * Whisper debería devolver árabe porque le indicamos
 * language=ar.
 *
 * Esta función no intenta decidir si una frase es
 * lingüísticamente perfecta.
 *
 * Solamente evita que una transcripción que sea
 * completamente latina, por ejemplo:
 *
 * "Allahumma salli ala Muhammad"
 *
 * se guarde como si fuera árabe original.
 */

function containsArabic(text) {
    const value = String(text || "");

    if (!value) {
        return false;
    }

    const arabicCharacters =
        value.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g);

    return Boolean(
        arabicCharacters &&
        arabicCharacters.length >= 2
    );
}


function arabicRatio(text) {
    const value = String(text || "");

    if (!value) {
        return 0;
    }

    const letters =
        value.match(/[A-Za-z\u0600-\u06FF]/g) || [];

    if (!letters.length) {
        return 0;
    }

    const arabic =
        value.match(/[\u0600-\u06FF]/g) || [];

    return arabic.length / letters.length;
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

    /*
     * MUY IMPORTANTE:
     * Indicamos árabe explícitamente.
     */
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
            "Arabic nasheed lyrics.",
            "The audio contains Arabic religious vocals.",
            "Transcribe the spoken or sung words in Arabic script.",
            "Use Arabic letters, not Latin transliteration.",
            "Do not translate the lyrics.",
            "Do not transliterate Arabic into Latin characters.",
            "Preserve repeated verses.",
            "Preserve repeated phrases.",
            "Preserve religious expressions.",
            "Preserve names.",
            "Do not summarize.",
            "The final transcription must remain Arabic whenever the audio contains Arabic."
        ].join(" ")
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

    if (
        !result ||
        !Array.isArray(result.segments)
    ) {
        throw new Error(
            "Groq no devolvió segmentos de transcripción."
        );
    }

    const rawSegments =
        result.segments;

    const segments =
        normalizeSegments(
            rawSegments
        );

    if (!segments.length) {
        throw new Error(
            "La IA no devolvió segmentos de transcripción válidos."
        );
    }

    const usable =
        segments.filter(
            (segment) =>
                cleanText(segment.text)
        );

    if (!usable.length) {
        throw new Error(
            "La transcripción no contiene texto utilizable."
        );
    }

    /*
     * Comprobamos cuánto texto contiene caracteres árabes.
     *
     * No rechazamos automáticamente toda la transcripción
     * porque Whisper puede devolver números, signos o
     * pequeños fragmentos sin caracteres árabes.
     */
    const arabicSegments =
        usable.filter(
            (segment) =>
                containsArabic(segment.text)
        );

    const arabicRatioTotal =
        usable.length
            ? arabicSegments.length / usable.length
            : 0;

    console.log(
        "[USER NASHEED] Whisper:",
        {
            rawSegments:
                rawSegments.length,

            validSegments:
                segments.length,

            usableSegments:
                usable.length,

            arabicSegments:
                arabicSegments.length,

            arabicRatio:
                arabicRatioTotal,

            duration:
                result?.duration ?? null
        }
    );

    /*
     * Si prácticamente todo el resultado está en letras
     * latinas, es muy probable que Whisper haya producido
     * transliteración.
     */
    if (
        usable.length >= 3 &&
        arabicRatioTotal < 0.35
    ) {
        throw new Error(
            "Whisper devolvió principalmente transliteración latina en lugar de texto árabe."
        );
    }

    return usable;
}


/* =========================================================
   PARSEAR RESPUESTA DE TRADUCCIÓN
   ========================================================= */

function parseTranslationResponse(
    content,
    expectedCount
) {
    const text =
        String(content || "")
            .trim();

    if (!text) {
        return [];
    }

    /*
     * Primero intentamos JSON.
     *
     * Esperamos:
     *
     * {
     *   "translations": [
     *      "....",
     *      "...."
     *   ]
     * }
     */

    try {
        const json =
            JSON.parse(text);

        if (
            Array.isArray(
                json?.translations
            )
        ) {
            return json.translations
                .slice(0, expectedCount)
                .map((item) =>
                    cleanText(item)
                );
        }

        if (Array.isArray(json)) {
            return json
                .slice(0, expectedCount)
                .map((item) =>
                    cleanText(
                        typeof item === "string"
                            ? item
                            : item?.translation
                    )
                );
        }
    } catch {
        /*
         * Puede venir envuelto en markdown.
         * Lo tratamos abajo.
         */
    }

    /*
     * Quitamos posibles bloques markdown.
     */
    const cleaned =
        text
            .replace(/^```json\s*/i, "")
            .replace(/^```\s*/i, "")
            .replace(/\s*```$/i, "")
            .trim();

    try {
        const json =
            JSON.parse(cleaned);

        if (
            Array.isArray(
                json?.translations
            )
        ) {
            return json.translations
                .slice(0, expectedCount)
                .map((item) =>
                    cleanText(item)
                );
        }

        if (Array.isArray(json)) {
            return json
                .slice(0, expectedCount)
                .map((item) =>
                    cleanText(
                        typeof item === "string"
                            ? item
                            : item?.translation
                    )
                );
        }
    } catch {
        /*
         * Continuamos con parser por líneas.
         */
    }

    /*
     * Último recurso:
     *
     * 1. Traducción
     * 2. Traducción
     *
     * Esto permite recuperarnos de un modelo que
     * ignore el formato JSON.
     */
    const lines =
        cleaned
            .split(/\r?\n/)
            .map((line) =>
                line.trim()
            )
            .filter(Boolean);

    const result = [];

    for (const line of lines) {
        const match =
            line.match(
                /^\s*(\d+)\s*[\.\)\-:]\s*(.+)$/
            );

        if (match) {
            result[
                Number(match[1]) - 1
            ] = cleanText(match[2]);

            continue;
        }

        /*
         * Si no tiene numeración y tenemos pocas líneas,
         * también podemos utilizarlas.
         */
        if (
            result.length < expectedCount &&
            !/^(translation|translations|here|sure|output)/i.test(line)
        ) {
            result.push(
                cleanText(line)
            );
        }
    }

    return result
        .slice(0, expectedCount)
        .map((item) =>
            cleanText(item)
        );
}


/* =========================================================
   VALIDAR TRADUCCIÓN
   ========================================================= */

function isLikelyTransliteration(
    text
) {
    const value =
        cleanText(text);

    if (!value) {
        return true;
    }

    /*
     * Si contiene una cantidad significativa de árabe,
     * no es transliteración latina.
     */
    if (containsArabic(value)) {
        return false;
    }

    /*
     * Texto totalmente latino puede ser perfectamente
     * una traducción española/inglesa/rusa.
     *
     * Esta función se utiliza solamente como una
     * comprobación complementaria.
     */

    return false;
}


function validateTranslation(
    text,
    source,
    language
) {
    const translated =
        cleanText(text);

    if (!translated) {
        return false;
    }

    /*
     * Una traducción no debería ser idéntica al árabe.
     */
    if (
        translated ===
        cleanText(source)
    ) {
        return false;
    }

    /*
     * Para ES/EN/RU aceptamos caracteres latinos
     * y cirílicos según el idioma.
     *
     * No exigimos una proporción concreta porque
     * nombres religiosos pueden mantenerse.
     */
    if (language === "ru") {
        const letters =
            translated.match(/[A-Za-zА-Яа-яЁё\u0600-\u06FF]/g) || [];

        if (!letters.length) {
            return false;
        }
    }

    /*
     * Si GPT devuelve árabe prácticamente intacto,
     * no lo aceptamos como traducción.
     */
    if (
        arabicRatio(translated) > 0.70
    ) {
        return false;
    }

    /*
     * Esta llamada actualmente solo sirve como
     * comprobación defensiva.
     */
    if (
        isLikelyTransliteration(translated) &&
        language === "ru"
    ) {
        /*
         * El ruso puede escribirse en cirílico.
         * No rechazamos por aquí si contiene cirílico.
         */
        if (
            !/[А-Яа-яЁё]/.test(
                translated
            )
        ) {
            return false;
        }
    }

    return true;
}


/* =========================================================
   TRADUCCIÓN DE UN BLOQUE
   ========================================================= */

async function translateBatch(
    segments,
    language,
    apiKey,
    batchNumber,
    totalBatches
) {
    const languageNames = {
        es: "Spanish",
        en: "English",
        ru: "Russian"
    };

    const targetLanguage =
        languageNames[language];

    if (!targetLanguage) {
        throw new Error(
            `Idioma no soportado: ${language}`
        );
    }

    const numberedLines =
        segments.map(
            (segment, index) =>
                `${index + 1}. ${cleanText(segment.text)}`
        );

    const systemPrompt = `
You are a professional translator for Arabic nasheed lyrics.

Translate Arabic lyrics into ${targetLanguage}.

IMPORTANT RULES:

1. Translate the MEANING.
2. Do NOT transliterate Arabic pronunciation.
3. Do NOT write Arabic words using Latin letters.
4. Do NOT repeat the Arabic source.
5. Do NOT summarize.
6. Do NOT merge lines.
7. Do NOT split lines.
8. Preserve the exact order of the input.
9. There must be exactly ${segments.length} translations.
10. Religious expressions and names must be translated naturally when possible.
11. Do not add explanations.
12. Do not add introductions.
13. Do not add comments.
14. Do not create timestamps.
15. Do not create VTT.
16. Return ONLY valid JSON.
17. The JSON must have exactly this structure:

{
  "translations": [
    "translation 1",
    "translation 2"
  ]
}

There must be one translation for every input line.
`.trim();

    const requestBody = {
        model: GROQ_TRANSLATION,

        temperature: 0.1,

        /*
         * El JSON es corto y el bloque tiene solo
         * 20 segmentos.
         */
        max_completion_tokens: 3000,

        messages: [
            {
                role: "system",
                content:
                    systemPrompt
            },
            {
                role: "user",
                content:
                    numberedLines.join("\n")
            }
        ]
    };

    let result = null;

    for (
        let attempt = 1;
        attempt <= 3;
        attempt++
    ) {
        try {
            result =
                await groqRequest(
                    "https://api.groq.com/openai/v1/chat/completions",
                    {
                        method: "POST",
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

            if (result) {
                break;
            }
        } catch (error) {
            console.error(
                `[TRANSLATION BATCH ERROR] ` +
                `${language} bloque ${batchNumber}/${totalBatches} ` +
                `intento ${attempt}:`,
                error.message
            );

            if (attempt < 3) {
                await sleep(
                    1500 * attempt
                );
            } else {
                throw error;
            }
        }
    }

    const rawContent =
        result
            ?.choices
            ?.[0]
            ?.message
            ?.content || "";

    const translations =
        parseTranslationResponse(
            rawContent,
            segments.length
        );

    /*
     * Comprobamos que el modelo haya devuelto
     * EXACTAMENTE el número de segmentos.
     */
    if (
        translations.length !==
        segments.length
    ) {
        throw new Error(
            `GPT no devolvió todas las traducciones del bloque ` +
            `${batchNumber}/${totalBatches}. ` +
            `Esperadas: ${segments.length}. ` +
            `Recibidas: ${translations.length}.`
        );
    }

    const output =
        [];

    for (
        let i = 0;
        i < segments.length;
        i++
    ) {
        const source =
            segments[i].text;

        const translated =
            cleanText(
                translations[i]
            );

        if (
            !validateTranslation(
                translated,
                source,
                language
            )
        ) {
            throw new Error(
                `Traducción inválida en ${language}, ` +
                `segmento ${i + 1} del bloque ` +
                `${batchNumber}/${totalBatches}.`
            );
        }

        /*
         * MUY IMPORTANTE:
         * Los timestamps se copian directamente
         * desde Whisper.
         *
         * GPT NO decide los tiempos.
         */
        output.push({
            start:
                segments[i].start,

            end:
                segments[i].end,

            text:
                translated
        });
    }

    return output;
}


/* =========================================================
   TRADUCCIÓN COMPLETA
   ========================================================= */

async function translateAllBatch(
    segments,
    language,
    apiKey
) {
    if (!Array.isArray(segments)) {
        throw new Error(
            "Segmentos de traducción inválidos."
        );
    }

    if (!segments.length) {
        throw new Error(
            "No hay segmentos para traducir."
        );
    }

    const batches = [];

    for (
        let i = 0;
        i < segments.length;
        i += TRANSLATION_BATCH_SIZE
    ) {
        batches.push(
            segments.slice(
                i,
                i + TRANSLATION_BATCH_SIZE
            )
        );
    }

    const translated = [];

    console.log(
        `[USER NASHEED] Traducción ${language}: ` +
        `${segments.length} segmentos en ` +
        `${batches.length} bloques usando ${GROQ_TRANSLATION}`
    );

    for (
        let i = 0;
        i < batches.length;
        i++
    ) {
        const batch =
            await translateBatch(
                batches[i],
                language,
                apiKey,
                i + 1,
                batches.length
            );

        translated.push(
            ...batch
        );

        /*
         * Pequeña pausa entre bloques para no golpear
         * innecesariamente los límites de Groq.
         */
        if (
            i < batches.length - 1
        ) {
            await sleep(300);
        }
    }

    /*
     * Comprobación final:
     * la traducción debe conservar exactamente
     * la misma cantidad de segmentos.
     */
    if (
        translated.length !==
        segments.length
    ) {
        throw new Error(
            `La traducción ${language} perdió segmentos. ` +
            `Originales: ${segments.length}. ` +
            `Traducidos: ${translated.length}.`
        );
    }

    return translated;
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
        /*
         * Metadatos internos no se exponen.
         */
        if (
            language.startsWith("__")
        ) {
            continue;
        }

        if (
            typeof storagePath !== "string" ||
            !storagePath
        ) {
            continue;
        }

        subtitles[language] =
            await signUrl(
                supabase,
                storagePath,
                86400
            );
    }

    return {
        id:
            Number(row.id),

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
        async (req, res) => {
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
                            data || []
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
            } catch (error) {
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
        async (req, res) => {
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

            let uploadId = null;

            try {
                const title =
                    String(
                        req.body?.title || ""
                    ).trim();

                const audio =
                    req.body?.audio || {};

                const cover =
                    req.body?.cover || null;

                const translations =
                    normalizeLanguages(
                        req.body?.translations
                    );

                const audioSize =
                    Number(audio.size);

                const audioType =
                    String(
                        audio.type || ""
                    );

                if (
                    !title ||
                    title.length > 120
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
                    audioSize > MAX_AUDIO
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
                            cover.type || ""
                        );

                    if (
                        !Number.isFinite(
                            coverSize
                        ) ||
                        coverSize <= 0 ||
                        coverSize > MAX_COVER ||
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

                if (existing.error) {
                    throw existing.error;
                }

                if (
                    existing.data &&
                    (
                        String(
                            existing.data.status || ""
                        ).startsWith(
                            "processing"
                        ) ||
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
                    (
                        existing.data.status ===
                            "error" ||
                        existing.data.status ===
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

                    if (reset.error) {
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
                                    "processing_0%",

                                error_message:
                                    null,

                                upload_day:
                                    uploadDay
                            })
                            .select("id")
                            .single();

                    if (inserted.error) {
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
                        .from(BUCKET)
                        .createSignedUploadUrl(
                            audioPath,
                            {
                                upsert:
                                    false
                            }
                        );

                if (audioSigned.error) {
                    throw audioSigned.error;
                }

                let coverSigned = null;

                if (coverPath) {
                    coverSigned =
                        await supabase
                            .storage
                            .from(BUCKET)
                            .createSignedUploadUrl(
                                coverPath,
                                {
                                    upsert:
                                        false
                                }
                            );

                    if (coverSigned.error) {
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

                if (updated.error) {
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

            } catch (error) {
                console.error(
                    "[USER NASHEED PREPARE]",
                    error
                );

                if (uploadId) {
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
        async (req, res) => {
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

            const id =
                Number(
                    req.params.id
                );

            if (
                !Number.isSafeInteger(id)
            ) {
                return res
                    .status(400)
                    .json({
                        error:
                            "ID no válido."
                    });
            }

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
        async (req, res) => {
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
                !Number.isSafeInteger(id)
            ) {
                return res
                    .status(400)
                    .json({
                        error:
                            "ID no válido."
                    });
            }

            try {
                /*
                 * 10%
                 */
                await checkIfCanceled(
                    supabase,
                    id,
                    currentUser.id
                );

                await updateProgress(
                    supabase,
                    id,
                    currentUser.id,
                    10
                );

                /*
                 * Cargar registro.
                 */
                const query =
                    await supabase
                        .from(
                            "user_nasheeds"
                        )
                        .select("*")
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

                if (!row.audio_path) {
                    return res
                        .status(400)
                        .json({
                            error:
                                "Falta el audio subido."
                        });
                }

                /*
                 * URL temporal para Whisper.
                 */
                const signedAudio =
                    await supabase
                        .storage
                        .from(BUCKET)
                        .createSignedUrl(
                            row.audio_path,
                            600
                        );

                if (signedAudio.error) {
                    throw signedAudio.error;
                }

                /*
                 * 25%
                 */
                await checkIfCanceled(
                    supabase,
                    id,
                    currentUser.id
                );

                await updateProgress(
                    supabase,
                    id,
                    currentUser.id,
                    25
                );

                console.log(
                    "[USER NASHEED] Transcribiendo:",
                    row.title
                );

                /*
                 * =================================================
                 * WHISPER
                 * =================================================
                 *
                 * Aquí se obtiene SOLO el árabe.
                 */
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

                await checkIfCanceled(
                    supabase,
                    id,
                    currentUser.id
                );

                await updateProgress(
                    supabase,
                    id,
                    currentUser.id,
                    50
                );

                /*
                 * =================================================
                 * RUTAS DE SUBTÍTULOS
                 * =================================================
                 */

                const prefix =
                    row.audio_path
                        .split("/")
                        .slice(0, -1)
                        .join("/");

                const subtitlePaths = {};


                /*
                 * =================================================
                 * SUBTÍTULO ÁRABE
                 * =================================================
                 *
                 * IMPORTANTE:
                 *
                 * NO usamos GPT aquí.
                 *
                 * Se genera directamente con la transcripción
                 * árabe de Whisper y sus timestamps.
                 */
                const arabicPath =
                    `${prefix}/subtitles/ar.vtt`;

                const arabicVTT =
                    makeVTT(arabic);

                const arabicUpload =
                    await supabase
                        .storage
                        .from(BUCKET)
                        .upload(
                            arabicPath,
                            Buffer.from(
                                "\uFEFF" +
                                arabicVTT,
                                "utf8"
                            ),
                            {
                                contentType:
                                    "text/vtt; charset=utf-8",

                                upsert:
                                    true
                            }
                        );

                if (arabicUpload.error) {
                    throw arabicUpload.error;
                }

                subtitlePaths.ar =
                    arabicPath;


                /*
                 * =================================================
                 * TRADUCCIONES
                 * =================================================
                 */

                const requested =
                    normalizeLanguages(
                        row
                            .subtitles
                            ?.__requested
                    );

                console.log(
                    "[USER NASHEED] Idiomas solicitados:",
                    requested
                );

                const totalLangs =
                    requested.length;

                /*
                 * Si no se solicitaron traducciones,
                 * simplemente continuamos.
                 */
                for (
                    let i = 0;
                    i < totalLangs;
                    i++
                ) {
                    const language =
                        requested[i];

                    /*
                     * Árabe ya está generado arriba.
                     */
                    if (language === "ar") {
                        continue;
                    }

                    await checkIfCanceled(
                        supabase,
                        id,
                        currentUser.id
                    );

                    /*
                     * Progreso entre 50 y 90%.
                     */
                    const progressPct =
                        totalLangs > 0
                            ? Math.round(
                                50 +
                                (
                                    (i + 1) /
                                    totalLangs
                                ) *
                                40
                            )
                            : 90;

                    await updateProgress(
                        supabase,
                        id,
                        currentUser.id,
                        progressPct
                    );

                    console.log(
                        `[USER NASHEED] Traduciendo a ${language} con ${GROQ_TRANSLATION}...`
                    );

                    /*
                     * =================================================
                     * GPT-OSS:
                     *
                     * SOLO TRADUCE.
                     *
                     * NO modifica timestamps.
                     * =================================================
                     */
                    const translated =
                        await translateAllBatch(
                            arabic,
                            language,
                            groqApiKey
                        );

                    /*
                     * =================================================
                     * GENERAR VTT EN EL SERVIDOR
                     * =================================================
                     *
                     * Los timestamps siguen siendo exactamente
                     * los de Whisper.
                     */
                    const translationPath =
                        `${prefix}/subtitles/${language}.vtt`;

                    const translationVTT =
                        makeVTT(
                            translated
                        );

                    const upload =
                        await supabase
                            .storage
                            .from(BUCKET)
                            .upload(
                                translationPath,
                                Buffer.from(
                                    "\uFEFF" +
                                    translationVTT,
                                    "utf8"
                                ),
                                {
                                    contentType:
                                        "text/vtt; charset=utf-8",

                                    upsert:
                                        true
                                }
                            );

                    if (upload.error) {
                        throw upload.error;
                    }

                    subtitlePaths[
                        language
                    ] =
                        translationPath;

                    console.log(
                        `[USER NASHEED] ${language}.vtt generado correctamente.`
                    );
                }


                /*
                 * =================================================
                 * GUARDAR COMO READY
                 * =================================================
                 */

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

                if (saved.error) {
                    throw saved.error;
                }

                console.log(
                    `[USER NASHEED] ${row.title} procesado correctamente.`
                );

                return res.json({
                    success:
                        true,

                    id,

                    title:
                        row.title,

                    status:
                        "ready"
                });

            } catch (error) {
                /*
                 * Cancelación normal.
                 */
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
       PÚBLICOS + PRIVADOS
       ===================================================== */

    app.get(
        "/api/nasheeds",
        async (req, res) => {
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

                if (publicRows.error) {
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

                if (!currentUser) {
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

                if (privateRows.error) {
                    throw privateRows.error;
                }

                const privateTracks =
                    [];

                for (
                    const row of
                    privateRows.data || []
                ) {
                    if (!row.audio_path) {
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

            } catch (error) {
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