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
const GROQ_TRANSLATION = "llama-3.3-70b-versatile";

/*
 * Número máximo de segmentos enviados al modelo de traducción
 * en una sola petición.
 *
 * Esto evita que un nasheed largo provoque respuestas incompletas.
 */
const TRANSLATION_BATCH_SIZE = 35;

/*
 * Mínimo de caracteres árabes que exigimos para considerar
 * que un texto realmente está escrito en árabe.
 */
const MIN_ARABIC_CHARS = 2;


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
        } =
            await supabase.auth.getUser(token);

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
                    item => LANGS.has(item)
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
 * Normaliza espacios pero NO elimina:
 *
 * - harakat
 * - tashkeel
 * - letras árabes
 * - signos de puntuación árabes
 *
 * Esto es importante para los nasheeds.
 */
function cleanArabicText(value) {
    return String(value || "")
        .replace(/\r|\n+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}


/* =========================================================
   DETECCIÓN DE ÁRABE
   ========================================================= */

/*
 * Unicode árabe:
 *
 * \u0600-\u06FF
 * \u0750-\u077F
 * \u08A0-\u08FF
 * \uFB50-\uFDFF
 * \uFE70-\uFEFF
 */
function countArabicCharacters(text) {
    const value = String(text || "");

    const matches =
        value.match(
            /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g
        );

    return matches
        ? matches.length
        : 0;
}

function hasArabic(text) {
    return (
        countArabicCharacters(text) >=
        MIN_ARABIC_CHARS
    );
}

function arabicRatio(text) {
    const value = String(text || "").trim();

    if (!value) {
        return 0;
    }

    const arabicCount =
        countArabicCharacters(value);

    const letters =
        value.match(
            /[\p{L}]/gu
        );

    if (!letters || !letters.length) {
        return 0;
    }

    return arabicCount / letters.length;
}


/*
 * Detecta texto que parece transliteración.
 *
 * Ejemplos típicos:
 *
 * "Allahumma salli ala Muhammad"
 * "Bismillahi rahmani rahim"
 * "Ya rabbi inni..."
 *
 * Aunque Whisper haya recibido language=ar,
 * este filtro evita guardar ese resultado como ar.vtt.
 */
function looksLikeTransliteration(text) {
    const value =
        cleanText(text);

    if (!value) {
        return false;
    }

    if (hasArabic(value)) {
        return false;
    }

    const latinWords =
        value.match(
            /[A-Za-zÀ-ÿ]+/g
        ) || [];

    if (!latinWords.length) {
        return false;
    }

    const latinText =
        latinWords.join(" ");

    const commonArabicTransliteration =
        /\b(allah|allahumma|akbar|rabbi|rabb|rahman|rahim|bismillah|subhan|subhana|hamd|hamdulillah|muhammad|rasul|rasool|nabi|deen|din|iman|islam|salam|alaykum|alaikum|dua|du'a|ya|inni|anta|ana|huwa|hiya|la ilaha|illallah|lillah|lillahi|wa|fi|min|ila|ma|man|la|insha|masha|baraka|barakah|jannah|nar|nur|qalb|qulub)\b/i;

    if (
        commonArabicTransliteration.test(
            latinText
        )
    ) {
        return true;
    }

    /*
     * Si todo el contenido útil está en letras latinas
     * y parece una frase hablada/cantada, lo tratamos
     * como posible transliteración.
     */
    const latinLetters =
        (
            value.match(
                /[A-Za-z]/g
            ) || []
        ).length;

    const totalLetters =
        (
            value.match(
                /[\p{L}]/gu
            ) || []
        ).length;

    if (
        totalLetters > 0 &&
        latinLetters / totalLetters > 0.85
    ) {
        return true;
    }

    return false;
}


/* =========================================================
   VALIDACIÓN DE SEGMENTOS
   ========================================================= */

function normalizeSegments(segments) {
    if (!Array.isArray(segments)) {
        return [];
    }

    return segments
        .map(segment => ({
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


/*
 * Mantiene los segmentos aunque haya repeticiones.
 *
 * NO hacemos deduplicación por texto porque en un nasheed
 * una misma frase puede repetirse varias veces y cada
 * repetición necesita su propio timestamp.
 */
function validateArabicSegments(segments) {
    if (!Array.isArray(segments)) {
        return [];
    }

    return segments
        .map(segment => ({
            start: Number(segment.start),
            end: Number(segment.end),
            text: cleanArabicText(segment.text)
        }))
        .filter(segment => {
            if (!segment.text) {
                return false;
            }

            if (
                !Number.isFinite(segment.start) ||
                !Number.isFinite(segment.end)
            ) {
                return false;
            }

            if (segment.end <= segment.start) {
                return false;
            }

            return hasArabic(segment.text);
        });
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


/* =========================================================
   CREAR VTT
   ========================================================= */

function makeVTT(segments) {
    const validSegments =
        normalizeSegments(
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

        const next =
            validSegments[i + 1] ||
            null;

        const start =
            segment.start;

        let end =
            segment.end;

        /*
         * Evitamos solapamientos.
         */
        if (
            next &&
            end > next.start
        ) {
            end =
                next.start;
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
    for (
        let attempt = 1;
        attempt <= maxRetries;
        attempt++
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

        if (
            response.status === 429 &&
            attempt < maxRetries
        ) {
            const retryAfter =
                response.headers.get(
                    "retry-after"
                );

            let waitTime =
                attempt * 2000;

            if (retryAfter) {
                const retrySeconds =
                    Number(
                        retryAfter
                    );

                if (
                    Number.isFinite(
                        retrySeconds
                    )
                ) {
                    waitTime =
                        Math.max(
                            waitTime,
                            retrySeconds * 1000
                        );
                }
            }

            console.warn(
                `[GROQ RATE LIMIT 429] Reintentando (${attempt}/${maxRetries}) en ${waitTime / 1000}s...`
            );

            await sleep(
                waitTime
            );

            continue;
        }

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
                    message:
                        raw
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
     * Le indicamos explícitamente árabe.
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
            "The audio contains Arabic nasheed lyrics.",
            "The lyrics are sung in Arabic.",
            "TRANSCRIBE THE LYRICS IN ARABIC SCRIPT ONLY.",
            "Use Arabic Unicode letters.",
            "Do NOT use Latin letters to represent Arabic pronunciation.",
            "Do NOT transliterate Arabic into Latin alphabet.",
            "Do NOT translate the lyrics.",
            "Do NOT summarize the lyrics.",
            "Do NOT rewrite the lyrics into another language.",
            "Preserve repeated verses and repeated phrases.",
            "Preserve religious expressions and proper names.",
            "Keep the original spoken or sung wording as accurately as possible.",
            "If a word is unclear, use the most plausible Arabic spelling rather than Latin transliteration.",
            "The final transcription must be Arabic script."
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

    const normalized =
        normalizeSegments(
            rawSegments
        );

    if (!normalized.length) {
        throw new Error(
            "La IA no devolvió segmentos de transcripción válidos."
        );
    }

    console.log(
        "[USER NASHEED] Whisper resultado:",
        {
            rawSegments:
                rawSegments.length,
            normalizedSegments:
                normalized.length,
            duration:
                result?.duration ??
                null
        }
    );

    /*
     * Comprobamos si Whisper realmente produjo árabe.
     */
    const arabicSegments =
        validateArabicSegments(
            normalized
        );

    const transliteratedSegments =
        normalized.filter(
            segment =>
                looksLikeTransliteration(
                    segment.text
                )
        );

    const arabicCount =
        arabicSegments.length;

    const total =
        normalized.length;

    const arabicPercentage =
        total > 0
            ? arabicCount / total
            : 0;

    console.log(
        "[USER NASHEED] Validación árabe:",
        {
            total,
            arabicSegments: arabicCount,
            transliteratedSegments:
                transliteratedSegments.length,
            arabicPercentage
        }
    );

    /*
     * Si casi todo es transliteración, NO lo guardamos.
     *
     * Si existe algo de árabe y algunos segmentos están
     * transliterados, también los mandamos a la etapa
     * de corrección.
     */
    if (
        arabicPercentage < 0.75 ||
        transliteratedSegments.length > 0
    ) {
        console.warn(
            "[USER NASHEED] Whisper produjo transliteración o texto no árabe. Se requiere corrección."
        );

        return {
            segments: normalized,
            needsArabicRepair: true
        };
    }

    /*
     * Aunque tenga 75% o más árabe, exigimos que todos
     * los segmentos finales sean árabes.
     */
    if (
        arabicSegments.length !==
        normalized.length
    ) {
        return {
            segments: normalized,
            needsArabicRepair: true
        };
    }

    return {
        segments: arabicSegments,
        needsArabicRepair: false
    };
}


/* =========================================================
   REPARAR TRANSCRIPCIÓN ÁRABE
   ========================================================= */

async function repairArabicTranscription(
    segments,
    apiKey
) {
    if (!Array.isArray(segments) || !segments.length) {
        throw new Error(
            "No hay segmentos para reparar."
        );
    }

    /*
     * Dividimos la reparación en bloques para evitar
     * respuestas demasiado largas.
     */
    const repaired = [];

    for (
        let offset = 0;
        offset < segments.length;
        offset += TRANSLATION_BATCH_SIZE
    ) {
        const batch =
            segments.slice(
                offset,
                offset +
                    TRANSLATION_BATCH_SIZE
            );

        const input =
            batch
                .map(
                    (segment, index) =>
                        `${index + 1}. ${cleanText(segment.text)}`
                )
                .join("\n");

        const systemPrompt = [
            "You are an expert Arabic linguist specializing in Arabic nasheed lyrics.",
            "The input is an automatic speech transcription of Arabic singing.",
            "Some lines may be transliterated into Latin characters.",
            "",
            "Your task is to reconstruct the lyrics in REAL ARABIC SCRIPT.",
            "",
            "STRICT RULES:",
            "1. Output Arabic Unicode script.",
            "2. NEVER output Arabic transliteration in Latin letters.",
            "3. NEVER translate the lyrics.",
            "4. NEVER explain your corrections.",
            "5. NEVER summarize.",
            "6. Preserve the original meaning and wording.",
            "7. Preserve religious expressions and names.",
            "8. Preserve repeated phrases.",
            "9. Keep exactly the same numbered lines.",
            "10. If the input is already Arabic, keep it as Arabic and correct only obvious transcription mistakes.",
            "11. Do not invent extra verses.",
            "12. Output ONLY the numbered lines."
        ].join("\n");

        const requestBody = {
            model:
                GROQ_TRANSLATION,
            temperature:
                0,
            max_completion_tokens:
                4000,
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

                break;
            } catch (error) {
                console.error(
                    `[ARABIC REPAIR] Bloque ${offset}-${offset + batch.length - 1}, intento ${attempt}:`,
                    error.message
                );

                if (
                    attempt < 3
                ) {
                    await sleep(
                        1500 *
                        attempt
                    );
                } else {
                    throw error;
                }
            }
        }

        const content =
            result?.choices?.[0]?.message?.content ||
            "";

        const parsed =
            parseNumberedLines(
                content,
                batch.length
            );

        /*
         * Si Groq no devolvió todas las líneas, NO
         * inventamos segmentos.
         *
         * Para líneas no reparadas conservamos el texto
         * original solamente si ya era árabe.
         */
        for (
            let i = 0;
            i < batch.length;
            i++
        ) {
            const original =
                batch[i];

            const repairedText =
                parsed.get(i);

            if (
                repairedText &&
                hasArabic(
                    repairedText
                )
            ) {
                repaired.push({
                    start:
                        original.start,
                    end:
                        original.end,
                    text:
                        cleanArabicText(
                            repairedText
                        )
                });
            } else if (
                hasArabic(
                    original.text
                )
            ) {
                repaired.push({
                    start:
                        original.start,
                    end:
                        original.end,
                    text:
                        cleanArabicText(
                            original.text
                        )
                });
            } else {
                /*
                 * Marcamos como faltante para intentar una
                 * reparación individual más adelante.
                 */
                repaired.push({
                    start:
                        original.start,
                    end:
                        original.end,
                    text:
                        ""
                });
            }
        }
    }

    /*
     * Segunda pasada para segmentos que todavía no son árabes.
     */
    const missing =
        repaired.filter(
            segment =>
                !hasArabic(
                    segment.text
                )
        );

    if (missing.length) {
        console.warn(
            `[ARABIC REPAIR] ${missing.length} segmentos siguen sin texto árabe. Intentando reparación individual.`
        );

        for (
            const segment of missing
        ) {
            const original =
                segments.find(
                    item =>
                        item.start ===
                            segment.start &&
                        item.end ===
                            segment.end
                );

            if (!original) {
                continue;
            }

            const requestBody = {
                model:
                    GROQ_TRANSLATION,
                temperature:
                    0,
                max_completion_tokens:
                    300,
                messages: [
                    {
                        role:
                            "system",
                        content:
                            [
                                "Convert this Arabic nasheed transcription into correct Arabic script.",
                                "Output ONLY the Arabic text.",
                                "Never transliterate.",
                                "Never translate.",
                                "Never use Latin letters for Arabic pronunciation."
                            ].join(" ")
                    },
                    {
                        role:
                            "user",
                        content:
                            cleanText(
                                original.text
                            )
                    }
                ]
            };

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

                const fixed =
                    cleanArabicText(
                        result?.choices?.[0]?.message?.content ||
                        ""
                    );

                if (
                    hasArabic(fixed)
                ) {
                    segment.text =
                        fixed
                            .replace(
                                /^\d+[.)\-:]\s*/,
                                ""
                            )
                            .trim();
                }
            } catch (error) {
                console.warn(
                    "[ARABIC REPAIR] Fallo en reparación individual:",
                    error.message
                );
            }
        }
    }

    /*
     * Validación FINAL.
     */
    const finalSegments =
        repaired.filter(
            segment =>
                hasArabic(
                    segment.text
                ) &&
                Number.isFinite(
                    segment.start
                ) &&
                Number.isFinite(
                    segment.end
                ) &&
                segment.end >
                    segment.start
        );

    if (!finalSegments.length) {
        throw new Error(
            "No se pudo obtener una transcripción escrita en árabe."
        );
    }

    const finalArabicCount =
        finalSegments.filter(
            segment =>
                hasArabic(
                    segment.text
                )
        ).length;

    if (
        finalArabicCount !==
        finalSegments.length
    ) {
        throw new Error(
            "La transcripción reparada todavía contiene segmentos que no están escritos en árabe."
        );
    }

    console.log(
        "[USER NASHEED] Transcripción árabe reparada:",
        {
            original:
                segments.length,
            final:
                finalSegments.length,
            removed:
                segments.length -
                finalSegments.length
        }
    );

    return finalSegments;
}


/* =========================================================
   PARSER DE RESPUESTAS NUMERADAS
   ========================================================= */

function parseNumberedLines(
    rawContent,
    expectedCount
) {
    const map =
        new Map();

    const lines =
        String(
            rawContent || ""
        )
            .split(/\r?\n/)
            .map(
                line =>
                    line.trim()
            )
            .filter(
                Boolean
            );

    for (
        const line of lines
    ) {
        /*
         * Acepta:
         *
         * 1. texto
         * 1) texto
         * 1 - texto
         * 1: texto
         * **1.** texto
         */
        const match =
            line.match(
                /^(?:\*\*)?\s*(\d+)\s*(?:[.)\-:]|\*\*[.)\-:]?)\s*(?:\*\*)?\s*(.+?)\s*$/
            );

        if (!match) {
            continue;
        }

        const index =
            parseInt(
                match[1],
                10
            ) - 1;

        let text =
            String(
                match[2] || ""
            )
                .replace(
                    /\*\*/g,
                    ""
                )
                .trim();

        text =
            cleanText(
                text
            );

        if (
            index >= 0 &&
            index < expectedCount &&
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

    if (
        !Array.isArray(
            segments
        ) ||
        !segments.length
    ) {
        throw new Error(
            "No hay segmentos para traducir."
        );
    }

    const finalTranslations =
        new Array(
            segments.length
        );

    /*
     * Procesamos el nasheed por bloques.
     */
    for (
        let offset = 0;
        offset < segments.length;
        offset += TRANSLATION_BATCH_SIZE
    ) {
        const batch =
            segments.slice(
                offset,
                offset +
                    TRANSLATION_BATCH_SIZE
            );

        const inputLines =
            batch.map(
                (segment, idx) =>
                    `${idx + 1}. ${cleanArabicText(segment.text)}`
            );

        const systemPrompt =
            [
                "You are a professional translator.",
                "The source text is Arabic nasheed lyrics.",
                `Translate the Arabic lyrics into ${targetLanguage}.`,
                "",
                "STRICT RULES:",
                "1. Translate the MEANING of the Arabic.",
                "2. Do NOT transliterate Arabic.",
                "3. Do NOT reproduce Arabic pronunciation using Latin letters.",
                "4. Do NOT return the Arabic original.",
                `5. Every output line must be written in ${targetLanguage}.`,
                "6. Preserve the exact number of numbered lines.",
                "7. Preserve the order.",
                "8. Keep repeated verses and repeated phrases.",
                "9. Do not merge lines.",
                "10. Do not split lines.",
                "11. Do not add explanations.",
                "12. Do not add introductions.",
                "13. Do not use markdown code blocks.",
                "14. Output ONLY the numbered translations.",
                "15. If an Arabic religious expression has a natural meaning in the target language, translate its meaning naturally."
            ].join("\n");

        const requestBody = {
            model:
                GROQ_TRANSLATION,
            temperature:
                0.1,
            max_completion_tokens:
                4000,
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
                        inputLines.join(
                            "\n"
                        )
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

                break;
            } catch (error) {
                console.error(
                    `[TRANSLATION BATCH ERROR] ${language} bloque ${offset}-${offset + batch.length - 1}, intento ${attempt}:`,
                    error.message
                );

                if (
                    attempt < 3
                ) {
                    await sleep(
                        2000 *
                        attempt
                    );
                } else {
                    throw error;
                }
            }
        }

        const rawContent =
            result?.choices?.[0]?.message?.content ||
            "";

        const translatedMap =
            parseNumberedLines(
                rawContent,
                batch.length
            );

        /*
         * IMPORTANTE:
         *
         * NO usamos el árabe original como fallback.
         *
         * Si falta una traducción, intentamos recuperar
         * solamente esa línea.
         */
        for (
            let i = 0;
            i < batch.length;
            i++
        ) {
            const translated =
                translatedMap.get(i);

            if (
                translated &&
                !hasArabic(
                    translated
                )
            ) {
                finalTranslations[
                    offset + i
                ] =
                    translated;
            }
        }

        /*
         * Recuperar traducciones que Groq no devolvió.
         */
        for (
            let i = 0;
            i < batch.length;
            i++
        ) {
            const globalIndex =
                offset + i;

            if (
                finalTranslations[
                    globalIndex
                ]
            ) {
                continue;
            }

            const source =
                batch[i];

            try {
                const individualBody = {
                    model:
                        GROQ_TRANSLATION,
                    temperature:
                        0.1,
                    max_completion_tokens:
                        300,
                    messages: [
                        {
                            role:
                                "system",
                            content:
                                [
                                    "Translate the following Arabic nasheed lyric into " +
                                        targetLanguage +
                                        ".",
                                    "Return ONLY the translation.",
                                    "Do not transliterate.",
                                    "Do not return Arabic.",
                                    "Do not explain."
                                ].join(
                                    " "
                                )
                        },
                        {
                            role:
                                "user",
                            content:
                                cleanArabicText(
                                    source.text
                                )
                        }
                    ]
                };

                const individual =
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
                                    individualBody
                                )
                        },
                        apiKey
                    );

                const text =
                    cleanText(
                        individual?.choices?.[0]?.message?.content ||
                        ""
                    )
                        .replace(
                            /^["'`]+|["'`]+$/g,
                            ""
                        )
                        .trim();

                if (
                    text &&
                    !hasArabic(text)
                ) {
                    finalTranslations[
                        globalIndex
                    ] =
                        text;
                }
            } catch (error) {
                console.warn(
                    `[TRANSLATION RECOVERY] ${language} segmento ${globalIndex + 1}:`,
                    error.message
                );
            }
        }
    }

    /*
     * Si una traducción sigue faltando, NO ponemos el
     * árabe original.
     *
     * Usamos un texto neutro para evitar que un VTT
     * de español/inglés/ruso contenga transliteración.
     *
     * Normalmente no debería ocurrir gracias a la recuperación
     * individual anterior.
     */
    const resultSegments =
        segments.map(
            (segment, idx) => ({
                start:
                    segment.start,
                end:
                    segment.end,
                text:
                    finalTranslations[idx] ||
                    ""
            })
        );

    const missing =
        resultSegments.filter(
            segment =>
                !segment.text
        ).length;

    if (missing > 0) {
        throw new Error(
            `La traducción a ${targetLanguage} no pudo completarse: faltan ${missing} segmentos.`
        );
    }

    /*
     * Verificación de que la traducción no sea simplemente
     * una copia árabe/transliteración.
     */
    const invalid =
        resultSegments.filter(
            segment =>
                hasArabic(
                    segment.text
                ) ||
                looksLikeTransliteration(
                    segment.text
                )
        );

    if (invalid.length > 0) {
        throw new Error(
            `La traducción a ${targetLanguage} contiene ${invalid.length} segmentos que parecen árabe o transliteración.`
        );
    }

    console.log(
        `[USER NASHEED] Traducción ${language} completada:`,
        {
            segments:
                resultSegments.length
        }
    );

    return resultSegments;
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
                            .select(
                                "id"
                            )
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

                if (audioSigned.error) {
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
                 * PRIMERA ETAPA:
                 * Whisper.
                 */
                const transcription =
                    await transcribeArabic(
                        signedAudio
                            .data
                            .signedUrl,
                        groqApiKey
                    );

                let arabic =
                    transcription.segments;

                /*
                 * SEGUNDA ETAPA:
                 * Si Whisper produjo transliteración,
                 * la corregimos.
                 */
                if (
                    transcription.needsArabicRepair
                ) {
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
                        "[USER NASHEED] Corrigiendo transcripción para obtener árabe real..."
                    );

                    arabic =
                        await repairArabicTranscription(
                            transcription.segments,
                            groqApiKey
                        );
                }

                /*
                 * VALIDACIÓN FINAL DEL ÁRABE
                 */
                arabic =
                    validateArabicSegments(
                        arabic
                    );

                if (!arabic.length) {
                    throw new Error(
                        "No se pudo obtener una transcripción válida en árabe."
                    );
                }

                const invalidArabic =
                    arabic.filter(
                        segment =>
                            !hasArabic(
                                segment.text
                            )
                    );

                if (
                    invalidArabic.length
                ) {
                    throw new Error(
                        "La transcripción final contiene texto que no está escrito en árabe."
                    );
                }

                console.log(
                    "[USER NASHEED] Segmentos árabes finales:",
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
                    totalLangs > 0
                ) {
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

                        /*
                         * Comprobamos que haya exactamente
                         * el mismo número de segmentos.
                         */
                        if (
                            translated.length !==
                            arabic.length
                        ) {
                            throw new Error(
                                `La traducción ${language} no contiene todos los segmentos.`
                            );
                        }

                        /*
                         * Los timestamps deben seguir siendo
                         * exactamente los de la transcripción.
                         */
                        for (
                            let j = 0;
                            j < arabic.length;
                            j++
                        ) {
                            translated[j].start =
                                arabic[j].start;

                            translated[j].end =
                                arabic[j].end;

                            if (
                                !translated[j].text
                            ) {
                                throw new Error(
                                    `Falta la traducción ${language} del segmento ${j + 1}.`
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