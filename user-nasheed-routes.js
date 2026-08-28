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

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";

const GROQ_MAX_RETRIES = 3;
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
        "mp3", "m4a", "mp4", "mpga", "mpeg",
        "ogg", "wav", "webm", "flac", "jpg",
        "jpeg", "png", "webp"
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
   TEXTO Y VALIDACIÓN
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
   SEGMENTOS Y OPTIMIZACIÓN (3-4 PALABRAS)
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

// Trocea los segmentos devueltos por Whisper en bloques de ~4 palabras
// para lograr un efecto karaoke vistoso y preciso.
function optimizeSegments(whisperResult, maxWords = 4) {
    let rawChunks = [];

    // Intento primario: Usar timestamps exactos por palabra (si el modelo lo devolvió)
    if (whisperResult.words && Array.isArray(whisperResult.words) && whisperResult.words.length > 0) {
        let currentChunk = [];
        for (const w of whisperResult.words) {
            if (!w.word || !cleanText(w.word)) continue;
            currentChunk.push(w);
            if (currentChunk.length >= maxWords) {
                rawChunks.push({
                    start: Number(currentChunk[0].start),
                    end: Number(currentChunk[currentChunk.length - 1].end),
                    text: currentChunk.map(x => cleanText(x.word)).join(" ")
                });
                currentChunk = [];
            }
        }
        if (currentChunk.length > 0) {
            rawChunks.push({
                start: Number(currentChunk[0].start),
                end: Number(currentChunk[currentChunk.length - 1].end),
                text: currentChunk.map(x => cleanText(x.word)).join(" ")
            });
        }
    } 
    // Intento secundario: Fallback matemático (cortar el segmento base en partes iguales)
    else if (whisperResult.segments && Array.isArray(whisperResult.segments)) {
        for (const seg of whisperResult.segments) {
            const text = cleanText(seg.text);
            if (!text) continue;
            
            const words = text.split(/\s+/);
            if (words.length <= maxWords) {
                rawChunks.push({ start: Number(seg.start), end: Number(seg.end), text });
                continue;
            }
            
            const duration = Number(seg.end) - Number(seg.start);
            const timePerWord = duration / words.length;
            
            for (let i = 0; i < words.length; i += maxWords) {
                const slice = words.slice(i, i + maxWords);
                rawChunks.push({
                    start: Number(seg.start) + (i * timePerWord),
                    end: Number(seg.start) + ((i + slice.length) * timePerWord),
                    text: slice.join(" ")
                });
            }
        }
    }

    return normalizeSegments(rawChunks);
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
        const segment = validSegments[i];
        const next = validSegments[i + 1] || null;

        let start = Math.max(0, segment.start);
        let end = Math.max(start + 0.1, segment.end); // Asegurar duración mínima de 100ms

        // Evitar overlap que rompe los parsers de VTT
        if (next && end > next.start) {
            end = Math.max(start + 0.1, next.start - 0.001); 
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
        lines.join("\n").trim(); 

    if (
        !vtt ||
        vtt === "WEBVTT"
    ) {
        throw new Error(
            "No se pudo generar el VTT. El contenido está vacío o es inválido."
        );
    }

    return vtt + "\n";
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
        Math.pow(2, attempt - 1) * 2000; 

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
                `[GROQ DEBUG] Endpoint: ${url.split('/').pop()} | HTTP ${response.status} | Intento ${attempt}/${maxRetries}`
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
                        "Groq devolvió una respuesta vacía o no parseable a JSON."
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
                `[GROQ ERROR] Intento ${attempt}/${maxRetries}:`,
                error?.message || error
            );

            if (
                error?.name ===
                "AbortError"
            ) {
                console.error(
                    "[GROQ ERROR] Timeout de la petición alcanzado."
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
            "Groq no respondió correctamente tras los intentos máximos."
        )
    );
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

    const form = new FormData();

    form.append(
        "model",
        GROQ_STT
    );

    form.append(
        "file",
        audioBlob,
        "audio.mp3"
    );

    form.append(
        "language",
        "ar"
    );

    form.append(
        "response_format",
        "verbose_json"
    );

    // Pedimos tiempos exactos de las palabras para hacer cortes perfectos a 3-4 palabras
    form.append(
        "timestamp_granularities[]",
        "word"
    );
    form.append(
        "timestamp_granularities[]",
        "segment"
    );

    form.append(
        "temperature",
        "0"
    );

    // Prompt en árabe directo, para evitar que la IA alucine con texto en inglés
    form.append(
        "prompt",
        "نشيد إسلامي، الحمد لله، الله أكبر، كلمات عربية فصحى."
    );

    const result =
        await groqRequest(
            `${GROQ_BASE_URL}/audio/transcriptions`,
            {
                method: "POST",
                body: form
            },
            apiKey,
            3
        );

    console.log(
        "[USER NASHEED] Resultado de Whisper parseado correctamente."
    );

    if (
        !result ||
        result.error
    ) {
        throw new Error(
            "Whisper devolvió una respuesta inválida tras el parseo."
        );
    }

    if (
        !Array.isArray(
            result.segments
        )
    ) {
        throw new Error(
            "Groq Whisper no devolvió segmentos de transcripción."
        );
    }

    // Usar la función de optimización para dividir todo en fragmentos de 4 palabras
    const segments = optimizeSegments(result, 4);

    if (!segments.length) {
        throw new Error(
            "La IA no devolvió segmentos de transcripción válidos (sin texto o tiempos inválidos)."
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
            "La transcripción está estructuralmente bien pero no contiene texto utilizable."
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
        "[USER NASHEED] Resumen Whisper Optimizado:",
        {
            validChunks:
                usable.length,
            arabicSegments:
                arabicCount,
            latinSegments:
                latinCount
        }
    );

    return usable;
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
                /^\s*[*_]*(\d+)[*_]*\s*[\.\):\-]\s*(.+?)\s*$/
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
   RECONSTRUCCIÓN DE ÁRABE BATCHED
   ========================================================= */

async function reconstructBatchChunk(batch, apiKey) {
    const input =
        batch
            .map(
                (segment, index) =>
                    `${index + 1}. ${cleanText(segment.text)}`
            )
            .join("\n");

    const systemPrompt = `
You are an expert Arabic linguist.
The input consists of short numbered fragments (3-4 words) from a nasheed.
Reconstruct the ACTUAL ARABIC SCRIPT.

STRICT RULES:
1. Output Arabic Unicode script.
2. NEVER output Latin transliteration.
3. NEVER translate the lyrics.
4. Keep the exact number of numbered lines.
5. Each line must contain ONLY the reconstructed Arabic text.
6. Do not invent unrelated text.
7. Output ONLY numbered lines, e.g.:
1. Arabic text
2. Arabic text
`.trim();

    const requestBody = {
        model: GROQ_TRANSLATION,
        temperature: 0.1,
        max_completion_tokens: 3000,
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: input }
        ]
    };

    let result = null;
    let lastError = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            result = await groqRequest(
                `${GROQ_BASE_URL}/chat/completions`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(requestBody)
                },
                apiKey
            );

            const content = result?.choices?.[0]?.message?.content;

            if (typeof content === "string" && content.trim()) {
                const parsed = parseNumberedOutput(content, batch.length);

                const reconstructed = batch.map((segment, index) => ({
                    start: segment.start,
                    end: segment.end,
                    text: parsed.get(index) || segment.text
                }));

                const arabicSegments = reconstructed.filter(seg => containsArabic(seg.text)).length;

                if (arabicSegments >= Math.max(1, Math.floor(batch.length * 0.5))) {
                    return reconstructed;
                }

                lastError = new Error("El modelo no produjo suficientes fragmentos árabes.");
            } else {
                lastError = new Error("El modelo devolvió texto vacío.");
            }
        } catch (error) {
            lastError = error;
            console.error(`[ARABIC RECONSTRUCTION CHUNK ERROR] Intento ${attempt}:`, error?.message);
        }

        if (attempt < 3) await sleep(2000 * attempt);
    }

    console.warn("[ARABIC RECONSTRUCTION] Lote fallido. Se conserva texto original para este lote.");
    return batch.map(segment => ({
        start: segment.start,
        end: segment.end,
        text: segment.text || "[Audio irreconocible]"
    }));
}

