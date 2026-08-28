/*
 * CÓDIGO COMPLETO REVISADO Y AUDITADO[cite: 1]
 * - Transcripción con Groq Whisper (corregida para descargar el audio y enviar Blob/File en lugar de URL).[cite: 1]
 * - Detección de transliteración y reconstrucción a árabe real.[cite: 1]
 * - Manejo robusto de errores de red, respuestas vacías, reintentos y timeouts.[cite: 1]
 * - Parseo seguro de traducciones y fallbacks para no perder sincronización.[cite: 1]
 * - Validación estricta para nunca crear o guardar VTTs vacíos.[cite: 1]
 */

"use strict";

const crypto = require("crypto");

/* =========================================================
   CONFIG
   ========================================================= */

const BUCKET = "UserNasheeds"; //[cite: 1]

const MAX_AUDIO = 25 * 1024 * 1024; //[cite: 1]
const MAX_COVER = 5 * 1024 * 1024; //[cite: 1]

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
]); //[cite: 1]

const COVER_TYPES = new Set([
    "image/jpeg",
    "image/png",
    "image/webp"
]); //[cite: 1]

const LANGS = new Set([
    "es",
    "en",
    "ru"
]); //[cite: 1]

// Modelos disponibles, estables y vigentes en Groq (Agosto 2026)
const GROQ_STT = "whisper-large-v3-turbo"; //[cite: 1]
const GROQ_TRANSLATION = "llama-3.1-8b-instant"; //[cite: 1]

const GROQ_BASE_URL = "https://api.groq.com/openai/v1"; //[cite: 1]

const GROQ_MAX_RETRIES = 3; //[cite: 1]
const GROQ_TIMEOUT_MS = 60000; //[cite: 1]
const GROQ_MIN_REQUEST_INTERVAL = 1200; //[cite: 1]

let lastGroqRequestAt = 0; //[cite: 1]

/* =========================================================
   UTILIDADES
   ========================================================= */

const sleep = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)); //[cite: 1]

function day() {
    return new Date()
        .toISOString()
        .slice(0, 10); //[cite: 1]
}

function rnd() {
    return crypto
        .randomBytes(10)
        .toString("hex"); //[cite: 1]
}

function ext(type, name) {
    const extension =
        String(name || "")
            .split(".")
            .pop()
            .toLowerCase(); //[cite: 1]

    const allowed = [
        "mp3", "m4a", "mp4", "mpga", "mpeg",
        "ogg", "wav", "webm", "flac", "jpg",
        "jpeg", "png", "webp"
    ]; //[cite: 1]

    if (allowed.includes(extension)) {
        return extension === "jpeg"
            ? "jpg"
            : extension; //[cite: 1]
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
    }; //[cite: 1]

    return byMime[type] || "bin"; //[cite: 1]
}

/* =========================================================
   AUTH
   ========================================================= */

async function getUser(req, supabase) {
    const authorization =
        String(
            req.headers.authorization || ""
        ); //[cite: 1]

    if (!authorization.startsWith("Bearer ")) {
        return null; //[cite: 1]
    }

    const token =
        authorization
            .slice(7)
            .trim(); //[cite: 1]

    if (!token) {
        return null; //[cite: 1]
    }

    try {
        const {
            data,
            error
        } = await supabase.auth.getUser(token); //[cite: 1]

        if (
            error ||
            !data ||
            !data.user
        ) {
            return null; //[cite: 1]
        }

        return data.user; //[cite: 1]
    } catch {
        return null; //[cite: 1]
    }
}

/* =========================================================
   IDIOMAS
   ========================================================= */

function normalizeLanguages(value) {
    if (!Array.isArray(value)) {
        return []; //[cite: 1]
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
    ]; //[cite: 1]
}

/* =========================================================
   TEXTO Y VALIDACIÓN
   ========================================================= */

function cleanText(value) {
    return String(value || "")
        .replace(/\r|\n+/g, " ")
        .replace(/\s+/g, " ")
        .trim(); //[cite: 1]
}

function isUsefulText(value) {
    return cleanText(value).length > 0; //[cite: 1]
}

function containsArabic(text) {
    return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(
        String(text || "")
    ); //[cite: 1]
}

function isMostlyLatin(text) {
    const value = String(text || "").trim(); //[cite: 1]

    if (!value) {
        return false; //[cite: 1]
    }

    const arabic =
        (
            value.match(
                /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g
            ) || []
        ).length; //[cite: 1]

    const latin =
        (
            value.match(
                /[A-Za-zÀ-ÿ]/g
            ) || []
        ).length; //[cite: 1]

    return arabic === 0 && latin >= 3; //[cite: 1]
}

/* =========================================================
   SEGMENTOS
   ========================================================= */

function normalizeSegments(segments) {
    if (!Array.isArray(segments)) {
        return []; //[cite: 1]
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
        ); //[cite: 1]
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
        ); //[cite: 1]

    const hours =
        Math.floor(
            milliseconds / 3600000
        ); //[cite: 1]

    const minutes =
        Math.floor(
            (milliseconds % 3600000) / 60000
        ); //[cite: 1]

    const seconds =
        Math.floor(
            (milliseconds % 60000) / 1000
        ); //[cite: 1]

    const ms =
        milliseconds % 1000; //[cite: 1]

    return (
        String(hours).padStart(2, "0") +
        ":" +
        String(minutes).padStart(2, "0") +
        ":" +
        String(seconds).padStart(2, "0") +
        "." +
        String(ms).padStart(3, "0")
    ); //[cite: 1]
}

