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

const GROQ_STT = "whisper-large-v3-turbo";
const GROQ_TRANSLATION = "llama-3.1-8b-instant";

const GROQ_BASE_URL =
    "https://api.groq.com/openai/v1";

const GROQ_MAX_RETRIES = 5;
const GROQ_TIMEOUT_MS = 60000;
const GROQ_MIN_REQUEST_INTERVAL = 1200;

let lastGroqRequestAt = 0;

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
   AUTH
   ========================================================= */

async function getUser(req, supabase) {
    const authorization =
        String(
            req.headers.authorization || ""
        );

    if (!authorization.startsWith("Bearer ")) {
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

function isUsefulText(value) {
    return cleanText(value).length > 0;
}

function containsArabic(text) {
    return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(
        String(text || "")
    );
}

function isMostlyLatin(text) {
    const value = String(text || "").trim();

    if (!value) {
        return false;
    }

    const arabic =
        (
            value.match(
                /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g
            ) || []
        ).length;

    const latin =
        (
            value.match(
                /[A-Za-zÀ-ÿ]/g
            ) || []
        ).length;

    return arabic === 0 && latin >= 3;
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
   VTT
   ========================================================= */

function vttTime(value) {
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
            (milliseconds % 3600000) / 60000
        );

    const seconds =
        Math.floor(
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
            Math.max(0, segment.start);

        let end =
            Math.max(start, segment.end);

        if (next && end > next.start) {
            end = next.start;
        }

        if (end <= start) {
            end = start + 0.5;
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
            "No se pudo generar el VTT."
        );
    }

    return vtt;
}

/* =========================================================
   GROQ RATE LIMIT / TIMEOUT / DEBUG
   ========================================================= */

async function waitForGroqSlot() {
    const now = Date.now();

    const elapsed =
        now - lastGroqRequestAt;

    if (
        elapsed <
        GROQ_MIN_REQUEST_INTERVAL
    ) {
        await sleep(
            GROQ_MIN_REQUEST_INTERVAL -
            elapsed
        );
    }

    lastGroqRequestAt =
        Date.now();
}

function getRetryDelay(attempt, response) {
    const retryAfter =
        response?.headers?.get(
            "retry-after"
        );

    if (retryAfter) {
        const seconds =
            Number(retryAfter);

        if (
            Number.isFinite(seconds) &&
            seconds >= 0
        ) {
            return Math.min(
                seconds * 1000,
                30000
            );
        }
    }

    const base =
        Math.pow(2, attempt - 1) * 1500;

    const jitter =
        Math.floor(
            Math.random() * 1000
        );

    return Math.min(
        base + jitter,
        30000
    );
}

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

    let lastError = null;

    for (
        let attempt = 1;
        attempt <= maxRetries;
        attempt++
    ) {
        let controller = null;
        let timeout = null;

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
                            ...(options.headers || {}),
                            Authorization:
                                `Bearer ${apiKey}`
                        }
                    }
                );

            const raw =
                await response.text();

            console.log(
                `[GROQ DEBUG] HTTP ${response.status} | intento ${attempt}/${maxRetries}`
            );

            console.log(
                `[GROQ DEBUG] Respuesta: ${raw.slice(0, 10000)}`
            );

            let body = null;

            if (raw.trim()) {
                try {
                    body =
                        JSON.parse(raw);
                } catch {
                    body = null;
                }
            }

            if (!response.ok) {
                const apiMessage =
                    body?.error?.message ||
                    body?.message ||
                    raw ||
                    `Groq HTTP ${response.status}`;

                const error =
                    new Error(
                        apiMessage
                    );

                error.status =
                    response.status;

                error.raw =
                    raw;

                error.body =
                    body;

                if (
                    (
                        response.status === 429 ||
                        response.status >= 500
                    ) &&
                    attempt < maxRetries
                ) {
                    const delay =
                        getRetryDelay(
                            attempt,
                            response
                        );

                    console.warn(
                        `[GROQ RETRY] HTTP ${response.status}. Esperando ${delay} ms...`
                    );

                    await sleep(delay);

                    continue;
                }

                throw error;
            }

            if (!body) {
                lastError =
                    new Error(
                        "Groq devolvió una respuesta vacía o no JSON."
                    );

                if (
                    attempt < maxRetries
                ) {
                    const delay =
                        getRetryDelay(
                            attempt,
                            response
                        );

                    await sleep(delay);
                    continue;
                }

                throw lastError;
            }

            if (body.error) {
                lastError =
                    new Error(
                        body.error.message ||
                        "Groq devolvió un objeto error."
                    );

                if (
                    attempt < maxRetries
                ) {
                    const delay =
                        getRetryDelay(
                            attempt,
                            response
                        );

                    await sleep(delay);
                    continue;
                }

                throw lastError;
            }

            return body;

        } catch (error) {
            lastError = error;

            console.error(
                `[GROQ ERROR] intento ${attempt}/${maxRetries}:`,
                error?.message || error
            );

            if (
                error?.name ===
                "AbortError"
            ) {
                console.error(
                    "[GROQ ERROR] Timeout de la petición."
                );
            }

            if (
                attempt >= maxRetries
            ) {
                break;
            }

            const delay =
                getRetryDelay(
                    attempt,
                    null
                );

            console.warn(
                `[GROQ RETRY] Reintentando en ${delay} ms...`
            );

            await sleep(delay);

        } finally {
            if (timeout) {
                clearTimeout(timeout);
            }
        }
    }

    throw (
        lastError ||
        new Error(
            "Groq no respondió correctamente."
        )
    );
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
            "The audio contains Arabic religious singing.",
            "TRANSCRIBE THE ACTUAL ARABIC SCRIPT.",
            "Output Arabic letters, not Latin transliteration.",
            "Do not translate.",
            "Do not transliterate.",
            "Do not romanize.",
            "Do not summarize.",
            "Preserve repeated verses.",
            "Preserve repeated phrases.",
            "Preserve Quranic and religious expressions.",
            "Preserve names accurately.",
            "Use Arabic Unicode characters whenever the speaker sings Arabic."
        ].join(" ")
    );

    const result =
        await groqRequest(
            `${GROQ_BASE_URL}/audio/transcriptions`,
            {
                method: "POST",
                body: form
            },
            apiKey
        );

    console.log(
        "[USER NASHEED] Resultado completo de Whisper recibido."
    );

    if (
        !result ||
        result.error
    ) {
        throw new Error(
            "Whisper devolvió una respuesta inválida."
        );
    }

    if (
        !Array.isArray(
            result.segments
        )
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
                isUsefulText(
                    segment.text
                )
        );

    if (!usable.length) {
        throw new Error(
            "La transcripción no contiene texto utilizable."
        );
    }

    const latinCount =
        usable.filter(
            (segment) =>
                isMostlyLatin(
                    segment.text
                )
        ).length;

    const arabicCount =
        usable.filter(
            (segment) =>
                containsArabic(
                    segment.text
                )
        ).length;

    console.log(
        "[USER NASHEED] Whisper:",
        {
            rawSegments:
                rawSegments.length,
            validSegments:
                usable.length,
            arabicSegments:
                arabicCount,
            latinSegments:
                latinCount,
            duration:
                result?.duration ?? null
        }
    );

    /*
     * IMPORTANTE:
     * No se rompe automáticamente el proceso solo porque
     * Whisper haya producido transliteración.
     *
     * La reconstrucción se hace posteriormente usando
     * el modelo de texto.
     */

    return usable;
}

