````javascript
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
 * IMPORTANTE:
 *
 * Los modelos Llama antiguos fueron retirados de Groq.
 *
 * GPT-OSS 120B es actualmente el modelo de mayor capacidad
 * que utilizamos para:
 *
 * 1. Reconstruir árabe cuando Whisper devuelve transliteración.
 * 2. Traducir el árabe.
 * 3. Generar respuestas estructuradas.
 *
 * Whisper Large V3 se utiliza para la transcripción porque
 * tiene mayor precisión que Whisper Turbo para este caso.
 */
const GROQ_STT = "whisper-large-v3";
const GROQ_TEXT = "openai/gpt-oss-120b";

const GROQ_CHAT_URL =
    "https://api.groq.com/openai/v1/chat/completions";

const GROQ_TRANSCRIPTION_URL =
    "https://api.groq.com/openai/v1/audio/transcriptions";

/*
 * Groq Free tiene límites de peticiones.
 * No hacemos peticiones simultáneas innecesarias.
 *
 * 30 RPM para GPT-OSS en Free:
 * 1 petición cada ~2.1 segundos deja margen.
 *
 * Whisper tiene un límite independiente.
 */
const TEXT_REQUEST_INTERVAL = 2200;
const STT_REQUEST_INTERVAL = 3200;

const MAX_GROQ_RETRIES = 6;
const MAX_TEXT_RETRIES = 5;