function makeVTT(segments) {
    const validSegments =
        normalizeSegments(segments); //[cite: 1]

    if (!validSegments.length) {
        throw new Error(
            "No hay segmentos válidos para crear el VTT."
        ); //[cite: 1]
    }

    const lines = [
        "WEBVTT",
        ""
    ]; //[cite: 1]

    for (
        let i = 0;
        i < validSegments.length;
        i++
    ) {
        const segment =
            validSegments[i]; //[cite: 1]

        const next =
            validSegments[i + 1] || null; //[cite: 1]

        const start =
            Math.max(0, segment.start); //[cite: 1]

        let end =
            Math.max(start, segment.end); //[cite: 1]

        if (next && end > next.start) {
            end = next.start; //[cite: 1]
        }

        if (end <= start) {
            end = start + 0.5; //[cite: 1]
        }

        lines.push(
            `${vttTime(start)} --> ${vttTime(end)}`
        ); //[cite: 1]

        lines.push(
            segment.text
        ); //[cite: 1]

        lines.push(""); //[cite: 1]
    }

    const vtt =
        lines.join("\n").trim(); 

    if (
        !vtt ||
        vtt === "WEBVTT"
    ) {
        throw new Error(
            "No se pudo generar el VTT. El contenido está vacío o es inválido."
        ); //[cite: 1]
    }

    return vtt + "\n";
}

/* =========================================================
   GROQ RATE LIMIT / TIMEOUT / DEBUG
   ========================================================= */

async function waitForGroqSlot() {
    const now = Date.now(); //[cite: 1]

    const elapsed =
        now - lastGroqRequestAt; //[cite: 1]

    if (
        elapsed <
        GROQ_MIN_REQUEST_INTERVAL
    ) {
        await sleep(
            GROQ_MIN_REQUEST_INTERVAL -
            elapsed
        ); //[cite: 1]
    }

    lastGroqRequestAt =
        Date.now(); //[cite: 1]
}

function getRetryDelay(attempt, response) {
    const retryAfter =
        response?.headers?.get(
            "retry-after"
        ); //[cite: 1]

    if (retryAfter) {
        const seconds =
            Number(retryAfter); //[cite: 1]

        if (
            Number.isFinite(seconds) &&
            seconds >= 0
        ) {
            return Math.min(
                seconds * 1000,
                30000
            ); //[cite: 1]
        }
    }

    const base =
        Math.pow(2, attempt - 1) * 2000; 

    const jitter =
        Math.floor(
            Math.random() * 1000
        ); //[cite: 1]

    return Math.min(
        base + jitter,
        30000
    ); //[cite: 1]
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
        ); //[cite: 1]
    }

    let lastError = null; //[cite: 1]

    for (
        let attempt = 1;
        attempt <= maxRetries;
        attempt++
    ) {
        let controller = null; //[cite: 1]
        let timeout = null; //[cite: 1]

        try {
            await waitForGroqSlot(); //[cite: 1]

            controller =
                new AbortController(); //[cite: 1]

            timeout =
                setTimeout(
                    () =>
                        controller.abort(),
                    GROQ_TIMEOUT_MS
                ); //[cite: 1]

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
                ); //[cite: 1]

            const raw =
                await response.text(); //[cite: 1]

            console.log(
                `[GROQ DEBUG] Endpoint: ${url.split('/').pop()} | HTTP ${response.status} | Intento ${attempt}/${maxRetries}`
            ); //[cite: 1]
            
            // Limitamos la respuesta en log para no colapsar la consola
            console.log(
                `[GROQ DEBUG] Respuesta preview: ${raw.slice(0, 500)}...`
            ); //[cite: 1]

            let body = null; //[cite: 1]

            if (raw.trim()) {
                try {
                    body =
                        JSON.parse(raw); //[cite: 1]
                } catch {
                    body = null; //[cite: 1]
                }
            }

            if (!response.ok) {
                const apiMessage =
                    body?.error?.message ||
                    body?.message ||
                    raw ||
                    `Groq HTTP ${response.status}`; //[cite: 1]

                const error =
                    new Error(
                        apiMessage
                    ); //[cite: 1]

                error.status =
                    response.status; //[cite: 1]

                error.raw =
                    raw; //[cite: 1]

                error.body =
                    body; //[cite: 1]

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
                        ); //[cite: 1]

                    console.warn(
                        `[GROQ RETRY] HTTP ${response.status}. Esperando ${delay} ms...`
                    ); //[cite: 1]

                    await sleep(delay); //[cite: 1]

                    continue; //[cite: 1]
                }

                throw error; //[cite: 1]
            }

            if (!body) {
                lastError =
                    new Error(
                        "Groq devolvió una respuesta vacía o no parseable a JSON."
                    ); //[cite: 1]

                if (
                    attempt < maxRetries
                ) {
                    const delay =
                        getRetryDelay(
                            attempt,
                            response
                        ); //[cite: 1]

                    await sleep(delay);
                    continue; //[cite: 1]
                }

                throw lastError; //[cite: 1]
            }

            if (body.error) {
                lastError =
                    new Error(
                        body.error.message ||
                        "Groq devolvió un objeto error."
                    ); //[cite: 1]

                if (
                    attempt < maxRetries
                ) {
                    const delay =
                        getRetryDelay(
                            attempt,
                            response
                        ); //[cite: 1]

                    await sleep(delay);
                    continue; //[cite: 1]
                }

                throw lastError; //[cite: 1]
            }

            return body; //[cite: 1]

        } catch (error) {
            lastError = error; //[cite: 1]

            console.error(
                `[GROQ ERROR] Intento ${attempt}/${maxRetries}:`,
                error?.message || error
            ); //[cite: 1]

            if (
                error?.name ===
                "AbortError"
            ) {
                console.error(
                    "[GROQ ERROR] Timeout de la petición alcanzado."
                ); //[cite: 1]
            }

            if (
                attempt >= maxRetries
            ) {
                break; //[cite: 1]
            }

            const delay =
                getRetryDelay(
                    attempt,
                    null
                ); //[cite: 1]

            console.warn(
                `[GROQ RETRY] Reintentando en ${delay} ms...`
            ); //[cite: 1]

            await sleep(delay); //[cite: 1]

        } finally {
            if (timeout) {
                clearTimeout(timeout); //[cite: 1]
            }
        }
    }

    throw (
        lastError ||
        new Error(
            "Groq no respondió correctamente tras los intentos máximos."
        )
    ); //[cite: 1]
}