/* =========================================================
   RECONSTRUCCIÓN DE ÁRABE
   ========================================================= */

async function reconstructArabicText(
    segments,
    apiKey
) {
    if (
        !Array.isArray(segments) ||
        !segments.length
    ) {
        throw new Error(
            "No hay segmentos para reconstruir."
        );
    }

    const input =
        segments
            .map(
                (segment, index) =>
                    `${index + 1}. ${cleanText(segment.text)}`
            )
            .join("\n");

    const systemPrompt = `
You are an expert Arabic linguist specializing in Arabic nasheed lyrics.

The input may contain:
- Arabic text
- Latin transliteration of Arabic
- imperfect speech recognition
- mixed Arabic and Latin text

Your task is to reconstruct the ACTUAL ARABIC SCRIPT.

STRICT RULES:

1. Output Arabic Unicode script.
2. NEVER output Latin transliteration.
3. NEVER output Arabic pronunciation written with Latin letters.
4. NEVER translate the lyrics.
5. Do not explain anything.
6. Do not summarize.
7. Preserve the meaning of the original lyrics.
8. Preserve repeated phrases.
9. Preserve religious expressions.
10. Preserve names.
11. Keep the exact number of numbered lines.
12. Each numbered line must contain ONLY the reconstructed Arabic lyric.
13. If the input is already Arabic, correct obvious recognition mistakes but keep it Arabic.
14. Do not invent unrelated lyrics.
15. Do not add punctuation explanations.
16. Output only:
1. Arabic text
2. Arabic text
3. Arabic text
`.trim();

    const requestBody = {
        model:
            GROQ_TRANSLATION,
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
                    `${GROQ_BASE_URL}/chat/completions`,
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

            const content =
                result
                    ?.choices?.[0]
                    ?.message
                    ?.content;

            console.log(
                `[ARABIC RECONSTRUCTION] intento ${attempt}:`,
                content || ""
            );

            if (
                typeof content === "string" &&
                content.trim()
            ) {
                const parsed =
                    parseNumberedOutput(
                        content,
                        segments.length
                    );

                if (
                    parsed.size ===
                    segments.length
                ) {
                    const reconstructed =
                        segments.map(
                            (
                                segment,
                                index
                            ) => ({
                                start:
                                    segment.start,
                                end:
                                    segment.end,
                                text:
                                    parsed.get(
                                        index
                                    ) ||
                                    segment.text
                            })
                        );

                    const arabicSegments =
                        reconstructed.filter(
                            (segment) =>
                                containsArabic(
                                    segment.text
                                )
                        ).length;

                    console.log(
                        "[ARABIC RECONSTRUCTION] Segmentos árabes:",
                        arabicSegments,
                        "/",
                        reconstructed.length
                    );

                    if (
                        arabicSegments > 0
                    ) {
                        return reconstructed;
                    }
                }

                /*
                 * Aunque el parser no encuentre todas las líneas,
                 * intentamos recuperar las líneas que sí existan.
                 */
                if (
                    parsed.size > 0
                ) {
                    const partial =
                        segments.map(
                            (
                                segment,
                                index
                            ) => ({
                                start:
                                    segment.start,
                                end:
                                    segment.end,
                                text:
                                    parsed.get(
                                        index
                                    ) ||
                                    segment.text
                            })
                        );

                    const arabicCount =
                        partial.filter(
                            (segment) =>
                                containsArabic(
                                    segment.text
                                )
                        ).length;

                    if (
                        arabicCount >=
                        Math.max(
                            1,
                            Math.floor(
                                segments.length * 0.5
                            )
                        )
                    ) {
                        return partial;
                    }
                }

                lastError =
                    new Error(
                        "La reconstrucción árabe no produjo suficientes líneas válidas."
                    );
            } else {
                lastError =
                    new Error(
                        "El modelo de reconstrucción árabe devolvió texto vacío."
                    );
            }

        } catch (error) {
            lastError = error;

            console.error(
                `[ARABIC RECONSTRUCTION ERROR] intento ${attempt}:`,
                error?.message || error
            );
        }

        if (
            attempt < 3
        ) {
            await sleep(
                2000 * attempt
            );
        }
    }

    console.warn(
        "[ARABIC RECONSTRUCTION] Falló la reconstrucción. Se conserva el texto original."
    );

    /*
     * Fallback seguro:
     * jamás devolvemos un archivo vacío.
     */
    return segments.map(
        (segment) => ({
            start:
                segment.start,
            end:
                segment.end,
            text:
                segment.text ||
                "[Texto no reconocido]"
        })
    );
}

