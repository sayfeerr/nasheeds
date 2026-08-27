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
 * MODELOS
 *
 * Whisper se utiliza SOLO para escuchar/transcribir.
 *
 * GPT-OSS-20B se utiliza SOLO para:
 * 1. Reconstruir árabe cuando Whisper devuelve transliteración latina.
 * 2. Traducir el árabe real a ES/EN/RU.
 *
 * No estamos intentando utilizar un modelo GPT de OpenAI
 * directamente desde Groq.
 */

const GROQ_STT = "whisper-large-v3-turbo";

const GROQ_TRANSLATION = "openai/gpt-oss-20b";

/*
 * Si quieres priorizar calidad de reconocimiento árabe sobre
 * velocidad/precio, puedes cambiar:
 *
 * whisper-large-v3-turbo
 *
 * por:
 *
 * whisper-large-v3
 *
 * Pero dejamos turbo como opción principal.
 */

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

/*
 * Limpieza específica para textos árabes.
 *
 * No elimina letras árabes.
 * Solo elimina caracteres de control innecesarios.
 */

function cleanArabicText(value) {
    return String(value || "")
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

/* =========================================================
   DETECCIÓN DE ÁRABE
   ========================================================= */

/*
 * Detecta caracteres del alfabeto árabe.
 *
 * Esto es MUY importante porque Whisper puede devolver algo como:
 *
 * "Allahumma salli ala Muhammad..."
 *
 * aunque hayamos solicitado language=ar.
 *
 * No vamos a aceptar eso como subtítulo árabe.
 */

function countArabicLetters(text) {
    const value = String(text || "");

    const matches = value.match(
        /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g
    );

    return matches ? matches.length : 0;
}

function countLatinLetters(text) {
    const value = String(text || "");

    const matches = value.match(
        /[A-Za-zÀ-ÖØ-öø-ÿ]/g
    );

    return matches ? matches.length : 0;
}

function arabicRatio(text) {
    const value = String(text || "");

    const arabic = countArabicLetters(value);
    const latin = countLatinLetters(value);

    const total = arabic + latin;

    if (!total) {
        return 0;
    }

    return arabic / total;
}

function isArabicText(text) {
    const value = cleanArabicText(text);

    if (!value) {
        return false;
    }

    const arabic = countArabicLetters(value);
    const latin = countLatinLetters(value);

    /*
     * Un segmento muy corto puede tener pocas letras.
     * Por eso usamos reglas diferentes dependiendo del tamaño.
     */

    if (arabic >= 2 && latin === 0) {
        return true;
    }

    if (arabic >= 3 && arabicRatio(value) >= 0.35) {
        return true;
    }

    return false;
}

function hasMostlyLatinTransliteration(text) {
    const value = cleanText(text);

    if (!value) {
        return false;
    }

    const arabic = countArabicLetters(value);
    const latin = countLatinLetters(value);

    if (arabic === 0 && latin >= 2) {
        return true;
    }

    if (
        latin >= 5 &&
        latin > arabic * 2
    ) {
        return true;
    }

    return false;
}

function arabicSegmentStats(segments) {
    const valid = segments.filter(
        (segment) =>
            cleanArabicText(segment.text)
    );

    if (!valid.length) {
        return {
            total: 0,
            arabic: 0,
            latin: 0,
            arabicPercentage: 0
        };
    }

    let arabicSegments = 0;
    let latinSegments = 0;

    for (const segment of valid) {
        if (isArabicText(segment.text)) {
            arabicSegments++;
        }

        if (hasMostlyLatinTransliteration(segment.text)) {
            latinSegments++;
        }
    }

    return {
        total: valid.length,
        arabic: arabicSegments,
        latin: latinSegments,
        arabicPercentage:
            Math.round(
                (arabicSegments / valid.length) * 100
            )
    };
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
            start: Number(
                segment?.start
            ),
            end: Number(
                segment?.end
            ),
            text: cleanText(
                segment?.text
            )
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

        lines.push(
            segment.text
        );

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
    if (!apiKey) {
        throw new Error(
            "GROQ_API_KEY no está configurada."
        );
    }

    let lastError = null;

    for (
        let attempt = 1;
        attempt <= maxRetries;
        attempt++
    ) {
        try {
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

            if (
                response.status === 429 &&
                attempt < maxRetries
            ) {
                const retryAfter =
                    Number(
                        response.headers.get(
                            "retry-after"
                        )
                    );

                const waitTime =
                    Number.isFinite(
                        retryAfter
                    ) &&
                    retryAfter > 0
                        ? retryAfter * 1000
                        : attempt * 3000;

                console.warn(
                    `[GROQ 429] Reintentando ${attempt}/${maxRetries} en ${Math.round(waitTime / 1000)}s...`
                );

                await sleep(waitTime);
                continue;
            }

            const raw =
                await response.text();

            let body;

            try {
                body =
                    JSON.parse(raw);
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
        } catch (error) {
            lastError = error;

            if (
                attempt < maxRetries &&
                error?.status !== 401 &&
                error?.status !== 403
            ) {
                await sleep(
                    attempt * 1500
                );
                continue;
            }

            throw error;
        }
    }

    throw (
        lastError ||
        new Error("Error desconocido de Groq.")
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
            "Islamic religious Arabic vocals.",
            "The output MUST be written using Arabic script.",
            "Do NOT transliterate Arabic into Latin letters.",
            "Do NOT translate the lyrics.",
            "Do NOT summarize.",
            "Preserve repeated verses.",
            "Preserve repeated phrases.",
            "Preserve Allah, Muhammad and other Arabic religious names in Arabic script.",
            "The singer may sing rather than speak.",
            "Return the actual Arabic words heard in the audio."
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

    const stats =
        arabicSegmentStats(
            usable
        );

    console.log(
        "[USER NASHEED] Whisper:",
        {
            rawSegments:
                rawSegments.length,
            validSegments:
                usable.length,
            arabicSegments:
                stats.arabic,
            latinSegments:
                stats.latin,
            arabicPercentage:
                stats.arabicPercentage,
            duration:
                result?.duration ?? null
        }
    );

    return usable;
}

/* =========================================================
   RECONSTRUIR ÁRABE
   ========================================================= */

/*
 * Esta es la parte importante.
 *
 * Si Whisper produce:
 *
 * "Allahumma salli ala Muhammad"
 *
 * NO lo guardamos.
 *
 * Se manda al modelo de texto para intentar convertir:
 *
 * "Allahumma salli ala Muhammad"
 *
 * en:
 *
 * "اللهم صل على محمد"
 *
 * sin traducirlo.
 */

function splitIntoBatches(
    segments,
    maxCharacters = 9000
) {
    const batches = [];
    let current = [];
    let currentLength = 0;

    for (
        let i = 0;
        i < segments.length;
        i++
    ) {
        const text =
            cleanText(
                segments[i].text
            );

        const line =
            `${i + 1}. ${text}`;

        const nextLength =
            currentLength +
            line.length +
            1;

        if (
            current.length &&
            nextLength > maxCharacters
        ) {
            batches.push(current);
            current = [];
            currentLength = 0;
        }

        current.push({
            index: i,
            text
        });

        currentLength +=
            line.length + 1;
    }

    if (current.length) {
        batches.push(current);
    }

    return batches;
}

function parseNumberedResponse(
    content
) {
    const map = new Map();

    const lines =
        String(content || "")
            .split(/\r?\n/)
            .map((line) =>
                line.trim()
            )
            .filter(Boolean);

    for (const line of lines) {
        /*
         * Acepta:
         *
         * 1. النص
         * 2) النص
         * 3 - النص
         * 4: النص
         * **1.** النص
         */

        const match =
            line.match(
                /^\s*\**\s*(\d+)\s*(?:[.)\-:]|\*\*)\s*(?:\*\*)?\s*(.+?)\s*$/
            );

        if (!match) {
            continue;
        }

        const index =
            parseInt(
                match[1],
                10
            ) - 1;

        const text =
            cleanArabicText(
                match[2]
            );

        if (
            Number.isInteger(index) &&
            index >= 0 &&
            text
        ) {
            map.set(
                index,
                text
            );
        }
    }

    return map;
}

async function repairArabicBatch(
    batch,
    apiKey
) {
    const input =
        batch
            .map(
                (item) =>
                    `${item.index + 1}. ${item.text}`
            )
            .join("\n");

    const systemPrompt = `
You are an expert Arabic language reconstruction system for Arabic nasheed subtitles.

The input contains Arabic words written incorrectly using Latin-letter transliteration because speech recognition failed to use Arabic script.

Your task is ONLY to convert the transliterated Arabic pronunciation into the correct Arabic SCRIPT.

CRITICAL RULES:
- Do NOT translate.
- Do NOT explain.
- Do NOT summarize.
- Do NOT invent new lyrics.
- Do NOT remove repeated phrases.
- Do NOT change the meaning.
- Do NOT output Latin transliteration.
- Do NOT output English.
- Preserve religious expressions.
- Preserve proper names.
- Preserve repeated lines.
- Use standard written Arabic script.
- Return ONLY the numbered list.
- Keep EXACTLY the same numbering.
- If a line is already Arabic, keep it in Arabic.
- Do not add punctuation or commentary unless it belongs naturally to the Arabic lyric.
`.trim();

    const requestBody = {
        model: GROQ_TRANSLATION,
        temperature: 0.0,
        max_completion_tokens: 4000,
        messages: [
            {
                role: "system",
                content:
                    systemPrompt
            },
            {
                role: "user",
                content:
                    input
            }
        ]
    };

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
                    JSON.stringify(
                        requestBody
                    )
            },
            apiKey
        );

    const rawContent =
        result
            ?.choices
            ?.at(0)
            ?.message
            ?.content || "";

    if (!rawContent) {
        throw new Error(
            "El modelo no devolvió texto al reconstruir el árabe."
        );
    }

    return parseNumberedResponse(
        rawContent
    );
}