async function reconstructArabicText(segments, apiKey) {
    if (!Array.isArray(segments) || !segments.length) {
        throw new Error("No hay segmentos para reconstruir.");
    }

    const BATCH_SIZE = 15;
    const finalSegments = [];

    for (let i = 0; i < segments.length; i += BATCH_SIZE) {
        const batch = segments.slice(i, i + BATCH_SIZE);
        console.log(`[USER NASHEED] Reconstruyendo árabe (Lote ${Math.floor(i/BATCH_SIZE)+1} de ${Math.ceil(segments.length/BATCH_SIZE)})...`);
        
        const reconstructedBatch = await reconstructBatchChunk(batch, apiKey);
        finalSegments.push(...reconstructedBatch);
        
        if (i + BATCH_SIZE < segments.length) await sleep(1500);
    }

    return finalSegments;
}

/* =========================================================
   TRADUCCIÓN CON BATCHING Y FALLBACK SEGURO
   ========================================================= */

async function translateBatchChunk(batch, targetLanguage, apiKey) {
    const inputLines =
        batch.map(
            (segment, index) =>
                `${index + 1}. ${cleanText(segment.text)}`
        );

    const systemPrompt = `
You are a professional translator.
The input consists of short numbered fragments (3-4 words each) from an Arabic nasheed.
Translate each numbered fragment directly into ${targetLanguage}.

STRICT RULES:
1. Translate the MEANING natively into ${targetLanguage}.
2. Do NOT transliterate Arabic.
3. Do NOT reproduce Arabic words.
4. Keep the exact numbered structure matching the input count.
5. Do not merge lines. Do not omit lines.
6. Output ONLY the numbered translations. Example:
1. Translation
2. Translation
`.trim();

    const requestBody = {
        model: GROQ_TRANSLATION,
        temperature: 0.1,
        max_completion_tokens: 3000,
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: inputLines.join("\n") }
        ]
    };

    let result = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            result = await groqRequest(
                `${GROQ_BASE_URL}/chat/completions`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(requestBody)
                },
                apiKey
            );

            const rawContent = result?.choices?.[0]?.message?.content;

            if (typeof rawContent !== "string" || !rawContent.trim()) {
                throw new Error(`Content vacío en traducción.`);
            }

            const translatedMap = parseNumberedOutput(rawContent, batch.length);

            const output = batch.map((segment, index) => {
                const translated = translatedMap.get(index);
                return {
                    start: segment.start,
                    end: segment.end,
                    text: translated || segment.text 
                };
            });

            if (output.some((segment) => !isUsefulText(segment.text))) {
                throw new Error("El output final generó segmentos vacíos.");
            }

            return output;

        } catch (error) {
            console.error(`[TRANSLATION CHUNK ERROR] ${targetLanguage} intento ${attempt}/3:`, error?.message);
            if (attempt < 3) await sleep(2000 * attempt);
        }
    }

    console.warn(`[TRANSLATION FALLBACK] Fallo en lote para ${targetLanguage}. Se aplica texto original como rescate.`);
    return batch.map(segment => ({
        start: segment.start,
        end: segment.end,
        text: segment.text || "[Traducción no disponible]"
    }));
}

