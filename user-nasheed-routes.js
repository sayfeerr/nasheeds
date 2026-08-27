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
 * Whisper Turbo es el modelo de transcripción.
 * Es bastante más barato que whisper-large-v3.
 */
const GROQ_STT = "whisper-large-v3-turbo";

/*
 * IMPORTANTE:
 *
 * No fijamos aquí un único modelo de chat.
 *
 * Tu proyecto puede no tener acceso a un modelo aunque exista
 * en la documentación de Groq.
 *
 * El código consulta /models y selecciona automáticamente
 * uno de los modelos disponibles para TU API KEY.
 *
 * El orden prioriza modelos pequeños/baratos.
 */
const CHAT_MODEL_PREFERENCE = [
    "llama-3.1-8b-instant",
    "openai/gpt-oss-20b",
    "llama-3.3-70b-versatile",
    "openai/gpt-oss-120b"
];

let cachedChatModel = null;
let cachedChatModelAt = 0;

/*
 * Cada cuánto volvemos a comprobar los modelos disponibles.
 */
const MODEL_CACHE_MS = 10 * 60 * 1000;

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
 * Limpia caracteres que los modelos a veces añaden
 * alrededor de una respuesta.
 */
function cleanModelText(value) {
    return String(value || "")
        .replace(/```[a-zA-Z0-9_-]*/g, "")
        .replace(/```/g, "")
        .replace(/\u200B/g, "")
        .replace(/\u200C/g, "")
        .replace(/\u200D/g, "")
        .replace(/\uFEFF/g, "")
        .trim();
}

/* =========================================================
   DETECCIÓN DE ÁRABE / TRANSLITERACIÓN
   ========================================================= */

/*
 * Rangos Unicode árabes:
 *
 * U+0600-U+06FF
 * U+0750-U+077F
 * U+08A0-U+08FF
 * U+FB50-U+FDFF
 * U+FE70-U+FEFF
 */
function arabicCharacterCount(text) {
    const value = String(text || "");

    const matches = value.match(
        /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g
    );

    return matches ? matches.length : 0;
}

function latinCharacterCount(text) {
    const value = String(text || "");

    const matches = value.match(
        /[A-Za-zÀ-ÖØ-öø-ÿ]/g
    );

    return matches ? matches.length : 0;
}

function hasArabic(text) {
    return arabicCharacterCount(text) > 0;
}

function isMostlyLatin(text) {
    const value = String(text || "").trim();

    if (!value) {
        return false;
    }

    const arabic = arabicCharacterCount(value);
    const latin = latinCharacterCount(value);

    /*
     * Si no hay árabe y hay letras latinas,
     * es prácticamente seguro que no es escritura árabe.
     */
    if (arabic === 0 && latin >= 3) {
        return true;
    }

    /*
     * Si hay muchísimo más latín que árabe,
     * consideramos que probablemente es transliteración.
     */
    if (
        latin >= 8 &&
        latin > arabic * 2.5
    ) {
        return true;
    }

    return false;
}