async function repairArabicSegments(
    segments,
    apiKey
) {
    const stats =
        arabicSegmentStats(
            segments
        );

    /*
     * Si prácticamente todo ya está en árabe,
     * no gastamos otra llamada.
     */

    if (
        stats.total > 0 &&
        stats.arabicPercentage >= 85 &&
        stats.latin <=
            Math.max(
                1,
                Math.floor(stats.total * 0.10)
            )
    ) {
        console.log(
            "[USER NASHEED] Whisper devolvió suficiente árabe. No se necesita reparación."
        );

        return segments.map(
            (segment) => ({
                ...segment,
                text:
                    cleanArabicText(
                        segment.text
                    )
            })
        );
    }

    console.warn(
        `[USER NASHEED] Whisper devolvió demasiado texto latino (${stats.arabicPercentage}% segmentos árabes). Intentando reconstrucción árabe...`
    );

    const batches =
        splitIntoBatches(
            segments,
            9000
        );

    const repaired =
        new Array(
            segments.length
        );

    for (
        const batch of batches
    ) {
        const map =
            await repairArabicBatch(
                batch,
                apiKey
            );

        for (
            const item of batch
        ) {
            const repairedText =
                map.get(
                    item.index
                );

            if (
                repairedText &&
                isArabicText(
                    repairedText
                )
            ) {
                repaired[item.index] =
                    repairedText;
            } else {
                /*
                 * Si el modelo no pudo reconstruir
                 * esa línea, NO guardamos la
                 * transliteración como si fuera árabe.
                 */
                repaired[item.index] =
                    "";
            }
        }
    }

    const finalSegments =
        segments
            .map(
                (segment, index) => ({
                    start:
                        segment.start,
                    end:
                        segment.end,
                    text:
                        cleanArabicText(
                            repaired[index]
                        )
                })
            )
            .filter(
                (segment) =>
                    segment.text &&
                    isArabicText(
                        segment.text
                    )
            );

    if (!finalSegments.length) {
        throw new Error(
            "Whisper devolvió principalmente transliteración latina y el modelo de reconstrucción no pudo convertirla a texto árabe."
        );
    }

    const finalStats =
        arabicSegmentStats(
            finalSegments
        );

    console.log(
        "[USER NASHEED] Árabe reconstruido:",
        {
            original:
                segments.length,
            final:
                finalSegments.length,
            arabicPercentage:
                finalStats.arabicPercentage
        }
    );

    /*
     * Si hemos perdido demasiados segmentos,
     * preferimos fallar antes que generar un VTT
     * incompleto silenciosamente.
     */

    const minimumAccepted =
        Math.max(
            1,
            Math.floor(
                segments.length * 0.50
            )
        );

    if (
        finalSegments.length <
        minimumAccepted
    ) {
        throw new Error(
            `La reconstrucción árabe fue insuficiente: ${finalSegments.length}/${segments.length} segmentos recuperados. No se generará un VTT incompleto.`
        );
    }

    return finalSegments;
}