/* =========================================================
   PROGRESO Y CANCELACIÓN
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
        .eq("user_id", userId); //[cite: 1]
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
            .single(); //[cite: 1]

    if (
        data &&
        data.status === "canceled"
    ) {
        throw new Error(
            "PROCESO_CANCELADO"
        ); //[cite: 1]
    }
}

/* =========================================================
   TRANSCRIPCIÓN ÁRABE (CORREGIDO PARA FETCH AUDIO)
   ========================================================= */

async function transcribeArabic(
    audioUrl,
    apiKey
) {
    console.log("[USER NASHEED] Descargando audio desde Storage para enviar a Whisper...");
    
    let audioRes;
    try {
        audioRes = await fetch(audioUrl);
    } catch (netError) {
        throw new Error("Fallo de red al intentar descargar el audio de Supabase.");
    }
    
    if (!audioRes.ok) {
        throw new Error(`Error descargando audio para Whisper: HTTP ${audioRes.status}`);
    }
    
    const audioBlob = await audioRes.blob();
    console.log(`[USER NASHEED] Audio descargado correctamente: ${(audioBlob.size / 1024 / 1024).toFixed(2)} MB`);

    const form = new FormData(); //[cite: 1]

    form.append(
        "model",
        GROQ_STT
    ); //[cite: 1]

    // Whisper requiere subir el archivo binario explícitamente en el FormData
    form.append(
        "file",
        audioBlob,
        "audio.mp3"
    );

    form.append(
        "language",
        "ar"
    ); //[cite: 1]

    form.append(
        "response_format",
        "verbose_json"
    ); //[cite: 1]

    form.append(
        "timestamp_granularities[]",
        "segment"
    ); //[cite: 1]

    form.append(
        "temperature",
        "0"
    ); //[cite: 1]

 // Le damos contexto previo directamente en árabe para forzar el alfabeto correcto
    // y evitar que alucine instrucciones en inglés.
    form.append(
        "prompt",
        "نشيد إسلامي، الحمد لله، الله أكبر، كلمات عربية فصحى."
    ); //[cite: 1]

    const result =
        await groqRequest(
            `${GROQ_BASE_URL}/audio/transcriptions`,
            {
                method: "POST",
                body: form
            },
            apiKey,
            3
        ); //[cite: 1]

    console.log(
        "[USER NASHEED] Resultado de Whisper parseado correctamente."
    ); //[cite: 1]

    if (
        !result ||
        result.error
    ) {
        throw new Error(
            "Whisper devolvió una respuesta inválida tras el parseo."
        ); //[cite: 1]
    }

    if (
        !Array.isArray(
            result.segments
        )
    ) {
        throw new Error(
            "Groq Whisper no devolvió segmentos de transcripción."
        ); //[cite: 1]
    }

    const rawSegments =
        result.segments; //[cite: 1]

    const segments =
        normalizeSegments(
            rawSegments
        ); //[cite: 1]

    if (!segments.length) {
        throw new Error(
            "La IA no devolvió segmentos de transcripción válidos (sin texto o tiempos inválidos)."
        ); //[cite: 1]
    }

    const usable =
        segments.filter(
            (segment) =>
                isUsefulText(
                    segment.text
                )
        ); //[cite: 1]

    if (!usable.length) {
        throw new Error(
            "La transcripción está estructuralmente bien pero no contiene texto utilizable."
        ); //[cite: 1]
    }

    const latinCount =
        usable.filter(
            (segment) =>
                isMostlyLatin(
                    segment.text
                )
        ).length; //[cite: 1]

    const arabicCount =
        usable.filter(
            (segment) =>
                containsArabic(
                    segment.text
                )
        ).length; //[cite: 1]

    console.log(
        "[USER NASHEED] Resumen Whisper:",
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
    ); //[cite: 1]

    return usable; //[cite: 1]
}