function textLooksLikeArabic(segments) {
    if (!Array.isArray(segments) || !segments.length) {
        return false;
    }

    const texts = segments
        .map((segment) =>
            cleanText(segment?.text)
        )
        .filter(Boolean);

    if (!texts.length) {
        return false;
    }

    const allText = texts.join(" ");

    const arabicCount =
        arabicCharacterCount(allText);

    const latinCount =
        latinCharacterCount(allText);

    /*
     * Para considerar que la transcripción es árabe,
     * exigimos una presencia real de caracteres árabes.
     */
    if (arabicCount < 3) {
        return false;
    }

    if (
        latinCount > 0 &&
        latinCount > arabicCount * 1.5
    ) {
        return false;
    }

    const latinSegments = texts.filter(
        (text) => isMostlyLatin(text)
    ).length;

    if (
        latinSegments >
        Math.max(2, Math.ceil(texts.length * 0.5))
    ) {
        return false;
    }

    return true;
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

/*
 * Une segmentos demasiado pequeños cuando son realmente
 * partes consecutivas de la misma frase.
 *
 * NO cambia los timestamps de forma agresiva.
 */
function mergeVerySmallSegments(segments) {
    const normalized =
        normalizeSegments(segments);

    if (normalized.length <= 1) {
        return normalized;
    }

    const result = [];

    for (const segment of normalized) {
        const previous =
            result[result.length - 1];

        if (!previous) {
            result.push({
                ...segment
            });
            continue;
        }

        const gap =
            segment.start - previous.end;

        const previousWords =
            previous.text
                .split(/\s+/)
                .filter(Boolean).length;

        /*
         * Evita crear subtítulos microscópicos.
         */
        if (
            previousWords <= 2 &&
            gap >= -0.05 &&
            segment.start - previous.start < 4
        ) {
            previous.end =
                Math.max(
                    previous.end,
                    segment.end
                );

            previous.text =
                `${previous.text} ${segment.text}`
                    .replace(/\s+/g, " ")
                    .trim();

            continue;
        }

        result.push({
            ...segment
        });
    }

    return result;
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
        (
            milliseconds %
            3600000
        ) / 60000
    );

    const seconds = Math.floor(
        (
            milliseconds %
            60000
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
                    )
                        ? retryAfter * 1000
                        : attempt * 2500;

                console.warn(
                    `[GROQ RATE LIMIT 429] Reintentando (${attempt}/${maxRetries}) en ${Math.round(waitTime / 1000)}s...`
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

                error.body = body;

                throw error;
            }

            return body;
        } catch (error) {
            lastError = error;

            if (
                error?.status === 429 &&
                attempt < maxRetries
            ) {
                await sleep(
                    attempt * 2500
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
   BUSCAR MODELO DE CHAT DISPONIBLE
   ========================================================= */

async function getAvailableChatModel(apiKey) {
    const now = Date.now();

    if (
        cachedChatModel &&
        now - cachedChatModelAt <
            MODEL_CACHE_MS
    ) {
        return cachedChatModel;
    }

    try {
        const result =
            await groqRequest(
                "https://api.groq.com/openai/v1/models",
                {
                    method: "GET"
                },
                apiKey,
                2
            );

        const models =
            Array.isArray(result?.data)
                ? result.data
                : [];

        const availableIds =
            new Set(
                models
                    .map(
                        (model) =>
                            String(
                                model?.id || ""
                            )
                    )
                    .filter(Boolean)
            );

        console.log(
            "[GROQ] Modelos de chat disponibles:",
            [...availableIds].filter(
                (id) =>
                    CHAT_MODEL_PREFERENCE.includes(
                        id
                    )
            )
        );

        for (
            const preferred of
            CHAT_MODEL_PREFERENCE
        ) {
            if (
                availableIds.has(
                    preferred
                )
            ) {
                cachedChatModel =
                    preferred;

                cachedChatModelAt =
                    now;

                console.log(
                    `[GROQ] Modelo de chat seleccionado: ${preferred}`
                );

                return preferred;
            }
        }

        /*
         * Si ninguno de los modelos preferidos aparece,
         * buscamos un modelo de texto razonable.
         */
        const fallback =
            models.find((model) => {
                const id =
                    String(
                        model?.id || ""
                    ).toLowerCase();

                return (
                    id.includes("llama") ||
                    id.includes("gpt-oss") ||
                    id.includes("qwen")
                );
            });

        if (fallback?.id) {
            cachedChatModel =
                String(fallback.id);

            cachedChatModelAt =
                now;

            console.warn(
                `[GROQ] No se encontró un modelo preferido. Usando: ${cachedChatModel}`
            );

            return cachedChatModel;
        }

        throw new Error(
            "Tu API key de Groq no tiene ningún modelo de chat disponible."
        );
    } catch (error) {
        /*
         * Si /models falla pero el usuario ha definido
         * manualmente GROQ_TRANSLATION_MODEL,
         * utilizamos ese modelo.
         */
        const envModel =
            String(
                process.env.GROQ_TRANSLATION_MODEL ||
                ""
            ).trim();

        if (envModel) {
            console.warn(
                `[GROQ] No se pudo consultar /models. Usando GROQ_TRANSLATION_MODEL=${envModel}`
            );

            cachedChatModel =
                envModel;

            cachedChatModelAt =
                now;

            return envModel;
        }

        throw error;
    }
}

/* =========================================================
   CONTROL DE PROGRESO Y CANCELACIÓN
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

    /*
     * MUY IMPORTANTE:
     *
     * No usamos audio/translations.
     * Queremos la transcripción original en árabe.
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

    /*
     * Prompt MUY estricto.
     *
     * El problema anterior era que Whisper podía decidir
     * escribir la pronunciación árabe usando letras latinas.
     */
    form.append(
        "prompt",
        [
            "Arabic nasheed lyrics.",
            "The speaker is singing Arabic religious lyrics.",
            "TRANSCRIBE THE ACTUAL ARABIC SCRIPT.",
            "Write Arabic letters only for Arabic words.",
            "Do NOT transliterate Arabic into Latin letters.",
            "Do NOT write phonetic Arabic in English letters.",
            "Do NOT translate the lyrics.",
            "Do NOT summarize the lyrics.",
            "Do NOT explain anything.",
            "Preserve repeated verses.",
            "Preserve repeated words.",
            "Preserve Islamic and religious expressions.",
            "Preserve names.",
            "Preserve Quranic and Arabic phrases.",
            "Use Arabic Unicode characters whenever the singer is speaking Arabic.",
            "The output must represent what is actually sung."
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

    let segments =
        normalizeSegments(
            rawSegments
        );

    segments =
        mergeVerySmallSegments(
            segments
        );

    if (!segments.length) {
        throw new Error(
            "La IA no devolvió segmentos de transcripción válidos."
        );
    }

    const usable =
        segments.filter(
            (segment) =>
                cleanText(
                    segment.text
                )
        );

    if (!usable.length) {
        throw new Error(
            "La transcripción no contiene texto utilizable."
        );
    }

    console.log(
        "[USER NASHEED] Whisper:",
        {
            model: GROQ_STT,
            rawSegments:
                rawSegments.length,
            validSegments:
                segments.length,
            usableSegments:
                usable.length,
            arabicDetected:
                textLooksLikeArabic(
                    usable
                ),
            duration:
                result?.duration ?? null
        }
    );

    if (
        !textLooksLikeArabic(
            usable
        )
    ) {
        console.warn(
            "[USER NASHEED] Whisper devolvió principalmente transliteración latina o no produjo suficiente árabe."
        );
    }

    return usable;
}

/* =========================================================
   RECONSTRUIR ÁRABE SI WHISPER TRANSCRIBE EN LATÍN
   ========================================================= */

async function reconstructArabicFromLatin(
    segments,
    apiKey
) {
    const normalized =
        normalizeSegments(
            segments
        );

    if (!normalized.length) {
        throw new Error(
            "No hay segmentos para reconstruir."
        );
    }

    const model =
        await getAvailableChatModel(
            apiKey
        );

    /*
     * Mandamos los segmentos uno por uno con ID.
     *
     * Esto es importante porque queremos mantener
     * exactamente los timestamps de Whisper.
     */
    const input = normalized
        .map(
            (segment, index) =>
                `${index + 1}|${cleanText(segment.text)}`
        )
        .join("\n");

    const systemPrompt = `
You are an expert Arabic linguist specializing in Arabic nasheeds and Islamic vocal lyrics.

Your task is NOT translation.

The input may be Arabic words written incorrectly using Latin letters because speech recognition produced transliteration.

Convert each Latin transliteration into the most likely ORIGINAL ARABIC SCRIPT.

STRICT RULES:

1. Output Arabic script, NOT Latin transliteration.
2. Do NOT translate.
3. Do NOT explain.
4. Do NOT summarize.
5. Do NOT invent new verses.
6. Preserve repeated phrases.
7. Preserve religious expressions.
8. Preserve proper names when possible.
9. Keep exactly the same number of lines.
10. Keep the exact numeric IDs.
11. Each output line must use:
NUMBER|ARABIC TEXT
12. Do not output markdown.
13. Do not output code fences.
14. Do not add introductions.
15. Do not omit a line.
16. If a phrase is uncertain, choose the most linguistically plausible Arabic spelling based on the surrounding nasheed context.
17. NEVER output the Latin transliteration as the final answer.
18. The final text after | must contain Arabic Unicode characters.

Example:

INPUT:
1|alhamdu lillahi rabbil alamin
2|allahumma salli ala muhammad

OUTPUT:
1|الحمد لله رب العالمين
2|اللهم صل على محمد
`.trim();

    const body = {
        model,
        temperature: 0,
        max_completion_tokens:
            Math.min(
                12000,
                Math.max(
                    2000,
                    normalized.length * 80
                )
            ),
        messages: [
            {
                role: "system",
                content:
                    systemPrompt
            },
            {
                role: "user",
                content: input
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
                    JSON.stringify(body)
            },
            apiKey
        );

    const rawContent =
        cleanModelText(
            result
                ?.choices?.[0]
                ?.message
                ?.content || ""
        );

    if (!rawContent) {
        throw new Error(
            "El modelo de reconstrucción árabe no devolvió texto."
        );
    }

    const map =
        new Map();

    const lines =
        rawContent
            .split(/\r?\n/)
            .map(
                (line) =>
                    line.trim()
            )
            .filter(Boolean);

    for (const line of lines) {
        const match =
            line.match(
                /^(\d+)\s*\|\s*(.+)$/
            );

        if (!match) {
            continue;
        }

        const index =
            Number(match[1]) - 1;

        let text =
            cleanModelText(
                match[2]
            );

        /*
         * El modelo debe devolver árabe.
         * Si no contiene árabe, NO lo aceptamos.
         */
        if (
            !text ||
            !hasArabic(text)
        ) {
            continue;
        }

        /*
         * Elimina accidentalmente numeraciones
         * repetidas dentro del texto.
         */
        text =
            text.replace(
                /^\d+\s*[\.\):\-]\s*/,
                ""
            ).trim();

        map.set(
            index,
            text
        );
    }

    /*
     * Reconstruimos SOLO si el modelo ha proporcionado
     * árabe válido.
     */
    const reconstructed =
        normalized.map(
            (segment, index) => ({
                start:
                    segment.start,
                end:
                    segment.end,
                text:
                    map.get(index) ||
                    ""
            })
        );

    const valid =
        reconstructed.filter(
            (segment) =>
                segment.text &&
                hasArabic(
                    segment.text
                )
        );

    console.log(
        "[USER NASHEED] Reconstrucción árabe:",
        {
            model,
            original:
                normalized.length,
            reconstructed:
                valid.length
        }
    );

    /*
     * No permitimos una reconstrucción parcial.
     *
     * Si faltan demasiados segmentos,
     * es mejor fallar que generar subtítulos
     * inventados o mezclados.
     */
    const coverage =
        valid.length /
        normalized.length;

    if (
        coverage < 0.70
    ) {
        throw new Error(
            "El modelo de reconstrucción no pudo convertir suficientemente la transliteración a árabe."
        );
    }

    /*
     * Para los pocos segmentos que falten,
     * conservamos el original SOLO si contiene árabe.
     *
     * Nunca guardamos transliteración latina como árabe.
     */
    const finalSegments =
        reconstructed.map(
            (segment, index) => {
                if (
                    segment.text &&
                    hasArabic(
                        segment.text
                    )
                ) {
                    return segment;
                }

                const original =
                    normalized[index];

                if (
                    original &&
                    hasArabic(
                        original.text
                    )
                ) {
                    return {
                        start:
                            original.start,
                        end:
                            original.end,
                        text:
                            original.text
                    };
                }

                return null;
            }
        ).filter(Boolean);

    if (
        !finalSegments.length ||
        !textLooksLikeArabic(
            finalSegments
        )
    ) {
        throw new Error(
            "La reconstrucción árabe no produjo una transcripción suficientemente fiable."
        );
    }

    return finalSegments;
}

/* =========================================================
   OBTENER ÁRABE DEFINITIVO
   ========================================================= */

async function getReliableArabicTranscript(
    audioUrl,
    apiKey
) {
    const firstPass =
        await transcribeArabic(
            audioUrl,
            apiKey
        );

    /*
     * CASO IDEAL:
     * Whisper ya devolvió árabe.
     */
    if (
        textLooksLikeArabic(
            firstPass
        )
    ) {
        console.log(
            "[USER NASHEED] Whisper produjo árabe directamente. No se necesita reconstrucción."
        );

        return firstPass;
    }

    /*
     * CASO PROBLEMÁTICO:
     * Whisper produjo transliteración.
     *
     * Aquí intentamos convertirla a escritura árabe.
     */
    console.warn(
        "[USER NASHEED] Iniciando segunda pasada para convertir transliteración a árabe..."
    );

    const reconstructed =
        await reconstructArabicFromLatin(
            firstPass,
            apiKey
        );

    if (
        !textLooksLikeArabic(
            reconstructed
        )
    ) {
        throw new Error(
            "Whisper devolvió principalmente transliteración latina y el modelo de reconstrucción no pudo convertirla a texto árabe."
        );
    }

    return reconstructed;
}

/* =========================================================
   TRADUCCIÓN BATCH
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

    const normalized =
        normalizeSegments(
            segments
        );

    if (!normalized.length) {
        throw new Error(
            "No hay segmentos para traducir."
        );
    }

    /*
     * IMPORTANTE:
     * La traducción recibe el árabe definitivo.
     */
    const inputLines =
        normalized.map(
            (segment, index) =>
                `${index + 1}|${cleanText(segment.text)}`
        );

    const model =
        await getAvailableChatModel(
            apiKey
        );

    const systemPrompt = `
You are a professional translator of Arabic nasheed lyrics.

Translate Arabic lyrics into ${targetLanguage}.

This is a translation task, NOT transliteration.

STRICT RULES:

1. Translate the MEANING.
2. NEVER transliterate Arabic pronunciation into Latin letters.
3. NEVER reproduce Arabic words using Latin spelling unless a proper name absolutely requires it.
4. Preserve religious meaning.
5. Preserve repeated phrases.
6. Do not summarize.
7. Do not explain.
8. Do not add commentary.
9. Keep exactly the same number of lines.
10. Keep exactly the same numeric IDs.
11. Output ONLY:
NUMBER|TRANSLATION
12. Do not use markdown.
13. Do not use code blocks.
14. Do not omit lines.
15. Do not change the order.
`.trim();

    const requestBody = {
        model,
        temperature: 0,
        max_completion_tokens:
            Math.min(
                12000,
                Math.max(
                    2000,
                    normalized.length * 80
                )
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

            /*
             * Si el modelo no existe/no está permitido,
             * limpiamos la caché para volver a consultar
             * /models en el siguiente intento.
             */
            if (
                error.status === 400 ||
                error.status === 401 ||
                error.status === 403 ||
                error.status === 404
            ) {
                cachedChatModel = null;
                cachedChatModelAt = 0;
            }

            if (
                attempt < 3
            ) {
                await sleep(
                    1500 * attempt
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
        cleanModelText(
            result
                ?.choices?.[0]
                ?.message
                ?.content || ""
        );

    if (!rawContent) {
        throw new Error(
            `El modelo no devolvió la traducción a ${targetLanguage}.`
        );
    }

    const cleanLines =
        rawContent
            .split(/\r?\n/)
            .map(
                (line) =>
                    line.trim()
            )
            .filter(Boolean);

    const translatedMap =
        new Map();

    for (const line of cleanLines) {
        /*
         * Formato principal:
         * 1|Translation
         */
        let match =
            line.match(
                /^(\d+)\s*\|\s*(.+)$/
            );

        /*
         * Compatibilidad con:
         * 1. Translation
         * 1) Translation
         * 1** Translation
         */
        if (!match) {
            match =
                line.match(
                    /^(\d+)\s*(?:\*\*|\*|\.|\)|:|-)\s*(.+)$/
                );
        }

        if (!match) {
            continue;
        }

        const index =
            parseInt(
                match[1],
                10
            ) - 1;

        let text =
            cleanModelText(
                match[2]
            );

        text =
            text.replace(
                /^\s*[\|\-:]\s*/,
                ""
            );

        text =
            cleanText(text);

        if (
            index >= 0 &&
            index < normalized.length &&
            text
        ) {
            translatedMap.set(
                index,
                text
            );
        }
    }

    /*
     * Si el modelo no ha respetado el formato,
     * intentamos una segunda lectura muy conservadora.
     */
    if (
        translatedMap.size <
        Math.ceil(
            normalized.length * 0.70
        )
    ) {
        const fallbackLines =
            cleanLines.filter(
                (line) =>
                    !/^```/.test(
                        line
                    )
            );

        for (
            let i = 0;
            i < fallbackLines.length &&
            i < normalized.length;
            i++
        ) {
            if (
                translatedMap.has(i)
            ) {
                continue;
            }

            const candidate =
                fallbackLines[i]
                    .replace(
                        /^\d+\s*[\.\)\:\|\-]\s*/,
                        ""
                    )
                    .trim();

            if (candidate) {
                translatedMap.set(
                    i,
                    cleanText(
                        candidate
                    )
                );
            }
        }
    }

    /*
     * MUY IMPORTANTE:
     *
     * Si una traducción falta, NO ponemos el árabe
     * dentro del VTT de traducción.
     *
     * Eso provocaba mezclas y subtítulos
     * aparentemente "desconfigurados".
     */
    const translated =
        normalized.map(
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

    const validTranslated =
        translated.filter(
            (segment) =>
                segment.text
        );

    if (
        validTranslated.length <
        Math.ceil(
            normalized.length * 0.70
        )
    ) {
        throw new Error(
            `La traducción a ${targetLanguage} devolvió demasiados segmentos incompletos.`
        );
    }

    /*
     * Para que nunca haya huecos:
     * si falta una línea concreta, intentamos mantener
     * el índice y reutilizar una cadena vacía no sirve.
     *
     * En este punto hacemos una segunda petición solo
     * si faltan líneas.
     */
    if (
        validTranslated.length !==
        normalized.length
    ) {
        console.warn(
            `[TRANSLATION] ${language}: faltan ${normalized.length - validTranslated.length} segmentos. Se hará una segunda pasada de reparación.`
        );

        const missing =
            normalized
                .map(
                    (segment, index) => ({
                        segment,
                        index
                    })
                )
                .filter(
                    (item) =>
                        !translatedMap.has(
                            item.index
                        )
                );

        if (missing.length) {
            const repairInput =
                missing
                    .map(
                        (item) =>
                            `${item.index + 1}|${item.segment.text}`
                    )
                    .join("\n");

            const repairBody = {
                model,
                temperature: 0,
                max_completion_tokens:
                    Math.max(
                        500,
                        missing.length * 80
                    ),
                messages: [
                    {
                        role: "system",
                        content: `
Translate these Arabic nasheed lines into ${targetLanguage}.

Output ONLY:
NUMBER|TRANSLATION

Do not transliterate.
Do not explain.
Do not omit any number.
Do not use markdown.
                        `.trim()
                    },
                    {
                        role: "user",
                        content:
                            repairInput
                    }
                ]
            };

            try {
                const repaired =
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
                                    repairBody
                                )
                        },
                        apiKey,
                        3
                    );

                const repairText =
                    cleanModelText(
                        repaired
                            ?.choices?.[0]
                            ?.message
                            ?.content || ""
                    );

                for (
                    const line of
                    repairText.split(
                        /\r?\n/
                    )
                ) {
                    const match =
                        line
                            .trim()
                            .match(
                                /^(\d+)\s*\|\s*(.+)$/
                            );

                    if (!match) {
                        continue;
                    }

                    const index =
                        Number(
                            match[1]
                        ) - 1;

                    const text =
                        cleanText(
                            match[2]
                        );

                    if (
                        index >= 0 &&
                        index <
                            normalized.length &&
                        text
                    ) {
                        translatedMap.set(
                            index,
                            text
                        );
                    }
                }
            } catch (repairError) {
                console.warn(
                    "[TRANSLATION REPAIR] No se pudo reparar la traducción:",
                    repairError.message
                );
            }
        }
    }

    return normalized.map(
        (segment, index) => ({
            start:
                segment.start,
            end:
                segment.end,
            text:
                translatedMap.get(
                    index
                ) || "[...]"
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

        warning: false,

        private: true,

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
                /*
                 * 1. Comprobamos cancelación.
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
                 * 2. Cargamos la fila.
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

                /*
                 * 3. URL temporal del audio.
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
                 * 4. TRANSCRIPCIÓN ÁRABE FIABLE.
                 *
                 * Primero Whisper.
                 * Si devuelve transliteración,
                 * segunda pasada para reconstruir árabe.
                 */
                const arabic =
                    await getReliableArabicTranscript(
                        signedAudio
                            .data
                            .signedUrl,
                        groqApiKey
                    );

                if (
                    !arabic.length ||
                    !textLooksLikeArabic(
                        arabic
                    )
                ) {
                    throw new Error(
                        "No se obtuvo una transcripción árabe fiable."
                    );
                }

                console.log(
                    "[USER NASHEED] Segmentos árabes definitivos:",
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
                 * 5. Prefix del almacenamiento.
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

                const arabicPath =
                    `${prefix}/subtitles/ar.vtt`;

                const arabicVtt =
                    makeVTT(
                        arabic
                    );

                /*
                 * UTF-8 explícito.
                 */
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
                 * Si no se solicitó ninguna traducción,
                 * saltamos directamente al 95%.
                 */
                if (
                    totalLangs === 0
                ) {
                    console.log(
                        "[USER NASHEED] No se solicitaron traducciones."
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

                    /*
                     * Traducción SIEMPRE desde el árabe.
                     * Nunca desde la transliteración.
                     */
                    const translated =
                        await translateAllBatch(
                            arabic,
                            language,
                            groqApiKey
                        );

                    /*
                     * El VTT de traducción conserva
                     * exactamente los timestamps del árabe.
                     */
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
                 * Volvemos a dejar ready después del 100%.
                 */
                await supabase
                    .from(
                        "user_nasheeds"
                    )
                    .update({
                        status:
                            "ready"
                    })
                    .eq(
                        "id",
                        id
                    )
                    .eq(
                        "user_id",
                        currentUser.id
                    );

                console.log(
                    "[USER NASHEED] PROCESAMIENTO COMPLETADO:",
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