/* =========================================================
   TRADUCCIÓN
   ========================================================= */

async function translateBatch(
    segments,
    language,
    apiKey
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

    const input =
        segments
            .map(
                (segment, index) =>
                    `${index + 1}. ${cleanArabicText(segment.text)}`
            )
            .join("\n");

    const systemPrompt = `
You are a professional Arabic-to-${targetLanguage} translator for Islamic nasheed lyrics.

Translate the Arabic lyrics into natural ${targetLanguage}.

CRITICAL RULES:
- Translate the MEANING.
- Do NOT transliterate Arabic.
- Do NOT reproduce Arabic using Latin letters.
- Do NOT explain the translation.
- Do NOT summarize.
- Do NOT add commentary.
- Preserve religious meaning.
- Preserve repeated verses.
- Preserve repeated phrases.
- Preserve proper names appropriately.
- Keep exactly the same numbering.
- Return ONLY the numbered translated lines.
`.trim();

    const requestBody = {
        model: GROQ_TRANSLATION,
        temperature: 0.1,
        max_completion_tokens: 6000,
        messages: [
            {
                role: "system",
                content:
                    systemPrompt
            },
            {
                role: "user",
                content:
                    input
            }
        ]
    };

    let result = null;
    let lastError = null;

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

            break;
        } catch (error) {
            lastError = error;

            console.error(
                `[TRANSLATION ERROR] ${language} intento ${attempt}:`,
                error.message
            );

            if (
                attempt < 3
            ) {
                await sleep(
                    attempt * 2000
                );
            }
        }
    }

    if (!result) {
        throw (
            lastError ||
            new Error(
                `No se pudo traducir a ${targetLanguage}.`
            )
        );
    }

    const rawContent =
        result
            ?.choices
            ?.at(0)
            ?.message
            ?.content || "";

    if (!rawContent.trim()) {
        throw new Error(
            `El modelo no devolvió traducción para ${targetLanguage}.`
        );
    }

    const translatedMap =
        parseNumberedResponse(
            rawContent
        );

    /*
     * Para traducciones usamos un parser
     * específico más permisivo.
     */

    if (
        translatedMap.size === 0
    ) {
        const lines =
            rawContent
                .split(/\r?\n/)
                .map((line) =>
                    line.trim()
                )
                .filter(Boolean);

        for (
            const line of lines
        ) {
            const match =
                line.match(
                    /^\s*\**\s*(\d+)\s*(?:[.)\-:]|\*\*)\s*(?:\*\*)?\s*(.+?)\s*$/
                );

            if (!match) {
                continue;
            }

            const index =
                parseInt(
                    match[1],
                    10
                ) - 1;

            const text =
                cleanText(
                    match[2]
                );

            if (
                index >= 0 &&
                index < segments.length &&
                text
            ) {
                translatedMap.set(
                    index,
                    text
                );
            }
        }
    }

    /*
     * No hacemos fallback a segment.text.
     *
     * Esto es MUY importante.
     *
     * Antes, si la traducción fallaba,
     * tu código podía acabar poniendo el
     * árabe como "traducción".
     */

    const translated =
        segments.map(
            (segment, index) => ({
                start:
                    segment.start,
                end:
                    segment.end,
                text:
                    translatedMap.get(
                        index
                    ) || ""
            })
        );

    const valid =
        translated.filter(
            (segment) =>
                segment.text
        );

    if (!valid.length) {
        throw new Error(
            `No se pudo obtener ninguna línea válida traducida a ${targetLanguage}.`
        );
    }

    /*
     * No permitimos que se haya perdido más
     * de la mitad del contenido.
     */

    const minimumAccepted =
        Math.max(
            1,
            Math.floor(
                segments.length * 0.50
            )
        );

    if (
        valid.length <
        minimumAccepted
    ) {
        throw new Error(
            `La traducción a ${targetLanguage} fue incompleta: ${valid.length}/${segments.length} líneas.`
        );
    }

    /*
     * Para mantener la sincronización,
     * conservamos todos los segmentos originales
     * y, si una línea no llegó, hacemos que falle
     * en lugar de desplazar subtítulos.
     */

    for (
        let i = 0;
        i < translated.length;
        i++
    ) {
        if (
            !translated[i].text
        ) {
            throw new Error(
                `Falta la traducción de la línea ${i + 1} en ${targetLanguage}.`
            );
        }
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
        if (
            language.startsWith("__")
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
                            cover.type || ""
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

                if (existing.error) {
                    throw existing.error;
                }

                if (
                    existing.data &&
                    (
                        String(
                            existing.data.status
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

                let coverSigned =
                    null;

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
                 * =================================================
                 * 5%
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
                    5
                );

                /*
                 * =================================================
                 * CARGAR REGISTRO
                 * =================================================
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
                 * =================================================
                 * URL TEMPORAL DEL AUDIO
                 * =================================================
                 */

                const signedAudio =
                    await supabase
                        .storage
                        .from(BUCKET)
                        .createSignedUrl(
                            row.audio_path,
                            600
                        );

                if (
                    signedAudio.error
                ) {
                    throw signedAudio.error;
                }

                /*
                 * =================================================
                 * 15%
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
                    15
                );

                console.log(
                    "[USER NASHEED] Transcribiendo:",
                    row.title
                );

                /*
                 * =================================================
                 * WHISPER
                 * =================================================
                 */

                let whisperSegments =
                    await transcribeArabic(
                        signedAudio
                            .data
                            .signedUrl,
                        groqApiKey
                    );

                /*
                 * =================================================
                 * 35%
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
                    35
                );

                console.log(
                    "[USER NASHEED] Segmentos Whisper:",
                    whisperSegments.length
                );

                /*
                 * =================================================
                 * REPARAR ÁRABE
                 * =================================================
                 */

                const arabic =
                    await repairArabicSegments(
                        whisperSegments,
                        groqApiKey
                    );

                console.log(
                    "[USER NASHEED] Segmentos árabes finales:",
                    arabic.length
                );

                /*
                 * Verificación final.
                 *
                 * No permitimos generar ar.vtt
                 * si vuelve a ser transliteración.
                 */

                const finalArabicStats =
                    arabicSegmentStats(
                        arabic
                    );

                console.log(
                    "[USER NASHEED] Verificación árabe final:",
                    finalArabicStats
                );

                if (
                    finalArabicStats.arabicPercentage <
                    70
                ) {
                    throw new Error(
                        "La transcripción final no contiene suficiente texto árabe real."
                    );
                }

                /*
                 * =================================================
                 * 50%
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
                    50
                );

                /*
                 * =================================================
                 * PREFIX
                 * =================================================
                 */

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

                /*
                 * =================================================
                 * SUBTÍTULO ÁRABE
                 * =================================================
                 */

                console.log(
                    "[USER NASHEED] Generando ar.vtt..."
                );

                const arabicPath =
                    `${prefix}/subtitles/ar.vtt`;

                const arabicVtt =
                    makeVTT(
                        arabic
                    );

                const arabicUpload =
                    await supabase
                        .storage
                        .from(BUCKET)
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

                console.log(
                    "[USER NASHEED] ar.vtt guardado correctamente."
                );

                /*
                 * =================================================
                 * IDIOMAS SOLICITADOS
                 * =================================================
                 */

                const requested =
                    normalizeLanguages(
                        row.subtitles
                            ?.__requested
                    );

                console.log(
                    "[USER NASHEED] Idiomas solicitados:",
                    requested
                );

                /*
                 * =================================================
                 * TRADUCCIONES
                 * =================================================
                 */

                const totalLangs =
                    requested.length;

                for (
                    let i = 0;
                    i < totalLangs;
                    i++
                ) {
                    const language =
                        requested[i];

                    await checkIfCanceled(
                        supabase,
                        id,
                        currentUser.id
                    );

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
                        `[USER NASHEED] Traduciendo a ${language}...`
                    );

                    const translated =
                        await translateBatch(
                            arabic,
                            language,
                            groqApiKey
                        );

                    const translationPath =
                        `${prefix}/subtitles/${language}.vtt`;

                    const translationVtt =
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

                    console.log(
                        `[USER NASHEED] ${language}.vtt guardado correctamente.`
                    );
                }

                /*
                 * =================================================
                 * 95%
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

                /*
                 * =================================================
                 * READY
                 * =================================================
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

                if (saved.error) {
                    throw saved.error;
                }

                console.log(
                    "[USER NASHEED] PROCESO COMPLETADO:",
                    row.title
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