"use strict";

const crypto = require("crypto");

/* =========================================================
   CONFIGURACIÓN
   ========================================================= */

const BUCKET = "UserNasheeds";

const MAX_AUDIO = 25 * 1024 * 1024;
const MAX_COVER = 5 * 1024 * 1024;

/*
 * Whisper Large V3 es más preciso que Turbo.
 * Groq lo mantiene disponible para STT.
 */
const GROQ_STT = "whisper-large-v3";

/*
 * Modelo actual de Groq para reconstrucción/traducción.
 * NO usar llama-3.3-70b-versatile ni llama-3.1-8b-instant
 * en esta configuración.
 */
const GROQ_TEXT = "openai/gpt-oss-20b";

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
 * Límite interno para reconstrucción.
 * Se procesa en bloques para que el modelo tenga contexto
 * sin meter una canción entera en una sola petición.
 */
const RECONSTRUCT_BATCH_SIZE = 8;

/*
 * Máximo de intentos para llamadas Groq.
 */
const GROQ_RETRIES = 5;

/*
 * Cuando dos subtítulos están separados por un pequeño hueco,
 * podemos rellenarlo ligeramente para evitar parpadeos.
 *
 * NO usamos 15 segundos porque eso desconfigura el karaoke.
 */
const MAX_VTT_GAP_FILL = 1.5;


/* =========================================================
   UTILIDADES
   ========================================================= */