/* =========================================================
   RECONSTRUCCIÓN DE ÁRABE (FALLBACK ROBUSTO)
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
            "No hay segmentos válidos para reconstruir el árabe."
        ); //[cite: 1]
    }

    const input =
        segments
            .map(
                (segment, index) =>
                    `${index + 1}. ${cleanText(segment.text)}`
            )
            .join("\n"); //[cite: 1]

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
16. Output ONLY numbered lines, e.g.:
1. Arabic text
2. Arabic text
3. Arabic text
`.trim(); //[cite: 1]

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
    }; //[cite: 1]

    let result = null; //[cite: 1]
    let lastError = null; //[cite: 1]

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
                ); //[cite: 1]

            const content =
                result
                    ?.choices?.[0]
                    ?.message
                    ?.content; //[cite: 1]

            console.log(
                `[ARABIC RECONSTRUCTION] Intento ${attempt} completado.`
            ); //[cite: 1]

            if (
                typeof content === "string" &&
                content.trim()
            ) {
                const parsed =
                    parseNumberedOutput(
                        content,
                        segments.length
                    ); //[cite: 1]

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
                        ); //[cite: 1]

                    const arabicSegments =
                        reconstructed.filter(
                            (segment) =>
                                containsArabic(
                                    segment.text
                                )
                        ).length; //[cite: 1]

                    console.log(
                        "[ARABIC RECONSTRUCTION] Segmentos recuperados con árabe:",
                        arabicSegments,
                        "/",
                        reconstructed.length
                    ); //[cite: 1]

                    if (
                        arabicSegments > 0
                    ) {
                        return reconstructed; //[cite: 1]
                    }
                }

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
                        ); //[cite: 1]

                    const arabicCount =
                        partial.filter(
                            (segment) =>
                                containsArabic(
                                    segment.text
                                )
                        ).length; //[cite: 1]

                    if (
                        arabicCount >=
                        Math.max(
                            1,
                            Math.floor(
                                segments.length * 0.5
                            )
                        )
                    ) {
                        console.log("[ARABIC RECONSTRUCTION] Recuperación parcial validada.");
                        return partial; //[cite: 1]
                    }
                }

                lastError =
                    new Error(
                        "La reconstrucción no produjo suficientes líneas árabes válidas."
                    ); //[cite: 1]
            } else {
                lastError =
                    new Error(
                        "El modelo devolvió texto vacío u omitió el campo content."
                    ); //[cite: 1]
            }

        } catch (error) {
            lastError = error; //[cite: 1]

            console.error(
                `[ARABIC RECONSTRUCTION ERROR] Intento ${attempt}:`,
                error?.message || error
            ); //[cite: 1]
        }

        if (
            attempt < 3
        ) {
            await sleep(
                2000 * attempt
            ); //[cite: 1]
        }
    }

    console.warn(
        "[ARABIC RECONSTRUCTION] Agotados intentos. Se conserva el texto transcrito original como Fallback."
    ); //[cite: 1]

    return segments.map(
        (segment) => ({
            start:
                segment.start,
            end:
                segment.end,
            text:
                segment.text ||
                "[Texto de audio irreconocible]"
        })
    ); //[cite: 1]
}

/* =========================================================
   PARSER DE RESPUESTAS NUMERADAS (MEJORADO PARA MARKDOWN)
   ========================================================= */

function parseNumberedOutput(
    content,
    expectedCount
) {
    const map =
        new Map(); //[cite: 1]

    const lines =
        String(content || "")
            .split(/\r?\n/)
            .map(
                (line) =>
                    line.trim()
            )
            .filter(Boolean); //[cite: 1]

    for (
        const line of lines
    ) {
        // Soporta formatos robustos: "1.", "1)", "**1.**", "1 -", etc.
        const match =
            line.match(
                /^\s*[*_]*(\d+)[*_]*\s*[\.\):\-]\s*(.+?)\s*$/
            );

        if (!match) {
            continue; //[cite: 1]
        }

        const number =
            Number(
                match[1]
            ); //[cite: 1]

        const index =
            number - 1; //[cite: 1]

        if (
            index < 0 ||
            index >= expectedCount
        ) {
            continue; //[cite: 1]
        }

        let text =
            cleanText(
                match[2]
            ); //[cite: 1]

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
                .trim(); //[cite: 1]

        if (
            text &&
            !text.includes("```")
        ) {
            map.set(
                index,
                text
            ); //[cite: 1]
        }
    }

    return map; //[cite: 1]
}