let lastTextRequestAt = 0;
let lastSttRequestAt = 0;

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
                .map(
                    item =>
                        String(item || "")
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
   TEXTO
   ========================================================= */

function cleanText(value) {
    return String(value || "")
        .replace(/\r|\n+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/*
 * Elimina restos de formato que algunos modelos pueden devolver.
 */
function cleanModelText(value) {
    return cleanText(
        String(value || "")
            .replace(/^```(?:json|text)?/i, "")
            .replace(/```$/i, "")
            .replace(/^["']|["']$/g, "")
    );
}

/* =========================================================
   DETECCIÓN DE ÁRABE
   ========================================================= */

function arabicCharacterCount(text) {
    return (
        String(text || "")
            .match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g)
            ?.length || 0
    );
}

function latinCharacterCount(text) {
    return (
        String(text || "")
            .match(/[A-Za-zÀ-ÿ]/g)
            ?.length || 0
    );
}

function hasArabicScript(text) {
    const value = cleanText(text);

    if (!value) {
        return false;
    }

    const arabic = arabicCharacterCount(value);
    const latin = latinCharacterCount(value);

    if (arabic < 2) {
        return false;
    }

    /*
     * Si hay árabe real, permitimos números y puntuación.
     * También permitimos algunas palabras latinas ocasionales.
     */
    if (latin === 0) {
        return true;
    }

    return arabic >= latin;
}

function isLikelyTransliteration(text) {
    const value = cleanText(text);

    if (!value) {
        return true;
    }

    if (hasArabicScript(value)) {
        return false;
    }

    const latin = latinCharacterCount(value);

    return latin >= 2;
}

/* =========================================================
   SEGMENTOS
   ========================================================= */

function normalizeSegments(segments) {
    if (!Array.isArray(segments)) {
        return [];
    }

    return segments
        .map(segment => ({
            start: Number(segment?.start),
            end: Number(segment?.end),
            text: cleanText(segment?.text)
        }))
        .filter(segment =>
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

/*
 * Fusiona segmentos extremadamente cortos y evita
 * subtítulos vacíos.
 */
function improveSegments(segments) {
    const normalized =
        normalizeSegments(segments);

    if (!normalized.length) {
        return [];
    }

    const result = [];

    for (const segment of normalized) {
        const previous =
            result[result.length - 1];

        /*
         * No fusionamos segmentos normales.
         * Solo corregimos duraciones absurdamente pequeñas.
         */
        if (
            previous &&
            segment.start < previous.end
        ) {
            if (
                segment.start >= previous.start &&
                segment.start < previous.end
            ) {
                previous.end =
                    Math.max(
                        previous.end,
                        segment.end
                    );

                previous.text =
                    cleanText(
                        `${previous.text} ${segment.text}`
                    );

                continue;
            }
        }

        result.push({
            start: segment.start,
            end: segment.end,
            text: segment.text
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

        /*
         * Nunca permitimos una duración cero.
         */
        if (
            end <= start
        ) {
            end =
                start + 0.5;
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
   RATE LIMIT LOCAL
   ========================================================= */

async function waitForTextSlot() {
    const now = Date.now();

    const elapsed =
        now - lastTextRequestAt;

    if (
        elapsed <
        TEXT_REQUEST_INTERVAL
    ) {
        await sleep(
            TEXT_REQUEST_INTERVAL - elapsed
        );
    }

    lastTextRequestAt =
        Date.now();
}

async function waitForSttSlot() {
    const now = Date.now();

    const elapsed =
        now - lastSttRequestAt;

    if (
        elapsed <
        STT_REQUEST_INTERVAL
    ) {
        await sleep(
            STT_REQUEST_INTERVAL - elapsed
        );
    }

    lastSttRequestAt =
        Date.now();
}

/* =========================================================
   RETRY-AFTER
   ========================================================= */

function parseRetryAfter(headers) {
    try {
        const value =
            headers.get("retry-after");

        if (!value) {
            return null;
        }

        const seconds =
            Number(value);

        if (
            Number.isFinite(seconds) &&
            seconds >= 0
        ) {
            return seconds * 1000;
        }

        const date =
            Date.parse(value);

        if (
            Number.isFinite(date)
        ) {
            return Math.max(
                0,
                date - Date.now()
            );
        }
    } catch {
        return null;
    }

    return null;
}

/* =========================================================
   GROQ REQUEST ROBUSTO
   ========================================================= */

async function groqRequest(
    url,
    options,
    apiKey,
    maxRetries = MAX_GROQ_RETRIES,
    requestType = "text"
) {
    let lastError = null;

    for (
        let attempt = 1;
        attempt <= maxRetries;
        attempt++
    ) {
        try {
            if (
                requestType === "stt"
            ) {
                await waitForSttSlot();
            } else {
                await waitForTextSlot();
            }

            const controller =
                new AbortController();

            const timeout =
                setTimeout(
                    () => controller.abort(),
                    120000
                );

            let response;

            try {
                response =
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
            } finally {
                clearTimeout(timeout);
            }

            if (
                response.status === 429
            ) {
                const retryAfter =
                    parseRetryAfter(
                        response.headers
                    );

                const exponential =
                    Math.min(
                        60000,
                        2000 *
                        Math.pow(
                            2,
                            attempt - 1
                        )
                    );

                const waitTime =
                    Math.max(
                        retryAfter || 0,
                        exponential
                    );

                console.warn(
                    `[GROQ 429] Reintento ${attempt}/${maxRetries} en ${Math.round(waitTime / 1000)}s`
                );

                if (
                    attempt < maxRetries
                ) {
                    await sleep(
                        waitTime
                    );
                    continue;
                }
            }

            const raw =
                await response.text();

            let body;

            try {
                body =
                    raw
                        ? JSON.parse(raw)
                        : {};
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

                error.retryable =
                    response.status === 408 ||
                    response.status === 409 ||
                    response.status === 429 ||
                    response.status >= 500;

                throw error;
            }

            return body;

        } catch (error) {
            lastError = error;

            const retryable =
                error?.name === "AbortError" ||
                error?.code === "ECONNRESET" ||
                error?.code === "ETIMEDOUT" ||
                error?.code === "ENOTFOUND" ||
                error?.code === "ECONNREFUSED" ||
                error?.retryable === true ||
                error?.status === 429 ||
                (
                    !error?.status &&
                    /fetch|network|socket|timeout|connection/i.test(
                        String(error?.message || "")
                    )
                );

            console.error(
                `[GROQ ERROR] intento ${attempt}/${maxRetries}:`,
                error?.message || error
            );

            if (
                attempt >= maxRetries ||
                !retryable
            ) {
                throw error;
            }

            const waitTime =
                Math.min(
                    60000,
                    2000 *
                    Math.pow(
                        2,
                        attempt - 1
                    )
                ) +
                Math.floor(
                    Math.random() * 1000
                );

            await sleep(
                waitTime
            );
        }
    }

    throw lastError ||
        new Error(
            "Groq no respondió."
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
    let lastSegments = [];

    for (
        let attempt = 1;
        attempt <= 3;
        attempt++
    ) {
        try {
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

            /*
             * Prompt corto porque Groq limita el prompt de Whisper.
             * Se especifica árabe explícitamente y se insiste en
             * escritura árabe, sin traducción.
             */
            form.append(
                "prompt",
                [
                    "Arabic nasheed.",
                    "Arabic religious vocals.",
                    "Write the spoken or sung words in Arabic script.",
                    "Do not transliterate Arabic into Latin letters.",
                    "Do not translate.",
                    "Preserve repeated lyrics.",
                    "Preserve Quranic and Islamic expressions.",
                    "Use Arabic script."
                ].join(" ")
            );

            const result =
                await groqRequest(
                    GROQ_TRANSCRIPTION_URL,
                    {
                        method: "POST",
                        body: form
                    },
                    apiKey,
                    MAX_GROQ_RETRIES,
                    "stt"
                );

            if (
                !result ||
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
                improveSegments(
                    rawSegments
                );

            if (!segments.length) {
                throw new Error(
                    "La transcripción no contiene segmentos válidos."
                );
            }

            lastSegments =
                segments;

            const arabicCount =
                segments.filter(
                    segment =>
                        hasArabicScript(
                            segment.text
                        )
                ).length;

            const transliterationCount =
                segments.filter(
                    segment =>
                        isLikelyTransliteration(
                            segment.text
                        )
                ).length;

            console.log(
                "[USER NASHEED] Whisper:",
                {
                    model: GROQ_STT,
                    attempt,
                    rawSegments:
                        rawSegments.length,
                    validSegments:
                        segments.length,
                    arabicSegments:
                        arabicCount,
                    transliterationSegments:
                        transliterationCount,
                    duration:
                        result?.duration ??
                        null
                }
            );

            /*
             * Si al menos una parte razonable ya está en árabe,
             * continuamos y reconstruimos solamente las que no.
             */
            if (
                arabicCount > 0 ||
                segments.length === 1
            ) {
                return segments;
            }

            /*
             * Si TODO salió en transliteración, reintentamos Whisper.
             */
            console.warn(
                `[USER NASHEED] Whisper devolvió principalmente transliteración. Reintentando ${attempt}/3...`
            );

        } catch (error) {
            console.error(
                `[USER NASHEED] Error de Whisper intento ${attempt}:`,
                error.message
            );

            if (
                attempt < 3
            ) {
                await sleep(
                    3000 *
                    Math.pow(
                        2,
                        attempt - 1
                    )
                );
            }
        }
    }

    if (!lastSegments.length) {
        throw new Error(
            "Whisper no devolvió una transcripción válida después de varios intentos."
        );
    }

    return lastSegments;
}

/* =========================================================
   PARSEO JSON SEGURO
   ========================================================= */

function parseJsonResponse(content) {
    const raw =
        String(content || "").trim();

    if (!raw) {
        return null;
    }

    try {
        return JSON.parse(raw);
    } catch {
        /*
         * Intentamos localizar el primer objeto JSON.
         */
        const first =
            raw.indexOf("{");

        const last =
            raw.lastIndexOf("}");

        if (
            first >= 0 &&
            last > first
        ) {
            try {
                return JSON.parse(
                    raw.slice(
                        first,
                        last + 1
                    )
                );
            } catch {
                return null;
            }
        }
    }

    return null;
}

/* =========================================================
   RECONSTRUCCIÓN DE ÁRABE
   ========================================================= */

async function reconstructArabicBatch(
    segments,
    apiKey
) {
    if (!segments.length) {
        return [];
    }

    /*
     * No mandamos cantidades enormes al modelo.
     * Esto mantiene el consumo de tokens muy por debajo
     * del límite gratuito.
     */
    const BATCH_SIZE = 8;

    const output = [];

    for (
        let startIndex = 0;
        startIndex < segments.length;
        startIndex += BATCH_SIZE
    ) {
        const batch =
            segments.slice(
                startIndex,
                startIndex + BATCH_SIZE
            );

        const input =
            batch.map(
                (segment, index) => ({
                    index:
                        startIndex +
                        index +
                        1,
                    text:
                        segment.text
                })
            );

        const result =
            await reconstructArabicSingleBatch(
                input,
                apiKey
            );

        for (
            let i = 0;
            i < batch.length;
            i++
        ) {
            const original =
                batch[i];

            const index =
                startIndex + i + 1;

            const reconstructed =
                result.get(index);

            if (
                reconstructed &&
                hasArabicScript(
                    reconstructed
                )
            ) {
                output.push({
                    start:
                        original.start,
                    end:
                        original.end,
                    text:
                        reconstructed
                });
            } else {
                /*
                 * Si el modelo no pudo reconstruir esa línea,
                 * hacemos una última petición individual.
                 */
                const recovered =
                    await recoverArabicSegment(
                        original,
                        index,
                        apiKey
                    );

                output.push({
                    start:
                        original.start,
                    end:
                        original.end,
                    text:
                        recovered ||
                        original.text
                });
            }
        }
    }

    return output;
}

/* =========================================================
   RECONSTRUCCIÓN BATCH INDIVIDUAL
   ========================================================= */

async function reconstructArabicSingleBatch(
    input,
    apiKey
) {
    const map =
        new Map();

    const systemPrompt = `
You are an expert Arabic language restoration system for Arabic nasheed lyrics.

The input may be Arabic speech incorrectly transcribed by speech recognition as Latin transliteration.

Your task is NOT translation.

Your task is ONLY to restore the original Arabic words into correct Arabic script.

Rules:
- Convert Latin transliteration into Arabic script.
- Do NOT translate.
- Do NOT explain.
- Do NOT summarize.
- Do NOT invent additional verses.
- Preserve the meaning and wording as closely as possible.
- Preserve Islamic and Quranic expressions.
- Preserve repeated phrases.
- Use Arabic letters, not Latin transliteration.
- Keep each input index exactly.
- If the input is already Arabic, preserve it and only correct obvious transcription errors.
- Return ONLY valid JSON.
- The JSON must contain exactly one key: "segments".
- Each segment must contain "index" and "text".
`.trim();

    const userPrompt =
        JSON.stringify(
            {
                segments: input
            },
            null,
            2
        );

    let result = null;

    for (
        let attempt = 1;
        attempt <= MAX_TEXT_RETRIES;
        attempt++
    ) {
        try {
            const response =
                await groqRequest(
                    GROQ_CHAT_URL,
                    {
                        method: "POST",
                        headers: {
                            "Content-Type":
                                "application/json"
                        },
                        body:
                            JSON.stringify({
                                model:
                                    GROQ_TEXT,
                                temperature:
                                    0,
                                max_completion_tokens:
                                    1800,
                                reasoning_effort:
                                    "low",
                                response_format: {
                                    type:
                                        "json_object"
                                },
                                messages: [
                                    {
                                        role:
                                            "system",
                                        content:
                                            systemPrompt
                                    },
                                    {
                                        role:
                                            "user",
                                        content:
                                            userPrompt
                                    }
                                ]
                            })
                    },
                    apiKey,
                    MAX_GROQ_RETRIES,
                    "text"
                );

            const content =
                result
                    ?.choices?.[0]
                    ?.message?.content;

            const json =
                parseJsonResponse(
                    content
                );

            if (
                !json ||
                !Array.isArray(
                    json.segments
                )
            ) {
                throw new Error(
                    "La reconstrucción árabe devolvió una respuesta JSON inválida."
                );
            }

            for (
                const item of
                json.segments
            ) {
                const index =
                    Number(item?.index);

                const text =
                    cleanModelText(
                        item?.text
                    );

                if (
                    Number.isInteger(index) &&
                    text &&
                    hasArabicScript(text)
                ) {
                    map.set(
                        index,
                        text
                    );
                }
            }

            if (
                map.size > 0
            ) {
                return map;
            }

            throw new Error(
                "El modelo de reconstrucción árabe no devolvió texto árabe válido."
            );

        } catch (error) {
            console.error(
                `[ARABIC RECONSTRUCTION] intento ${attempt}/${MAX_TEXT_RETRIES}:`,
                error.message
            );

            if (
                attempt <
                MAX_TEXT_RETRIES
            ) {
                await sleep(
                    Math.min(
                        30000,
                        1500 *
                        Math.pow(
                            2,
                            attempt - 1
                        )
                    )
                );
            }
        }
    }

    return map;
}

/* =========================================================
   RECUPERACIÓN INDIVIDUAL ÁRABE
   ========================================================= */

async function recoverArabicSegment(
    segment,
    index,
    apiKey
) {
    const systemPrompt = `
Restore this Arabic nasheed transcription into Arabic script.

This is NOT translation.

If the input is Latin transliteration, convert it to the most likely original Arabic wording.

Rules:
- Output only Arabic script.
- No Latin transliteration.
- No translation.
- No explanation.
- Preserve Islamic expressions.
- Preserve repeated lyrics.
- Do not add words that are not justified by the input.
- Return only the Arabic text.
`.trim();

    for (
        let attempt = 1;
        attempt <= 4;
        attempt++
    ) {
        try {
            const response =
                await groqRequest(
                    GROQ_CHAT_URL,
                    {
                        method: "POST",
                        headers: {
                            "Content-Type":
                                "application/json"
                        },
                        body:
                            JSON.stringify({
                                model:
                                    GROQ_TEXT,
                                temperature:
                                    0,
                                max_completion_tokens:
                                    500,
                                reasoning_effort:
                                    "low",
                                messages: [
                                    {
                                        role:
                                            "system",
                                        content:
                                            systemPrompt
                                    },
                                    {
                                        role:
                                            "user",
                                        content:
                                            `Segment ${index}:\n${segment.text}`
                                    }
                                ]
                            })
                    },
                    apiKey,
                    MAX_GROQ_RETRIES,
                    "text"
                );

            const content =
                response
                    ?.choices?.[0]
                    ?.message?.content;

            const text =
                cleanModelText(
                    content
                );

            if (
                text &&
                hasArabicScript(text)
            ) {
                return text;
            }

            throw new Error(
                "Respuesta vacía o sin escritura árabe."
            );

        } catch (error) {
            console.error(
                `[ARABIC RECOVERY] segmento ${index}, intento ${attempt}:`,
                error.message
            );

            if (
                attempt < 4
            ) {
                await sleep(
                    Math.min(
                        20000,
                        1500 *
                        Math.pow(
                            2,
                            attempt - 1
                        )
                    )
                );
            }
        }
    }

    console.error(
        `[ARABIC RECOVERY] No se pudo recuperar el segmento ${index}. Se conserva el texto original.`
    );

    return null;
}

/* =========================================================
   GARANTIZAR ÁRABE
   ========================================================= */

async function ensureArabicSegments(
    segments,
    apiKey
) {
    const normalized =
        improveSegments(
            segments
        );

    if (!normalized.length) {
        throw new Error(
            "No hay segmentos para convertir a árabe."
        );
    }

    const needsRepair =
        normalized.filter(
            segment =>
                !hasArabicScript(
                    segment.text
                )
        );

    if (!needsRepair.length) {
        console.log(
            "[USER NASHEED] Toda la transcripción ya está en escritura árabe."
        );

        return normalized;
    }

    console.log(
        `[USER NASHEED] Reparando ${needsRepair.length} segmentos sin escritura árabe...`
    );

    const repaired =
        await reconstructArabicBatch(
            normalized,
            apiKey
        );

    /*
     * Verificación final.
     *
     * No damos por válida una reconstrucción si sigue siendo
     * transliteración.
     */
    const finalSegments =
        repaired.map(
            segment => ({
                start:
                    segment.start,
                end:
                    segment.end,
                text:
                    cleanText(
                        segment.text
                    )
            })
        );

    const arabicCount =
        finalSegments.filter(
            segment =>
                hasArabicScript(
                    segment.text
                )
        ).length;

    console.log(
        `[USER NASHEED] Verificación árabe: ${arabicCount}/${finalSegments.length} segmentos en escritura árabe.`
    );

    /*
     * No abortamos todo el proceso por un segmento defectuoso.
     * El segmento queda con su texto original y se registra.
     */
    for (
        let i = 0;
        i < finalSegments.length;
        i++
    ) {
        if (
            !hasArabicScript(
                finalSegments[i].text
            )
        ) {
            console.warn(
                `[USER NASHEED] Segmento ${i + 1} sigue sin árabe después de todos los intentos.`
            );
        }
    }

    return finalSegments;
}

/* =========================================================
   TRADUCCIÓN
   ========================================================= */

const LANGUAGE_NAMES = {
    es: "Spanish",
    en: "English",
    ru: "Russian"
};

async function translateBatch(
    segments,
    language,
    apiKey
) {
    const targetLanguage =
        LANGUAGE_NAMES[language];

    if (!targetLanguage) {
        throw new Error(
            `Idioma no soportado: ${language}`
        );
    }

    if (!segments.length) {
        return [];
    }

    const input =
        segments.map(
            (segment, index) => ({
                index:
                    index + 1,
                text:
                    cleanText(
                        segment.text
                    )
            })
        );

    const systemPrompt = `
You are a professional translator of Arabic nasheed lyrics.

Translate Arabic into ${targetLanguage}.

IMPORTANT:
- Translate the MEANING.
- Do NOT transliterate Arabic into Latin letters.
- Do NOT reproduce Arabic pronunciation.
- Do NOT explain.
- Do NOT summarize.
- Do NOT add lyrics.
- Preserve the meaning of Islamic and religious expressions.
- Preserve repetitions.
- Keep one translation for every input index.
- Never omit an index.
- Return ONLY valid JSON.
- JSON must contain exactly one key: "translations".
- Each item must contain "index" and "text".
`.trim();

    let parsed = null;

    for (
        let attempt = 1;
        attempt <= MAX_TEXT_RETRIES;
        attempt++
    ) {
        try {
            const result =
                await groqRequest(
                    GROQ_CHAT_URL,
                    {
                        method: "POST",
                        headers: {
                            "Content-Type":
                                "application/json"
                        },
                        body:
                            JSON.stringify({
                                model:
                                    GROQ_TEXT,
                                temperature:
                                    0,
                                max_completion_tokens:
                                    2500,
                                reasoning_effort:
                                    "low",
                                response_format: {
                                    type:
                                        "json_object"
                                },
                                messages: [
                                    {
                                        role:
                                            "system",
                                        content:
                                            systemPrompt
                                    },
                                    {
                                        role:
                                            "user",
                                        content:
                                            JSON.stringify(
                                                {
                                                    segments:
                                                        input
                                                },
                                                null,
                                                2
                                            )
                                    }
                                ]
                            })
                    },
                    apiKey,
                    MAX_GROQ_RETRIES,
                    "text"
                );

            const content =
                result
                    ?.choices?.[0]
                    ?.message?.content;

            parsed =
                parseJsonResponse(
                    content
                );

            if (
                !parsed ||
                !Array.isArray(
                    parsed.translations
                )
            ) {
                throw new Error(
                    `Groq no devolvió traducción al ${targetLanguage}.`
                );
            }

            const map =
                new Map();

            for (
                const item of
                parsed.translations
            ) {
                const index =
                    Number(item?.index);

                const text =
                    cleanModelText(
                        item?.text
                    );

                if (
                    Number.isInteger(index) &&
                    index >= 1 &&
                    index <= segments.length &&
                    text
                ) {
                    map.set(
                        index,
                        text
                    );
                }
            }

            /*
             * Si faltan líneas, NO damos por terminada
             * la traducción.
             */
            if (
                map.size !==
                segments.length
            ) {
                throw new Error(
                    `Groq devolvió ${map.size}/${segments.length} traducciones.`
                );
            }

            return segments.map(
                (segment, index) => ({
                    start:
                        segment.start,
                    end:
                        segment.end,
                    text:
                        map.get(
                            index + 1
                        ) ||
                        segment.text
                })
            );

        } catch (error) {
            console.error(
                `[TRANSLATION ${language}] intento ${attempt}/${MAX_TEXT_RETRIES}:`,
                error.message
            );

            if (
                attempt <
                MAX_TEXT_RETRIES
            ) {
                await sleep(
                    Math.min(
                        30000,
                        1800 *
                        Math.pow(
                            2,
                            attempt - 1
                        )
                    )
                );
            }
        }
    }

    /*
     * FALLBACK:
     * No rompemos todo el procesamiento porque una traducción
     * haya fallado. Conservamos el árabe para ese segmento.
     *
     * Además dejamos un log identificable.
     */
    console.error(
        `[TRANSLATION ${language}] Groq no pudo traducir el lote después de todos los intentos. Se usa fallback al texto original.`
    );

    return segments.map(
        segment => ({
            start:
                segment.start,
            end:
                segment.end,
            text:
                segment.text
        })
    );
}

/* =========================================================
   TRADUCCIÓN POR LOTES PEQUEÑOS
   ========================================================= */

async function translateAllBatch(
    segments,
    language,
    apiKey
) {
    const BATCH_SIZE = 8;
    const result = [];

    for (
        let i = 0;
        i < segments.length;
        i += BATCH_SIZE
    ) {
        const batch =
            segments.slice(
                i,
                i + BATCH_SIZE
            );

        console.log(
            `[USER NASHEED] Traduciendo ${language}: segmentos ${i + 1}-${i + batch.length}/${segments.length}`
        );

        const translated =
            await translateBatch(
                batch,
                language,
                apiKey
            );

        result.push(
            ...translated
        );
    }

    return result;
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
                `[PRIVATE TRACK] Error firmando subtítulo ${language}:`,
                error.message
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
                            .select("id")
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
                        .from(BUCKET)
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
                    "[USER NASHEED] Obteniendo URL de audio..."
                );

                const signedAudio =
                    await supabase
                        .storage
                        .from(BUCKET)
                        .createSignedUrl(
                            row.audio_path,
                            1800
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
                        "No se pudo generar la URL firmada del audio."
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

                let whisperSegments =
                    await transcribeArabic(
                        signedAudio
                            .data
                            .signedUrl,
                        groqApiKey
                    );

                if (
                    !whisperSegments.length
                ) {
                    throw new Error(
                        "Whisper no devolvió segmentos."
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
                    40
                );

                /*
                 * ESTA ES LA PARTE CRÍTICA:
                 *
                 * Si Whisper devuelve:
                 *
                 * "allahumma salli..."
                 *
                 * se manda al GPT-OSS para reconstruir:
                 *
                 * "اللهم صل..."
                 *
                 * y se verifica que realmente haya caracteres árabes.
                 */
                const arabic =
                    await ensureArabicSegments(
                        whisperSegments,
                        groqApiKey
                    );

                if (
                    !arabic.length
                ) {
                    throw new Error(
                        "No se pudo obtener una transcripción utilizable."
                    );
                }

                console.log(
                    "[USER NASHEED] Árabe final:",
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

                const prefix =
                    row.audio_path
                        .split("/")
                        .slice(
                            0,
                            -1
                        )
                        .join("/");

                const subtitlePaths = {};

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
                        .from(BUCKET)
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
                        row
                            .subtitles
                            ?.__requested
                    );

                console.log(
                    "[USER NASHEED] Idiomas solicitados:",
                    requested
                );

                /*
                 * Nunca traducimos desde la transliteración.
                 * Siempre se usa `arabic`.
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

                    if (
                        language === "ar"
                    ) {
                        continue;
                    }

                    await checkIfCanceled(
                        supabase,
                        id,
                        currentUser.id
                    );

                    const progressPct =
                        totalLangs > 0
                            ? Math.min(
                                90,
                                Math.round(
                                    50 +
                                    (
                                        (i + 1) /
                                        totalLangs
                                    ) *
                                    40
                                )
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

                    const upload =
                        await supabase
                            .storage
                            .from(BUCKET)
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
                   GUARDAR COMO READY
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

                /*
                 * Comprobación final de que realmente guardamos
                 * el subtítulo árabe.
                 */
                const verification =
                    await supabase
                        .from(
                            "user_nasheeds"
                        )
                        .select(
                            "status,subtitles"
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
                    verification.error
                ) {
                    throw verification.error;
                }

                if (
                    !verification.data?.subtitles?.ar
                ) {
                    throw new Error(
                        "El procesamiento terminó pero no se encontró el subtítulo árabe guardado."
                    );
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
                    } catch (error) {
                        console.error(
                            `[PRIVATE TRACK ${row.id}]`,
                            error.message
                        );
                    }
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
````