/* =========================================================
   PARSER DE RESPUESTAS NUMERADAS
   ========================================================= */

function parseNumberedOutput(
    content,
    expectedCount
) {
    const map =
        new Map();

    const lines =
        String(content || "")
            .split(/\r?\n/)
            .map(
                (line) =>
                    line.trim()
            )
            .filter(Boolean);

    for (
        const line of lines
    ) {
        const match =
            line.match(
                /^\s*(\d+)\s*[\.\):\-]\s*(.+?)\s*$/
            );

        if (!match) {
            continue;
        }

        const number =
            Number(
                match[1]
            );

        const index =
            number - 1;

        if (
            index < 0 ||
            index >= expectedCount
        ) {
            continue;
        }

        let text =
            cleanText(
                match[2]
            );

        text =
            text
                .replace(
                    /^["'`]+/,
                    ""
                )
                .replace(
                    /["'`]+$/,
                    ""
                )
                .trim();

        if (
            text &&
            !text.includes("```")
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

async function translateAllBatch(
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

    if (
        !Array.isArray(segments) ||
        !segments.length
    ) {
        throw new Error(
            "No hay segmentos para traducir."
        );
    }

    const inputLines =
        segments.map(
            (segment, index) =>
                `${index + 1}. ${cleanText(segment.text)}`
        );

    const systemPrompt = `
You are a professional translator.

Translate the Arabic lyrics into ${targetLanguage}.

STRICT RULES:

1. Translate the MEANING.
2. Do NOT transliterate Arabic.
3. Do NOT write Arabic pronunciation using Latin letters.
4. Do NOT reproduce Arabic words unless they are proper names or unavoidable religious terms.
5. Do NOT summarize.
6. Do NOT explain.
7. Preserve repeated lyrics.
8. Preserve the exact numbered structure.
9. Keep one translation for every input line.
10. Do not merge lines.
11. Do not omit lines.
12. Do not add markdown.
13. Output ONLY the numbered translations.

Example:

1. Translation
2. Translation
3. Translation
`.trim();

    const requestBody = {
        model:
            GROQ_TRANSLATION,
        temperature: 0.1,
        max_completion_tokens:
            Math.max(
                4000,
                segments.length * 80
            ),
        messages: [
            {
                role: "system",
                content:
                    systemPrompt
            },
            {
                role: "user",
                content:
                    inputLines.join("\n")
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
                    `${GROQ_BASE_URL}/chat/completions`,
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
                    ?.choices?.[0]
                    ?.message
                    ?.content;

            console.log(
                `[TRANSLATION DEBUG] ${language} intento ${attempt}:`,
                rawContent || ""
            );

            if (
                typeof rawContent !==
                    "string" ||
                !rawContent.trim()
            ) {
                throw new Error(
                    `Groq no devolvió traducción al ${targetLanguage}.`
                );
            }

            const translatedMap =
                parseNumberedOutput(
                    rawContent,
                    segments.length
                );

            /*
             * No exigimos que una respuesta perfecta
             * sea imprescindible para conservar el archivo.
             *
             * Si faltan líneas, se utiliza el texto original
             * solamente en esas líneas.
             */
            const output =
                segments.map(
                    (
                        segment,
                        index
                    ) => {
                        const translated =
                            translatedMap.get(
                                index
                            );

                        return {
                            start:
                                segment.start,
                            end:
                                segment.end,
                            text:
                                translated ||
                                segment.text
                        };
                    }
                );

            if (
                output.some(
                    (segment) =>
                        !isUsefulText(
                            segment.text
                        )
                )
            ) {
                throw new Error(
                    "La traducción contiene segmentos vacíos."
                );
            }

            console.log(
                `[TRANSLATION DEBUG] ${language}: ${translatedMap.size}/${segments.length} líneas traducidas.`
            );

            return output;

        } catch (error) {
            lastError = error;

            console.error(
                `[TRANSLATION ERROR] ${language} intento ${attempt}/3:`,
                error?.message || error
            );

            if (
                attempt < 3
            ) {
                await sleep(
                    2000 * attempt
                );
            }
        }
    }

    /*
     * FALLBACK:
     * jamás generamos un VTT vacío.
     * Conservamos el texto original.
     */
    console.warn(
        `[TRANSLATION FALLBACK] ${language}: se conservará el texto original.`
    );

    return segments.map(
        (segment) => ({
            start:
                segment.start,
            end:
                segment.end,
            text:
                segment.text ||
                "[Traducción no disponible]"
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

        try {
            subtitles[language] =
                await signUrl(
                    supabase,
                    storagePath,
                    86400
                );
        } catch (error) {
            console.error(
                `[PRIVATE TRACK] Error creando URL para ${language}:`,
                error?.message || error
            );
        }
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
                        String(
                            existing.data.status ||
                            ""
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

                if (coverPath) {
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
                    !signedAudio.data.signedUrl
                ) {
                    throw new Error(
                        "No se pudo obtener la URL firmada del audio."
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
                    25
                );

                console.log(
                    "[USER NASHEED] Transcribiendo:",
                    row.title
                );

                let arabic =
                    await transcribeArabic(
                        signedAudio.data.signedUrl,
                        groqApiKey
                    );

                console.log(
                    "[USER NASHEED] Segmentos Whisper:",
                    arabic.length
                );

                /*
                 * Si Whisper devuelve principalmente
                 * transliteración, reconstruimos a escritura árabe.
                 */
                const latinCount =
                    arabic.filter(
                        (segment) =>
                            isMostlyLatin(
                                segment.text
                            )
                    ).length;

                const arabicCount =
                    arabic.filter(
                        (segment) =>
                            containsArabic(
                                segment.text
                            )
                    ).length;

                console.log(
                    "[USER NASHEED] Detección:",
                    {
                        arabicCount,
                        latinCount,
                        total:
                            arabic.length
                    }
                );

                if (
                    latinCount > 0 &&
                    (
                        latinCount >=
                            arabicCount ||
                        arabicCount === 0
                    )
                ) {
                    console.warn(
                        "[USER NASHEED] Whisper devolvió principalmente transliteración. Reconstruyendo árabe..."
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
                        40
                    );

                    arabic =
                        await reconstructArabicText(
                            arabic,
                            groqApiKey
                        );
                }

                /*
                 * Garantía final de que no se pierde el texto.
                 */
                arabic =
                    normalizeSegments(
                        arabic
                    );

                if (
                    !arabic.length
                ) {
                    throw new Error(
                        "La transcripción final quedó vacía."
                    );
                }

                console.log(
                    "[USER NASHEED] Texto final:",
                    arabic
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
                   ÁRABE
                   ================================================= */

                const arabicPath =
                    `${prefix}/subtitles/ar.vtt`;

                const arabicVtt =
                    makeVTT(
                        arabic
                    );

                if (
                    !arabicVtt ||
                    arabicVtt.trim() ===
                        "WEBVTT"
                ) {
                    throw new Error(
                        "El VTT árabe quedó vacío."
                    );
                }

                const arabicUpload =
                    await supabase
                        .storage
                        .from(
                            BUCKET
                        )
                        .upload(
                            arabicPath,
                            Buffer.from(
                                "\uFEFF" +
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
                        Math.round(
                            50 +
                            (
                                (i + 1) /
                                totalLangs
                            ) *
                            40
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

                    const translated =
                        await translateAllBatch(
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

                    if (
                        !translationVtt ||
                        translationVtt.trim() ===
                            "WEBVTT"
                    ) {
                        throw new Error(
                            `El VTT de ${language} quedó vacío.`
                        );
                    }

                    const upload =
                        await supabase
                            .storage
                            .from(
                                BUCKET
                            )
                            .upload(
                                translationPath,
                                Buffer.from(
                                    "\uFEFF" +
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
                   READY
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

                console.log(
                    "[USER NASHEED] PROCESAMIENTO COMPLETADO:",
                    id
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

            } catch (
                error
            ) {
                if (
                    error?.message ===
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
                    "[USER NASHEED PROCESS ERROR]",
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
                                    error?.message ||
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
                        "[USER NASHEED] No se pudo guardar el error:",
                        updateError
                    );
                }

                return res
                    .status(
                        error?.status ===
                            429
                            ? 429
                            : 500
                    )
                    .json({
                        error:
                            error?.message ||
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

                    try {
                        privateTracks.push(
                            await privateTrack(
                                supabase,
                                row
                            )
                        );
                    } catch (
                        privateError
                    ) {
                        console.error(
                            "[PRIVATE TRACK ERROR]",
                            privateError
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