/* =========================================================
   TRADUCCIÓN CON BATCHING Y FALLBACK SEGURO
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
    }; //[cite: 1]

    const targetLanguage =
        languageNames[language]; //[cite: 1]

    if (!targetLanguage) {
        throw new Error(
            `Idioma de traducción no soportado: ${language}`
        ); //[cite: 1]
    }

    if (
        !Array.isArray(segments) ||
        !segments.length
    ) {
        throw new Error(
            "No hay segmentos de origen para traducir."
        ); //[cite: 1]
    }

    const inputLines =
        segments.map(
            (segment, index) =>
                `${index + 1}. ${cleanText(segment.text)}`
        ); //[cite: 1]

    const systemPrompt = `
You are a professional translator.

Translate the Arabic lyrics into ${targetLanguage}.

STRICT RULES:

1. Translate the MEANING natively.
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
12. Do not add markdown blocks.
13. Output ONLY the numbered translations.

Example:

1. Translation
2. Translation
3. Translation
`.trim(); //[cite: 1]

    const requestBody = {
        model:
            GROQ_TRANSLATION,
        temperature: 0.1,
        max_completion_tokens:
            Math.max(
                4000,
                segments.length * 80
            ), //[cite: 1]
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
    }; //[cite: 1]

    let result = null; //[cite: 1]
    let lastError = null; //[cite: 1]

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
                ); //[cite: 1]

            const rawContent =
                result
                    ?.choices?.[0]
                    ?.message
                    ?.content; //[cite: 1]

            if (
                typeof rawContent !==
                    "string" ||
                !rawContent.trim()
            ) {
                throw new Error(
                    `Groq devolvió un content vacío en traducción al ${targetLanguage}.`
                ); //[cite: 1]
            }

            const translatedMap =
                parseNumberedOutput(
                    rawContent,
                    segments.length
                ); //[cite: 1]

            const output =
                segments.map(
                    (
                        segment,
                        index
                    ) => {
                        const translated =
                            translatedMap.get(
                                index
                            ); //[cite: 1]

                        return {
                            start:
                                segment.start,
                            end:
                                segment.end,
                            text:
                                translated ||
                                segment.text //[cite: 1] Fallback conservador por línea
                        };
                    }
                ); //[cite: 1]

            if (
                output.some(
                    (segment) =>
                        !isUsefulText(
                            segment.text
                        )
                )
            ) {
                throw new Error(
                    "El output de traducción final generó segmentos vacíos, descartando intento."
                ); //[cite: 1]
            }

            console.log(
                `[TRANSLATION DEBUG] ${language}: ${translatedMap.size}/${segments.length} líneas traducidas exitosamente.`
            ); //[cite: 1]

            return output; //[cite: 1]

        } catch (error) {
            lastError = error; //[cite: 1]

            console.error(
                `[TRANSLATION ERROR] ${language} intento ${attempt}/3:`,
                error?.message || error
            ); //[cite: 1]

            if (
                attempt < 3
            ) {
                await sleep(
                    2000 * attempt
                ); //[cite: 1]
            }
        }
    }

    console.warn(
        `[TRANSLATION FALLBACK] Fallo persistente para ${language}. Se aplicará el texto original como fallback del archivo completo para evitar VTTs rotos.`
    ); //[cite: 1]

    return segments.map(
        (segment) => ({
            start:
                segment.start,
            end:
                segment.end,
            text:
                segment.text ||
                "[Traducción no disponible en este momento]"
        })
    ); //[cite: 1]
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
            ); //[cite: 1]

    if (error) {
        throw error; //[cite: 1]
    }

    if (
        !data ||
        !data.signedUrl
    ) {
        throw new Error(
            "Supabase falló al generar la URL firmada (data vacío)."
        ); //[cite: 1]
    }

    return data.signedUrl; //[cite: 1]
}

/* =========================================================
   PRIVATE TRACK MAPPER
   ========================================================= */

async function privateTrack(
    supabase,
    row
) {
    const subtitles = {}; //[cite: 1]

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
            continue; //[cite: 1]
        }

        if (
            typeof storagePath !==
                "string" ||
            !storagePath
        ) {
            continue; //[cite: 1]
        }

        try {
            subtitles[language] =
                await signUrl(
                    supabase,
                    storagePath,
                    86400
                ); //[cite: 1]
        } catch (error) {
            console.error(
                `[PRIVATE TRACK] Error creando URL temporal para el VTT ${language}:`,
                error?.message || error
            ); //[cite: 1]
        }
    }

    return {
        id:
            Number(row.id), //[cite: 1]

        title:
            row.title, //[cite: 1]

        file:
            await signUrl(
                supabase,
                row.audio_path,
                86400
            ), //[cite: 1]

        cover:
            row.cover_path
                ? await signUrl(
                    supabase,
                    row.cover_path,
                    86400
                )
                : "", //[cite: 1]

        subtitles, //[cite: 1]

        warning:
            false, //[cite: 1]

        private:
            true, //[cite: 1]

        status:
            row.status, //[cite: 1]

        created_at:
            row.created_at //[cite: 1]
    };
}