const sleep = ms =>
    new Promise(resolve => setTimeout(resolve, ms));


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
   AUTENTICACIÓN
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
                .map(item =>
                    String(item || "")
                        .trim()
                        .toLowerCase()
                )
                .filter(item =>
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


function cleanArabicText(value) {
    return String(value || "")
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
        .replace(/\r|\n+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}


/* =========================================================
   DETECCIÓN DE ÁRABE
   ========================================================= */

/*
 * Detecta caracteres del alfabeto árabe.
 *
 * Incluye:
 * - árabe
 * - harakat
 * - extensiones árabes
 * - persa/urdu si apareciesen accidentalmente
 */
function arabicCharacterCount(text) {
    const value = String(text || "");

    const matches = value.match(
        /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g
    );

    return matches
        ? matches.length
        : 0;
}


function latinCharacterCount(text) {
    const value = String(text || "");

    const matches = value.match(
        /[A-Za-zÀ-ÖØ-öø-ÿ]/g
    );

    return matches
        ? matches.length
        : 0;
}


function isArabicText(text) {
    const value = cleanText(text);

    if (!value) {
        return false;
    }

    const arabic = arabicCharacterCount(value);
    const latin = latinCharacterCount(value);

    if (arabic >= 2) {
        /*
         * Si hay suficiente árabe, aceptamos aunque haya
         * números o alguna palabra latina.
         */
        if (arabic >= latin) {
            return true;
        }

        /*
         * También aceptamos textos donde el árabe sea
         * claramente dominante.
         */
        return arabic / Math.max(
            1,
            arabic + latin
        ) >= 0.35;
    }

    return false;
}


function arabicRatio(text) {
    const value = cleanText(text);

    const arabic = arabicCharacterCount(value);
    const latin = latinCharacterCount(value);

    if (
        arabic === 0 &&
        latin === 0
    ) {
        return 0;
    }

    return arabic /
        Math.max(
            1,
            arabic + latin
        );
}


/*
 * Comprueba si una colección completa contiene
 * principalmente transliteración.
 */
function transcriptionNeedsReconstruction(segments) {
    if (!segments.length) {
        return true;
    }

    const usable = segments.filter(
        segment => cleanText(segment.text)
    );

    if (!usable.length) {
        return true;
    }

    const arabicSegments = usable.filter(
        segment => isArabicText(segment.text)
    );

    const latinSegments = usable.filter(
        segment => {
            const text = cleanText(segment.text);
            const latin = latinCharacterCount(text);
            const arabic = arabicCharacterCount(text);

            return (
                latin >= 3 &&
                latin > arabic * 2
            );
        }
    );

    /*
     * Si más de un tercio de los segmentos son claramente latinos,
     * reconstruimos.
     */
    return (
        arabicSegments.length === 0 ||
        latinSegments.length >
            Math.max(
                1,
                Math.floor(usable.length / 3)
            )
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
        .map(segment => ({
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
 * Elimina segmentos duplicados o prácticamente idénticos.
 */
function deduplicateSegments(segments) {
    const normalized =
        normalizeSegments(segments);

    const output = [];

    for (const segment of normalized) {
        const previous =
            output[output.length - 1];

        if (!previous) {
            output.push(segment);
            continue;
        }

        const sameText =
            cleanText(previous.text)
                .toLowerCase() ===
            cleanText(segment.text)
                .toLowerCase();

        const close =
            Math.abs(
                segment.start -
                previous.start
            ) < 0.15;

        if (sameText && close) {
            if (
                segment.end >
                previous.end
            ) {
                previous.end =
                    segment.end;
            }

            continue;
        }

        output.push(segment);
    }

    return output;
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
    let validSegments =
        deduplicateSegments(
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
            Math.max(
                0,
                segment.start
            );

        let end =
            Math.max(
                start + 0.05,
                segment.end
            );

        /*
         * Nunca permitimos que un subtítulo se meta
         * dentro del siguiente.
         */
        if (
            next &&
            end > next.start
        ) {
            end =
                Math.max(
                    start + 0.05,
                    next.start - 0.02
                );
        }

        /*
         * Rellenamos solo pequeños huecos.
         * Esto evita que un subtítulo desaparezca
         * durante unas décimas, pero no desconfigura
         * toda la canción.
         */
        if (
            next &&
            next.start > end
        ) {
            const gap =
                next.start - end;

            if (
                gap <=
                MAX_VTT_GAP_FILL
            ) {
                end =
                    next.start - 0.02;
            }
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
        !vtt.includes("WEBVTT")
    ) {
        throw new Error(
            "No se pudo generar el VTT."
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
    maxRetries = GROQ_RETRIES
) {
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

            if (
                response.ok
            ) {
                return body;
            }

            const message =
                body?.error?.message ||
                `Groq HTTP ${response.status}`;

            const error =
                new Error(message);

            error.status =
                response.status;

            error.retryAfter =
                response.headers.get(
                    "retry-after"
                );

            lastError = error;

            if (
                response.status === 429 &&
                attempt < maxRetries
            ) {
                const retryAfter =
                    Number(
                        error.retryAfter
                    );

                const wait =
                    Number.isFinite(
                        retryAfter
                    ) &&
                    retryAfter > 0
                        ? retryAfter * 1000
                        : attempt * 2500;

                console.warn(
                    `[GROQ 429] Reintentando en ${Math.ceil(wait / 1000)}s (${attempt}/${maxRetries})`
                );

                await sleep(wait);
                continue;
            }

            if (
                response.status >= 500 &&
                attempt < maxRetries
            ) {
                await sleep(
                    attempt * 1500
                );

                continue;
            }

            throw error;

        } catch (error) {
            lastError = error;

            if (
                error?.status === 429
            ) {
                throw error;
            }

            if (
                attempt <
                maxRetries
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
        new Error(
            "Error desconocido de Groq."
        )
    );
}


/* =========================================================
   TRANSCRIPCIÓN ÁRABE CON WHISPER
   ========================================================= */

async function whisperArabic(
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

    /*
     * El prompt está deliberadamente en árabe.
     * Groq indica que el prompt debe coincidir
     * con el idioma del audio.
     */
    form.append(
        "prompt",
        [
            "أنشودة عربية دينية.",
            "كلمات عربية فصحى.",
            "النص يجب أن يكون باللغة العربية وبالحروف العربية.",
            "اكتب الكلمات العربية كما تُنطق في الأنشودة.",
            "لا تكتب transliteration.",
            "لا تكتب الكلمات العربية بحروف لاتينية.",
            "لا تترجم النص.",
            "لا تلخص النص.",
            "حافظ على الآيات والعبارات المكررة.",
            "حافظ على أسماء الله والأسماء الدينية.",
            "مثال على الكتابة الصحيحة: الحمد لله رب العالمين.",
            "مثال آخر: يا رسول الله.",
            "الصوت قد يكون غناءً دينياً."
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

    const segments =
        deduplicateSegments(
            result?.segments
        );

    if (!segments.length) {
        throw new Error(
            "Whisper no devolvió segmentos válidos."
        );
    }

    console.log(
        "[USER NASHEED] Whisper:",
        {
            model: GROQ_STT,
            segments: segments.length,
            arabicSegments:
                segments.filter(
                    s => isArabicText(s.text)
                ).length,
            latinSegments:
                segments.filter(
                    s => {
                        const arabic =
                            arabicCharacterCount(
                                s.text
                            );

                        const latin =
                            latinCharacterCount(
                                s.text
                            );

                        return (
                            latin >= 3 &&
                            latin > arabic * 2
                        );
                    }
                ).length
        }
    );

    return segments;
}


/* =========================================================
   RECONSTRUCCIÓN ÁRABE
   ========================================================= */

/*
 * Extrae una respuesta del modelo que pueda contener
 * JSON, markdown o texto numerado.
 */
function extractModelText(result) {
    return String(
        result
            ?.choices
            ?.[0]
            ?.message
            ?.content ||
        ""
    )
        .trim();
}


function stripCodeFences(text) {
    return String(text || "")
        .replace(
            /^```(?:json|text)?\s*/i,
            ""
        )
        .replace(
            /\s*```$/i,
            ""
        )
        .trim();
}


/*
 * Busca JSON aunque el modelo haya añadido texto.
 */
function extractJsonObject(text) {
    const clean =
        stripCodeFences(text);

    const first =
        clean.indexOf("{");

    const last =
        clean.lastIndexOf("}");

    if (
        first === -1 ||
        last === -1 ||
        last <= first
    ) {
        return null;
    }

    const candidate =
        clean.slice(
            first,
            last + 1
        );

    try {
        return JSON.parse(
            candidate
        );
    } catch {
        return null;
    }
}


/*
 * Comprueba que la reconstrucción realmente
 * contiene escritura árabe.
 */
function validateArabicReconstruction(
    original,
    reconstructed
) {
    const value =
        cleanArabicText(
            reconstructed
        );

    if (!value) {
        return false;
    }

    if (!isArabicText(value)) {
        return false;
    }

    /*
     * No aceptamos una salida que sea prácticamente
     * idéntica a la transliteración.
     */
    const normalizedOriginal =
        cleanText(original)
            .toLowerCase()
            .replace(
                /[^a-z0-9\u0600-\u06ff\s]/gi,
                ""
            );

    const normalizedOutput =
        cleanText(value)
            .toLowerCase()
            .replace(
                /[^a-z0-9\u0600-\u06ff\s]/gi,
                ""
            );

    if (
        normalizedOriginal &&
        normalizedOutput ===
        normalizedOriginal
    ) {
        return false;
    }

    return true;
}


/*
 * Reconstruye un bloque de transliteraciones.
 *
 * El modelo recibe:
 *   1. índice
 *   2. texto original de Whisper
 *   3. contexto de los segmentos anteriores/siguientes
 *
 * Devuelve:
 * {
 *   "1": "النص العربي",
 *   "2": "النص العربي"
 * }
 */
async function reconstructArabicBatch(
    segments,
    startIndex,
    apiKey,
    attempt = 1
) {
    const batch =
        segments.slice(
            startIndex,
            startIndex +
                RECONSTRUCT_BATCH_SIZE
        );

    if (!batch.length) {
        return {};
    }

    const previous =
        segments[
            Math.max(
                0,
                startIndex - 4
            )
        ];

    const contextBefore =
        segments
            .slice(
                Math.max(
                    0,
                    startIndex - 4
                ),
                startIndex
            )
            .map(
                (s, i) =>
                    `${i + 1}: ${s.text}`
            )
            .join("\n");

    const contextAfter =
        segments
            .slice(
                startIndex +
                    batch.length,
                Math.min(
                    segments.length,
                    startIndex +
                        batch.length +
                        4
                )
            )
            .map(
                (s, i) =>
                    `${i + 1}: ${s.text}`
            )
            .join("\n");

    const input =
        batch
            .map(
                (segment, index) =>
                    `${index + 1}. ${segment.text}`
            )
            .join("\n");

    const systemPrompt =
        attempt === 1
            ? `
أنت متخصص في استعادة نصوص الأناشيد العربية الدينية.

مهمتك تحويل النص المكتوب بالحروف اللاتينية أو transliteration إلى النص العربي الحقيقي.

قواعد صارمة:

- أعد النص العربي بالحروف العربية فقط.
- لا تكتب transliteration.
- لا تكتب الكلمات العربية بحروف لاتينية.
- لا تترجم النص.
- لا تشرح.
- لا تضف أي كلام خارج JSON.
- حافظ على ترتيب الأرقام.
- حافظ على الكلمات والعبارات الدينية.
- حافظ على أسماء الله والأنبياء والأشخاص.
- حافظ على العبارات المتكررة.
- استخدم السياق لفهم الكلمات غير الواضحة.
- لا تخترع جملة جديدة إذا كان السياق يسمح باستنتاج الجملة الصحيحة.
- إذا كان النص يمثل عبارة عربية معروفة، استخدم الصياغة العربية الصحيحة.
- الحركات اختيارية وليست مطلوبة.
- المطلوب هو العربية المكتوبة، وليس النطق اللاتيني.

مثال:
"alhamdu lillahi rabbil alamin"
=> "الحمد لله رب العالمين"

مثال:
"ya rasulallah"
=> "يا رسول الله"

مثال:
"subhanallah"
=> "سبحان الله"

أعد JSON فقط بهذا الشكل:
{
  "1": "النص العربي",
  "2": "النص العربي"
}
`
            :
            `
أنت الآن في محاولة ثانية لاستعادة كلمات أنشودة عربية دينية.

النص الأصلي من Whisper قد يكون transliteration لاتيني.

لا تترجم.
لا تكتب transliteration.
لا تكتب الإنجليزية.
لا تشرح.
لا تعيد النص اللاتيني.

يجب أن تكون كل قيمة في JSON مكتوبة بالحروف العربية.

استخدم:
- السياق السابق
- السياق اللاحق
- الكلمات الدينية المعروفة
- تكرار الأبيات
- قواعد اللغة العربية

إذا كان هناك أكثر من احتمال، اختر الاحتمال الأكثر منطقية في سياق أنشودة عربية دينية.

أعد JSON فقط.
`;

    const userPrompt =
        `
السياق السابق:
${contextBefore || "(لا يوجد)"}

النص المطلوب:
${input}

السياق اللاحق:
${contextAfter || "(لا يوجد)"}
`;

    const requestBody = {
        model: GROQ_TEXT,
        temperature:
            attempt === 1
                ? 0.05
                : 0.15,
        max_completion_tokens:
            2000,
        messages: [
            {
                role: "system",
                content:
                    systemPrompt
            },
            {
                role: "user",
                content:
                    userPrompt
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

    const raw =
        extractModelText(result);

    const parsed =
        extractJsonObject(raw);

    if (!parsed) {
        throw new Error(
            "El modelo de reconstrucción no devolvió JSON válido."
        );
    }

    const output = {};

    for (
        let i = 0;
        i < batch.length;
        i++
    ) {
        const key =
            String(i + 1);

        const candidate =
            cleanArabicText(
                parsed[key]
            );

        if (
            !validateArabicReconstruction(
                batch[i].text,
                candidate
            )
        ) {
            throw new Error(
                `El modelo no pudo reconstruir correctamente el segmento ${startIndex + i + 1}.`
            );
        }

        output[
            startIndex + i
        ] = candidate;
    }

    return output;
}


/*
 * Reconstrucción completa.
 *
 * Solo sustituye segmentos que realmente
 * necesiten reconstrucción.
 */
async function reconstructArabic(
    segments,
    apiKey
) {
    const normalized =
        deduplicateSegments(
            segments
        );

    if (!normalized.length) {
        throw new Error(
            "No hay segmentos para reconstruir."
        );
    }

    const needs =
        normalized.map(
            segment =>
                !isArabicText(
                    segment.text
                )
        );

    const problematic =
        needs.filter(Boolean)
            .length;

    console.log(
        `[USER NASHEED] Segmentos que necesitan reconstrucción árabe: ${problematic}/${normalized.length}`
    );

    /*
     * Si Whisper ya devolvió árabe correctamente,
     * no gastamos una petición adicional.
     */
    if (
        problematic === 0
    ) {
        return normalized;
    }

    const reconstructed =
        normalized.map(
            segment => ({
                start:
                    segment.start,
                end:
                    segment.end,
                text:
                    segment.text
            })
        );

    /*
     * Procesamos todos los segmentos en bloques,
     * pero solo modificamos los que no sean árabes.
     */
    for (
        let start = 0;
        start < normalized.length;
        start += RECONSTRUCT_BATCH_SIZE
    ) {
        const block =
            normalized.slice(
                start,
                start +
                    RECONSTRUCT_BATCH_SIZE
            );

        const blockNeeds =
            block.some(
                segment =>
                    !isArabicText(
                        segment.text
                    )
            );

        if (!blockNeeds) {
            continue;
        }

        let result = null;
        let lastError = null;

        for (
            let attempt = 1;
            attempt <= 2;
            attempt++
        ) {
            try {
                result =
                    await reconstructArabicBatch(
                        normalized,
                        start,
                        apiKey,
                        attempt
                    );

                break;

            } catch (error) {
                lastError = error;

                console.error(
                    `[ARABIC RECONSTRUCTION] bloque ${start + 1}-${start + block.length}, intento ${attempt}:`,
                    error.message
                );

                if (
                    attempt < 2
                ) {
                    await sleep(
                        1200
                    );
                }
            }
        }

        if (!result) {
            throw new Error(
                `El modelo de reconstrucción árabe no pudo recuperar el bloque ${start + 1}-${start + block.length}: ${
                    lastError?.message ||
                    "respuesta vacía"
                }`
            );
        }

        for (
            const [
                index,
                arabicText
            ] of Object.entries(
                result
            )
        ) {
            const numericIndex =
                Number(index);

            if (
                !Number.isSafeInteger(
                    numericIndex
                )
            ) {
                continue;
            }

            if (
                numericIndex <
                    0 ||
                numericIndex >=
                    reconstructed.length
            ) {
                continue;
            }

            /*
             * Solo sustituimos si el resultado
             * es realmente árabe.
             */
            if (
                isArabicText(
                    arabicText
                )
            ) {
                reconstructed[
                    numericIndex
                ].text =
                    arabicText;
            }
        }
    }

    const remaining =
        reconstructed.filter(
            segment =>
                !isArabicText(
                    segment.text
                )
        );

    if (
        remaining.length
    ) {
        throw new Error(
            `La reconstrucción árabe terminó pero quedaron ${remaining.length} segmentos sin texto árabe. No se guardará una transliteración como subtítulo árabe.`
        );
    }

    console.log(
        "[USER NASHEED] Reconstrucción árabe completada."
    );

    return reconstructed;
}


/*
 * Función principal de transcripción.
 *
 * 1. Whisper.
 * 2. Detecta transliteración.
 * 3. Reconstruye.
 * 4. Comprueba nuevamente.
 */
async function transcribeArabic(
    audioUrl,
    apiKey
) {
    const whisperSegments =
        await whisperArabic(
            audioUrl,
            apiKey
        );

    if (
        !whisperSegments.length
    ) {
        throw new Error(
            "Whisper no devolvió segmentos."
        );
    }

    const needs =
        transcriptionNeedsReconstruction(
            whisperSegments
        );

    if (!needs) {
        console.log(
            "[USER NASHEED] Whisper devolvió árabe directamente."
        );

        return whisperSegments;
    }

    console.warn(
        "[USER NASHEED] Whisper devolvió principalmente transliteración latina. Iniciando reconstrucción árabe..."
    );

    const reconstructed =
        await reconstructArabic(
            whisperSegments,
            apiKey
        );

    /*
     * Comprobación FINAL.
     *
     * Es imposible guardar aquí texto latino.
     */
    const invalid =
        reconstructed.filter(
            segment =>
                !isArabicText(
                    segment.text
                )
        );

    if (
        invalid.length
    ) {
        throw new Error(
            `La transcripción final contiene ${invalid.length} segmentos que no están en árabe.`
        );
    }

    return reconstructed;
}


/* =========================================================
   TRADUCCIÓN
   ========================================================= */

function languageName(language) {
    const names = {
        es: "Spanish",
        en: "English",
        ru: "Russian"
    };

    return names[language] || null;
}


function cleanTranslation(text) {
    return String(text || "")
        .trim()
        .replace(
            /^```(?:text)?\s*/i,
            ""
        )
        .replace(
            /\s*```$/i,
            ""
        )
        .replace(
            /^["“”]+/,
            ""
        )
        .replace(
            /["“”]+$/,
            ""
        )
        .trim();
}


async function translateSingleSegment(
    text,
    language,
    apiKey
) {
    const target =
        languageName(
            language
        );

    if (!target) {
        throw new Error(
            `Idioma no soportado: ${language}`
        );
    }

    const source =
        cleanArabicText(
            text
        );

    if (
        !source ||
        !isArabicText(source)
    ) {
        throw new Error(
            "No se puede traducir un segmento que no contiene árabe válido."
        );
    }

    const requestBody = {
        model: GROQ_TEXT,
        temperature: 0.05,
        max_completion_tokens: 512,
        messages: [
            {
                role: "system",
                content:
                    `
Translate the following Arabic nasheed lyric into ${target}.

Rules:
- The source is Arabic.
- Translate the MEANING.
- Do NOT transliterate Arabic.
- Do NOT return Arabic.
- Do NOT repeat the source.
- Do NOT explain.
- Do NOT add notes.
- Do NOT use markdown.
- Do NOT use quotation marks.
- Preserve religious meaning.
- Keep the translation natural and concise.
- Return ONLY the translated text.
`
            },
            {
                role: "user",
                content:
                    source
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

    const translation =
        cleanTranslation(
            extractModelText(
                result
            )
        );

    if (!translation) {
        throw new Error(
            `Groq no devolvió traducción al ${target}.`
        );
    }

    /*
     * Si devuelve exactamente árabe,
     * consideramos que no tradujo.
     */
    if (
        isArabicText(
            translation
        )
    ) {
        throw new Error(
            `Groq devolvió árabe en vez de ${target}.`
        );
    }

    return translation;
}


/*
 * Traducción por segmentos.
 *
 * Mantiene EXACTAMENTE start/end del árabe.
 */
async function translateAll(
    segments,
    language,
    apiKey
) {
    const output = [];

    for (
        let i = 0;
        i < segments.length;
        i++
    ) {
        const segment =
            segments[i];

        let translated =
            "";

        let lastError =
            null;

        for (
            let attempt = 1;
            attempt <= 3;
            attempt++
        ) {
            try {
                translated =
                    await translateSingleSegment(
                        segment.text,
                        language,
                        apiKey
                    );

                if (
                    translated
                ) {
                    break;
                }

            } catch (error) {
                lastError =
                    error;

                console.error(
                    `[GROQ ${language}] segmento ${i + 1}/${segments.length}, intento ${attempt}:`,
                    error.message
                );

                if (
                    attempt < 3
                ) {
                    await sleep(
                        800 * attempt
                    );
                }
            }
        }

        if (!translated) {
            throw new Error(
                `La traducción ${language} no pudo recuperar el segmento ${i + 1}: ${
                    lastError?.message ||
                    "respuesta vacía"
                }`
            );
        }

        output.push({
            start:
                segment.start,
            end:
                segment.end,
            text:
                translated
        });

        console.log(
            `[GROQ ${language}] ${i + 1}/${segments.length}`
        );
    }

    return output;
}


/* =========================================================
   URL FIRMADA
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
   PROGRESO
   ========================================================= */

async function updateProgress(
    supabase,
    id,
    userId,
    percentage
) {
    const safe =
        Math.max(
            0,
            Math.min(
                100,
                Math.round(
                    percentage
                )
            )
        );

    await supabase
        .from("user_nasheeds")
        .update({
            status:
                `processing_${safe}%`
        })
        .eq(
            "id",
            id
        )
        .eq(
            "user_id",
            userId
        );
}


async function checkIfCanceled(
    supabase,
    id,
    userId
) {
    const {
        data,
        error
    } =
        await supabase
            .from("user_nasheeds")
            .select("status")
            .eq(
                "id",
                id
            )
            .eq(
                "user_id",
                userId
            )
            .single();

    if (error) {
        throw error;
    }

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

                /*
                 * Si falló o fue cancelado,
                 * permitimos reutilizarlo.
                 */
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
                    .status(
                        error.status ===
                            429
                            ? 429
                            : 500
                    )
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
                 * =====================================================
                 * 1. URL TEMPORAL DEL AUDIO
                 * =====================================================
                 */

                const signedAudio =
                    await supabase
                        .storage
                        .from(
                            BUCKET
                        )
                        .createSignedUrl(
                            row.audio_path,
                            900
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
                    20
                );

                /*
                 * =====================================================
                 * 2. WHISPER + RECONSTRUCCIÓN ÁRABE
                 * =====================================================
                 */

                console.log(
                    "[USER NASHEED] Transcribiendo árabe:",
                    row.title
                );

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
                        "No se pudo obtener la transcripción árabe."
                    );
                }

                console.log(
                    "[USER NASHEED] Árabe final:",
                    arabic.length,
                    "segmentos"
                );

                /*
                 * Comprobación de seguridad.
                 */
                const invalidArabic =
                    arabic.filter(
                        segment =>
                            !isArabicText(
                                segment.text
                            )
                    );

                if (
                    invalidArabic.length
                ) {
                    throw new Error(
                        `La transcripción final tiene ${invalidArabic.length} segmentos que no contienen árabe válido.`
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

                /*
                 * =====================================================
                 * 3. RUTA DE SUBTÍTULOS
                 * =====================================================
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
                 * =====================================================
                 * 4. SUBTÍTULO ÁRABE
                 * =====================================================
                 */

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

                /*
                 * =====================================================
                 * 5. TRADUCCIONES
                 * =====================================================
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

                const total =
                    requested.length;

                for (
                    let i = 0;
                    i < total;
                    i++
                ) {
                    const language =
                        requested[i];

                    await checkIfCanceled(
                        supabase,
                        id,
                        currentUser.id
                    );

                    const progress =
                        total > 0
                            ? 50 +
                              Math.round(
                                  ((i + 1) /
                                      total) *
                                  40
                              )
                            : 90;

                    await updateProgress(
                        supabase,
                        id,
                        currentUser.id,
                        progress
                    );

                    console.log(
                        `[USER NASHEED] Traduciendo a ${language}...`
                    );

                    const translated =
                        await translateAll(
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
                 * =====================================================
                 * 6. READY
                 * =====================================================
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
                    error.message ===
                    "PROCESO_CANCELADO"
                ) {
                    console.log(
                        `[USER NASHEED] ${id} cancelado por el usuario.`
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
                /*
                 * NASHEEDS PÚBLICOS
                 */

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

                /*
                 * USUARIO ACTUAL
                 */

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

                /*
                 * NASHEEDS PRIVADOS
                 * SOLO DEL USUARIO ACTUAL
                 */

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