async function translateAllBatch(segments, language, apiKey) {
    const languageNames = {
        es: "Spanish",
        en: "English",
        ru: "Russian"
    };

    const targetLanguage = languageNames[language];

    if (!targetLanguage) {
        throw new Error(`Idioma de traducción no soportado: ${language}`);
    }

    if (!Array.isArray(segments) || !segments.length) {
        throw new Error("No hay segmentos de origen para traducir.");
    }

    const BATCH_SIZE = 15; // Tamaño de lote vital para que los modelos no se pierdan contando
    const allTranslated = [];

    for (let i = 0; i < segments.length; i += BATCH_SIZE) {
        const batch = segments.slice(i, i + BATCH_SIZE);
        console.log(`[USER NASHEED] Traduciendo a ${language} (Lote ${Math.floor(i/BATCH_SIZE)+1} de ${Math.ceil(segments.length/BATCH_SIZE)})...`);
        
        const translatedBatch = await translateBatchChunk(batch, targetLanguage, apiKey);
        allTranslated.push(...translatedBatch);
        
        if (i + BATCH_SIZE < segments.length) {
            await sleep(1500); // Pausa para no disparar limites de API de Groq
        }
    }

    return allTranslated;
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
            "Supabase falló al generar la URL firmada (data vacío)."
        );
    }

    return data.signedUrl;
}