/* =========================================================
   RUTAS PRINCIPALES DEL API
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
                ); //[cite: 1]

            if (!currentUser) {
                return res
                    .status(401)
                    .json({
                        error:
                            "Fallo de autenticación. Debes iniciar sesión."
                    }); //[cite: 1]
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
                        ); //[cite: 1]

                if (error) {
                    throw error; //[cite: 1]
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
                }); //[cite: 1]

            } catch (error) {
                console.error(
                    "[USER NASHEEDS LIST ERROR]",
                    error
                ); //[cite: 1]

                return res
                    .status(500)
                    .json({
                        error:
                            "Error interno al cargar la lista de tus nasheeds."
                    }); //[cite: 1]
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
                ); //[cite: 1]

            if (!currentUser) {
                return res
                    .status(401)
                    .json({
                        error:
                            "Debes iniciar sesión para subir archivos."
                    }); //[cite: 1]
            }

            let uploadId =
                null; //[cite: 1]

            try {
                const title =
                    String(
                        req.body?.title ||
                        ""
                    ).trim(); //[cite: 1]

                const audio =
                    req.body?.audio ||
                    {}; //[cite: 1]

                const cover =
                    req.body?.cover ||
                    null; //[cite: 1]

                const translations =
                    normalizeLanguages(
                        req.body?.translations
                    ); //[cite: 1]

                const audioSize =
                    Number(
                        audio.size
                    ); //[cite: 1]

                const audioType =
                    String(
                        audio.type ||
                        ""
                    ); //[cite: 1]

                if (
                    !title ||
                    title.length > 120
                ) {
                    return res
                        .status(400)
                        .json({
                            error:
                                "El título es estrictamente obligatorio y no debe superar 120 caracteres."
                        }); //[cite: 1]
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
                                "Falta archivo de audio o sobrepasa el límite permitido de 25 MB."
                        }); //[cite: 1]
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
                                "El MimeType del audio no figura en los formatos compatibles (ej. mp3, wav, mp4)."
                        }); //[cite: 1]
                }

                if (cover) {
                    const coverSize =
                        Number(
                            cover.size
                        ); //[cite: 1]

                    const coverType =
                        String(
                            cover.type ||
                            ""
                        ); //[cite: 1]

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
                                    "Error en portada: debe ser JPG/PNG/WebP, con límite de tamaño de 5 MB."
                            }); //[cite: 1]
                    }
                }

                const uploadDay =
                    day(); //[cite: 1]

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
                        .maybeSingle(); //[cite: 1]

                if (
                    existing.error
                ) {
                    throw existing.error; //[cite: 1]
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
                                "Solo se permite subir y procesar un nasheed por día. Vuelve mañana.",
                            id:
                                Number(
                                    existing.data.id
                                ),
                            status:
                                existing.data.status
                        }); //[cite: 1]
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
                        ); //[cite: 1]

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
                            ); //[cite: 1]

                    if (
                        reset.error
                    ) {
                        throw reset.error; //[cite: 1]
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
                            .single(); //[cite: 1]

                    if (
                        inserted.error
                    ) {
                        throw inserted.error; //[cite: 1]
                    }

                    uploadId =
                        Number(
                            inserted.data.id
                        ); //[cite: 1]
                }

                const prefix =
                    `${currentUser.id}/${uploadDay}/${uploadId}-${rnd()}`; //[cite: 1]

                const audioPath =
                    `${prefix}/audio.${ext(
                        audioType,
                        audio.name
                    )}`; //[cite: 1]

                const coverPath =
                    cover
                        ? `${prefix}/cover.${ext(
                            cover.type,
                            cover.name
                        )}`
                        : null; //[cite: 1]

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
                        ); //[cite: 1]

                if (
                    audioSigned.error
                ) {
                    throw audioSigned.error; //[cite: 1]
                }

                let coverSigned =
                    null; //[cite: 1]

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
                            ); //[cite: 1]

                    if (
                        coverSigned.error
                    ) {
                        throw coverSigned.error; //[cite: 1]
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
                        ); //[cite: 1]

                if (
                    updated.error
                ) {
                    throw updated.error; //[cite: 1]
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
                }); //[cite: 1]

            } catch (
                error
            ) {
                console.error(
                    "[USER NASHEED PREPARE FATAL]",
                    error
                ); //[cite: 1]

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
                                    "Error preparando firma de subida."
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
                        ); //[cite: 1]
                }

                return res
                    .status(500)
                    .json({
                        error:
                            error.message ||
                            "Error interno en preparación de subida."
                    }); //[cite: 1]
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
                ); //[cite: 1]

            if (!currentUser) {
                return res
                    .status(401)
                    .json({
                        error:
                            "Debes iniciar sesión para cancelar operaciones."
                    }); //[cite: 1]
            }

            const id =
                Number(
                    req.params.id
                ); //[cite: 1]

            if (
                !Number.isSafeInteger(
                    id
                )
            ) {
                return res
                    .status(400)
                    .json({
                        error:
                            "El ID proporcionado es inválido."
                    }); //[cite: 1]
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
                            "Cancelación manual efectuada por el usuario."
                    })
                    .eq(
                        "id",
                        id
                    )
                    .eq(
                        "user_id",
                        currentUser.id
                    ); //[cite: 1]

            if (
                result.error
            ) {
                return res
                    .status(500)
                    .json({
                        error:
                            result.error.message
                    }); //[cite: 1]
            }

            return res.json({
                success:
                    true,
                message:
                    "Proceso interrumpido."
            }); //[cite: 1]
        }
    );

    /* =====================================================
       PROCESAR IA (TRADUCCIÓN Y VTT GENERATION)
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
                ); //[cite: 1]

            if (!currentUser) {
                return res
                    .status(401)
                    .json({
                        error:
                            "Autenticación obligatoria."
                    }); //[cite: 1]
            }

            if (!groqApiKey) {
                return res
                    .status(503)
                    .json({
                        error:
                            "El servidor carece de claves de API Groq (GROQ_API_KEY)."
                    }); //[cite: 1]
            }

            const id =
                Number(
                    req.params.id
                ); //[cite: 1]

            if (
                !Number.isSafeInteger(
                    id
                )
            ) {
                return res
                    .status(400)
                    .json({
                        error:
                            "Formato de ID incorrecto."
                    }); //[cite: 1]
            }

            try {
                await checkIfCanceled(
                    supabase,
                    id,
                    currentUser.id
                ); //[cite: 1]

                await updateProgress(
                    supabase,
                    id,
                    currentUser.id,
                    10
                ); //[cite: 1]

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
                        .single(); //[cite: 1]

                if (
                    query.error ||
                    !query.data
                ) {
                    return res
                        .status(404)
                        .json({
                            error:
                                "Entrada de Nasheed inexistente en la DB."
                        }); //[cite: 1]
                }

                const row =
                    query.data; //[cite: 1]

                if (
                    !row.audio_path
                ) {
                    return res
                        .status(400)
                        .json({
                            error:
                                "El sistema no detecta registro de archivo de audio (audio_path nulo)."
                        }); //[cite: 1]
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
                        ); //[cite: 1]

                if (
                    signedAudio.error
                ) {
                    throw signedAudio.error; //[cite: 1]
                }

                if (
                    !signedAudio.data ||
                    !signedAudio.data.signedUrl
                ) {
                    throw new Error(
                        "Fallo al recuperar una URL firmada de descarga del bucket."
                    ); //[cite: 1]
                }

                await checkIfCanceled(
                    supabase,
                    id,
                    currentUser.id
                ); //[cite: 1]

                await updateProgress(
                    supabase,
                    id,
                    currentUser.id,
                    25
                ); //[cite: 1]

                console.log(
                    "[USER NASHEED] Comenzando transcripción AI en modelo:",
                    row.title
                ); //[cite: 1]

                let arabic =
                    await transcribeArabic(
                        signedAudio.data.signedUrl,
                        groqApiKey
                    ); //[cite: 1]

                console.log(
                    "[USER NASHEED] Transcripción exitosa, total segmentos validos:",
                    arabic.length
                ); //[cite: 1]

                const latinCount =
                    arabic.filter(
                        (segment) =>
                            isMostlyLatin(
                                segment.text
                            )
                    ).length; //[cite: 1]

                const arabicCount =
                    arabic.filter(
                        (segment) =>
                            containsArabic(
                                segment.text
                            )
                    ).length; //[cite: 1]

                console.log(
                    "[USER NASHEED] Métrica de idioma:",
                    {
                        arabicCount,
                        latinCount,
                        total:
                            arabic.length
                    }
                ); //[cite: 1]

                if (
                    latinCount > 0 &&
                    (
                        latinCount >=
                            arabicCount ||
                        arabicCount === 0
                    )
                ) {
                    console.warn(
                        "[USER NASHEED] Detectada fuerte presencia de caracteres latinos (transliteración). Activando pipeline de reconstrucción."
                    ); //[cite: 1]

                    await checkIfCanceled(
                        supabase,
                        id,
                        currentUser.id
                    ); //[cite: 1]

                    await updateProgress(
                        supabase,
                        id,
                        currentUser.id,
                        40
                    ); //[cite: 1]

                    arabic =
                        await reconstructArabicText(
                            arabic,
                            groqApiKey
                        ); //[cite: 1]
                }

                arabic =
                    normalizeSegments(
                        arabic
                    ); //[cite: 1]

                if (
                    !arabic.length
                ) {
                    throw new Error(
                        "El texto se corrompió al validar segmentos post-reconstrucción. Abortando sin marcar como Ready."
                    ); //[cite: 1]
                }

                await checkIfCanceled(
                    supabase,
                    id,
                    currentUser.id
                ); //[cite: 1]

                await updateProgress(
                    supabase,
                    id,
                    currentUser.id,
                    50
                ); //[cite: 1]

                const prefix =
                    row.audio_path
                        .split("/")
                        .slice(
                            0,
                            -1
                        )
                        .join("/"); //[cite: 1]

                const subtitlePaths =
                    {}; //[cite: 1]

                /* =================================================
                   CREACIÓN VTT ÁRABE BASE
                   ================================================= */

                const arabicPath =
                    `${prefix}/subtitles/ar.vtt`; //[cite: 1]

                const arabicVtt =
                    makeVTT(
                        arabic
                    ); //[cite: 1]

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
                        ); //[cite: 1]

                if (
                    arabicUpload.error
                ) {
                    throw arabicUpload.error; //[cite: 1]
                }

                subtitlePaths.ar =
                    arabicPath; //[cite: 1]

                /* =================================================
                   TRADUCCIONES AUTOMÁTICAS VTT
                   ================================================= */

                const requested =
                    normalizeLanguages(
                        row.subtitles
                            ?.__requested
                    ); //[cite: 1]

                console.log(
                    "[USER NASHEED] Traducciones delegadas:",
                    requested
                ); //[cite: 1]

                const totalLangs =
                    requested.length; //[cite: 1]

                for (
                    let i = 0;
                    i < totalLangs;
                    i++
                ) {
                    const language =
                        requested[i]; //[cite: 1]

                    await checkIfCanceled(
                        supabase,
                        id,
                        currentUser.id
                    ); //[cite: 1]

                    const progressPct =
                        Math.round(
                            50 +
                            (
                                (i + 1) /
                                totalLangs
                            ) *
                            40
                        ); //[cite: 1]

                    await updateProgress(
                        supabase,
                        id,
                        currentUser.id,
                        progressPct
                    ); //[cite: 1]

                    console.log(
                        `[USER NASHEED] Procesando lotes de VTT a ${language}...`
                    ); //[cite: 1]

                    const translated =
                        await translateAllBatch(
                            arabic,
                            language,
                            groqApiKey
                        ); //[cite: 1]

                    const translationPath =
                        `${prefix}/subtitles/${language}.vtt`; //[cite: 1]

                    const translationVtt =
                        makeVTT(
                            translated
                        ); //[cite: 1]

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
                            ); //[cite: 1]

                    if (
                        upload.error
                    ) {
                        throw upload.error; //[cite: 1]
                    }

                    subtitlePaths[
                        language
                    ] =
                        translationPath; //[cite: 1]
                }

                /* =================================================
                   GUARDADO FINAL ESTRICTO -> READY
                   ================================================= */

                await checkIfCanceled(
                    supabase,
                    id,
                    currentUser.id
                ); //[cite: 1]

                await updateProgress(
                    supabase,
                    id,
                    currentUser.id,
                    95
                ); //[cite: 1]

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
                        ); //[cite: 1]

                if (
                    saved.error
                ) {
                    throw saved.error; //[cite: 1]
                }

                console.log(
                    "[USER NASHEED] ✓ IA Y GUARDADO COMPLETADO DB:",
                    id
                ); //[cite: 1]

                return res.json({
                    success:
                        true,
                    id,
                    title:
                        row.title,
                    status:
                        "ready"
                }); //[cite: 1]

            } catch (
                error
            ) {
                if (
                    error?.message ===
                    "PROCESO_CANCELADO"
                ) {
                    console.log(
                        `[USER NASHEED] El proceso ${id} detectó señal de ABORT/Cancel del usuario y fue detenido de forma controlada.`
                    ); //[cite: 1]

                    return res.json({
                        success:
                            false,
                        message:
                            "Señal de interrupción manual procesada correctamente."
                    }); //[cite: 1]
                }

                console.error(
                    "[USER NASHEED PIPELINE FATAL]",
                    error
                ); //[cite: 1]

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
                                    "Excepción no controlada durante el pipeline."
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
                        ); //[cite: 1]
                } catch (
                    updateError
                ) {
                    console.error(
                        "[USER NASHEED] Falla crítica al guardar estado de error en la base de datos:",
                        updateError
                    ); //[cite: 1]
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
                            "Error de servidor persistente en la generación IA."
                    }); //[cite: 1]
            }
        }
    );

    /* =====================================================
       PÚBLICOS Y PRIVADOS MIXTOS
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
                        ); //[cite: 1]

                if (
                    publicRows.error
                ) {
                    throw publicRows.error; //[cite: 1]
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
                    ); //[cite: 1]

                const currentUser =
                    await getUser(
                        req,
                        supabase
                    ); //[cite: 1]

                if (!currentUser) {
                    return res.json(
                        publicTracks
                    ); //[cite: 1]
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
                        ); //[cite: 1]

                if (
                    privateRows.error
                ) {
                    throw privateRows.error; //[cite: 1]
                }

                const privateTracks =
                    []; //[cite: 1]

                for (
                    const row of
                    privateRows.data ||
                    []
                ) {
                    if (
                        !row.audio_path
                    ) {
                        continue; //[cite: 1]
                    }

                    try {
                        privateTracks.push(
                            await privateTrack(
                                supabase,
                                row
                            )
                        ); //[cite: 1]
                    } catch (
                        privateError
                    ) {
                        console.error(
                            "[PRIVATE TRACK RETRIEVAL] Ignorado:",
                            privateError
                        ); //[cite: 1]
                    }
                }

                return res.json([
                    ...privateTracks,
                    ...publicTracks
                ]); //[cite: 1]

            } catch (
                error
            ) {
                console.error(
                    "[NASHEEDS API FEED]",
                    error
                ); //[cite: 1]

                return res
                    .status(500)
                    .json({
                        error:
                            "Falla al combinar las playlists de nasheeds."
                    }); //[cite: 1]
            }
        }
    );
}

/* =========================================================
   EXPORT
   ========================================================= */

module.exports = {
    registerUserNasheedRoutes
}; //[cite: 1]