/* =========================================================
   PRIVATE TRACK MAPPER
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
                `[PRIVATE TRACK] Error creando URL temporal para el VTT ${language}:`,
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
                );

            if (!currentUser) {
                return res
                    .status(401)
                    .json({
                        error:
                            "Fallo de autenticación. Debes iniciar sesión."
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
                    "[USER NASHEEDS LIST ERROR]",
                    error
                );

                return res
                    .status(500)
                    .json({
                        error:
                            "Error interno al cargar la lista de tus nasheeds."
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
                            "Debes iniciar sesión para subir archivos."
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
                                "El título es estrictamente obligatorio y no debe superar 120 caracteres."
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
                                "Falta archivo de audio o sobrepasa el límite permitido de 25 MB."
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
                                "El MimeType del audio no figura en los formatos compatibles (ej. mp3, wav, mp4)."
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
                                    "Error en portada: debe ser JPG/PNG/WebP, con límite de tamaño de 5 MB."
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
                                "Solo se permite subir y procesar un nasheed por día. Vuelve mañana.",
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
                    "[USER NASHEED PREPARE FATAL]",
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
                        );
                }

                return res
                    .status(500)
                    .json({
                        error:
                            error.message ||
                            "Error interno en preparación de subida."
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
                            "Debes iniciar sesión para cancelar operaciones."
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
                            "El ID proporcionado es inválido."
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
                            "Cancelación manual efectuada por el usuario."
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
                    "Proceso interrumpido."
            });
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
                );

            if (!currentUser) {
                return res
                    .status(401)
                    .json({
                        error:
                            "Autenticación obligatoria."
                    });
            }

            if (!groqApiKey) {
                return res
                    .status(503)
                    .json({
                        error:
                            "El servidor carece de claves de API Groq (GROQ_API_KEY)."
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
                            "Formato de ID incorrecto."
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
                                "Entrada de Nasheed inexistente en la DB."
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
                                "El sistema no detecta registro de archivo de audio (audio_path nulo)."
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
                        "Fallo al recuperar una URL firmada de descarga del bucket."
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
                    "[USER NASHEED] Comenzando transcripción AI en modelo:",
                    row.title
                );

                let arabic =
                    await transcribeArabic(
                        signedAudio.data.signedUrl,
                        groqApiKey
                    );

                console.log(
                    "[USER NASHEED] Transcripción optimizada exitosa, total de segmentos (fragmentos cortos):",
                    arabic.length
                );

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

                if (
                    latinCount > 0 &&
                    (
                        latinCount >=
                            arabicCount ||
                        arabicCount === 0
                    )
                ) {
                    console.warn(
                        "[USER NASHEED] Detectada fuerte presencia de caracteres latinos (transliteración). Activando pipeline de reconstrucción..."
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

                arabic =
                    normalizeSegments(
                        arabic
                    );

                if (
                    !arabic.length
                ) {
                    throw new Error(
                        "El texto se corrompió al validar segmentos post-reconstrucción. Abortando sin marcar como Ready."
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
                   CREACIÓN VTT ÁRABE BASE
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
                   TRADUCCIONES AUTOMÁTICAS VTT
                   ================================================= */

                const requested =
                    normalizeLanguages(
                        row.subtitles
                            ?.__requested
                    );

                console.log(
                    "[USER NASHEED] Traducciones solicitadas:",
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
                   GUARDADO FINAL ESTRICTO -> READY
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
                    "[USER NASHEED] ✓ IA Y GUARDADO COMPLETADO DB:",
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
                        `[USER NASHEED] El proceso ${id} detectó señal de ABORT/Cancel del usuario y fue detenido de forma controlada.`
                    );

                    return res.json({
                        success:
                            false,
                        message:
                            "Señal de interrupción manual procesada correctamente."
                    });
                }

                console.error(
                    "[USER NASHEED PIPELINE FATAL]",
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
                        );
                } catch (
                    updateError
                ) {
                    console.error(
                        "[USER NASHEED] Falla crítica al guardar estado de error en la base de datos:",
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
                            "Error de servidor persistente en la generación IA."
                    });
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
                            "[PRIVATE TRACK RETRIEVAL] Ignorado:",
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
                    "[NASHEEDS API FEED]",
                    error
                );

                return res
                    .status(500)
                    .json({
                        error:
                            "Falla al combinar las playlists de nasheeds."
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