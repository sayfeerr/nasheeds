"use strict";

const crypto = require("crypto");

/* =========================================================
   CONFIGURACIÓN
   ========================================================= */

const BUCKET = "UserNasheeds";
const MAX_AUDIO = 25 * 1024 * 1024;
const MAX_COVER = 5 * 1024 * 1024;

const AUDIO_TYPES = new Set([
    "audio/mpeg", "audio/mp3", "audio/mp4", "audio/x-m4a",
    "audio/m4a", "audio/ogg", "audio/wav", "audio/x-wav",
    "audio/webm", "audio/flac", "video/mp4", "video/webm"
]);

const COVER_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const LANGS = new Set(["es", "en", "ru"]);

const GEMINI_MODEL = "gemini-2.5-flash";

/* =========================================================
   UTILIDADES
   ========================================================= */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function day() {
    return new Date().toISOString().slice(0, 10);
}

function rnd() {
    return crypto.randomBytes(10).toString("hex");
}

function ext(type, name) {
    const extension = String(name || "").split(".").pop().toLowerCase();
    const allowed = ["mp3", "m4a", "mp4", "mpga", "mpeg", "ogg", "wav", "webm", "flac", "jpg", "jpeg", "png", "webp"];
    if (allowed.includes(extension)) return extension === "jpeg" ? "jpg" : extension;
    
    const byMime = {
        "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a",
        "audio/m4a": "m4a", "audio/ogg": "ogg", "audio/wav": "wav", "audio/x-wav": "wav",
        "audio/webm": "webm", "audio/flac": "flac", "video/mp4": "mp4", "video/webm": "webm",
        "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"
    };
    return byMime[type] || "bin";
}

/* =========================================================
   AUTH
   ========================================================= */

async function getUser(req, supabase) {
    const authorization = String(req.headers.authorization || "");
    if (!authorization.startsWith("Bearer ")) return null;
    const token = authorization.slice(7).trim();
    if (!token) return null;

    try {
        const { data, error } = await supabase.auth.getUser(token);
        if (error || !data || !data.user) return null;
        return data.user;
    } catch {
        return null;
    }
}

/* =========================================================
   IDIOMAS Y TEXTO
   ========================================================= */

function normalizeLanguages(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map((item) => String(item || "").trim().toLowerCase()).filter((item) => LANGS.has(item)))];
}

function cleanText(value) {
    return String(value || "").replace(/\r|\n+/g, " ").replace(/\s+/g, " ").trim();
}

function isUsefulText(value) {
    return cleanText(value).length > 0;
}

/* =========================================================
   SEGMENTOS Y VTT
   ========================================================= */

function normalizeSegments(segments) {
    if (!Array.isArray(segments)) return [];
    return segments.map((segment) => ({
        start: Number(segment?.start),
        end: Number(segment?.end),
        text: cleanText(segment?.text)
    })).filter((segment) => segment.text && Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start)
      .sort((a, b) => a.start - b.start);
}

function optimizeSegmentsProportional(segments, maxWords = 4) {
    const result = [];
    for (const seg of segments) {
        const text = cleanText(seg.text);
        if (!text) continue;
        const words = text.split(/\s+/);
        if (words.length <= maxWords) {
            result.push({ start: Number(seg.start), end: Number(seg.end), text });
            continue;
        }
        const duration = Number(seg.end) - Number(seg.start);
        const timePerWord = duration / words.length;
        
        for (let i = 0; i < words.length; i += maxWords) {
            const slice = words.slice(i, i + maxWords);
            const chunkStart = Number(seg.start) + (i * timePerWord);
            const chunkEnd = Number(seg.start) + ((i + slice.length) * timePerWord);
            result.push({ start: chunkStart, end: chunkEnd, text: slice.join(" ") });
        }
    }
    return normalizeSegments(result);
}

function vttTime(value) {
    const milliseconds = Math.max(0, Math.round(Number(value || 0) * 1000));
    const hours = Math.floor(milliseconds / 3600000);
    const minutes = Math.floor((milliseconds % 3600000) / 60000);
    const seconds = Math.floor((milliseconds % 60000) / 1000);
    const ms = milliseconds % 1000;
    return (String(hours).padStart(2, "0") + ":" + String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0") + "." + String(ms).padStart(3, "0"));
}

function makeVTT(segments) {
    const validSegments = normalizeSegments(segments);
    if (!validSegments.length) throw new Error("No hay segmentos válidos para crear el VTT.");
    
    const lines = ["WEBVTT", ""];
    for (let i = 0; i < validSegments.length; i++) {
        const segment = validSegments[i];
        const next = validSegments[i + 1] || null;
        let start = Math.max(0, segment.start);
        let end = Math.max(start + 0.1, segment.end);
        
        if (next && end > next.start) {
            end = Math.max(start + 0.1, next.start - 0.001);
        }
        
        lines.push(`${vttTime(start)} --> ${vttTime(end)}`);
        lines.push(segment.text);
        lines.push("");
    }
    
    const vtt = lines.join("\n").trim();
    if (!vtt || vtt === "WEBVTT") throw new Error("No se pudo generar el VTT.");
    return vtt + "\n";
}

/* =========================================================
   PROCESAMIENTO NATIVO CON GEMINI (AUDIO Y TRADUCCIÓN)
   ========================================================= */

async function processAudioWithGemini(audioUrl, targetLanguages, apiKey) {
    const key = apiKey || process.env.GEMINI_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY no está configurada.");

    let audioRes;
    try { audioRes = await fetch(audioUrl); } catch { throw new Error("Fallo de red al descargar audio."); }
    if (!audioRes.ok) throw new Error(`Error HTTP al descargar audio: ${audioRes.status}`);
    
    const audioBuffer = await audioRes.arrayBuffer();
    const blob = new Blob([audioBuffer], { type: "audio/mp3" });

    // 1. Subir a la API de archivos de Gemini
    const uploadUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${key}`;
    const uploadForm = new FormData();
    uploadForm.append("file", blob, "nasheed.mp3");

    const uploadRes = await fetch(uploadUrl, { method: "POST", body: uploadForm });
    const uploadData = await uploadRes.json();
    
    if (!uploadRes.ok || !uploadData?.file?.uri) {
        console.error("Error en subida de archivo a Gemini:", uploadData);
        throw new Error("No se pudo subir el archivo de audio a Gemini.");
    }

    const fileUri = uploadData.file.uri;
    const mimeType = uploadData.file.mimeType || "audio/mp3";

    const langsRequested = Array.isArray(targetLanguages) ? targetLanguages : [];

    // 2. Prompt estructurado para obtener transcripción y traducciones sincronizadas
    const promptText = `You are an expert Islamic nasheed transcriber and professional translator. 
Listen to this audio file carefully from start to finish. Do not skip any part or chorus.
You must output a strict JSON object with this exact structure:
{
  "arabic_segments": [
    { "start": 0.0, "end": 5.2, "text": "arabic text line" }
  ],
  "translations": {
    // For each requested language (${langsRequested.join(", ")}), provide an array of strings matching the exact quantity and order of arabic_segments.
  }
}
CRITICAL RULES:
1. Provide accurate timestamps (start and end in seconds) for every line.
2. Do not leave large gaps or skip sections where vocals are singing.
3. Return ONLY valid JSON. No markdown ticks, just the clean JSON string.`;

    const generateUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
    
    const requestBody = {
        contents: [
            {
                parts: [
                    { file_data: { file_uri: fileUri, mime_type: mimeType } },
                    { text: promptText }
                ]
            }
        ],
        generationConfig: {
            temperature: 0.1,
            response_mime_type: "application/json"
        }
    };

    const genRes = await fetch(generateUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody)
    });

    const genData = await genRes.json();

    if (!genRes.ok || !genData?.candidates?.[0]?.content?.parts?.[0]?.text) {
        console.error("RESPUESTA DE ERROR DE GEMINI:", JSON.stringify(genData, null, 2));
        throw new Error(genData?.error?.message || "Gemini no devolvió una respuesta válida.");
    }

    const responseText = genData.candidates[0].content.parts[0].text;

    let parsedResult;
    try {
        const cleanJson = responseText.replace(/```json/gi, "").replace(/```/g, "").trim();
        parsedResult = JSON.parse(cleanJson);
    } catch (e) {
        console.error("Texto recibido que falló al parsear como JSON:", responseText);
        throw new Error("Error al parsear el JSON estructurado devuelto por Gemini.");
    }

    return parsedResult;
}

/* =========================================================
   PROGRESO Y CANCELACIÓN
   ========================================================= */

async function updateProgress(supabase, id, userId, percentage) {
    await supabase.from("user_nasheeds").update({ status: `processing_${percentage}%` }).eq("id", id).eq("user_id", userId);
}

async function checkIfCanceled(supabase, id, userId) {
    const { data } = await supabase.from("user_nasheeds").select("status").eq("id", id).eq("user_id", userId).single();
    if (data && data.status === "canceled") throw new Error("PROCESO_CANCELADO");
}

/* =========================================================
   RUTAS PRINCIPALES
   ========================================================= */

async function signUrl(supabase, storagePath, seconds) {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, seconds);
    if (error) throw error;
    if (!data || !data.signedUrl) throw new Error("Supabase no devolvió una URL firmada.");
    return data.signedUrl;
}

async function privateTrack(supabase, row) {
    const subtitles = {};
    for (const [language, storagePath] of Object.entries(row.subtitles || {})) {
        if (language.startsWith("__") || typeof storagePath !== "string" || !storagePath) continue;
        try { subtitles[language] = await signUrl(supabase, storagePath, 86400); } catch (e) {}
    }

    return {
        id: Number(row.id),
        title: row.title,
        file: await signUrl(supabase, row.audio_path, 86400),
        cover: row.cover_path ? await signUrl(supabase, row.cover_path, 86400) : "",
        subtitles, warning: false, private: true, status: row.status, created_at: row.created_at
    };
}

function registerUserNasheedRoutes({ app, supabase, geminiApiKey }) {

    app.get("/api/user-nasheeds", async (req, res) => {
        const currentUser = await getUser(req, supabase);
        if (!currentUser) return res.status(401).json({ error: "Debes iniciar sesión." });
        try {
            const { data, error } = await supabase.from("user_nasheeds").select("id,title,status,error_message,created_at,upload_day").eq("user_id", currentUser.id).order("created_at", { ascending: false });
            if (error) throw error;
            return res.json({ nasheeds: (data || []).map(item => ({ id: Number(item.id), title: item.title, status: item.status, error: item.error_message || null, created_at: item.created_at, upload_day: item.upload_day })) });
        } catch { return res.status(500).json({ error: "Error." }); }
    });

    app.post("/api/user-nasheeds/prepare", async (req, res) => {
        const currentUser = await getUser(req, supabase);
        if (!currentUser) return res.status(401).json({ error: "Inicia sesión." });
        let uploadId = null;
        
        try {
            const title = String(req.body?.title || "").trim();
            const audio = req.body?.audio || {};
            const cover = req.body?.cover || null;
            const translations = normalizeLanguages(req.body?.translations);
            
            if (!title) return res.status(400).json({ error: "Título obligatorio." });
            
            const uploadDay = day();
            const existing = await supabase.from("user_nasheeds").select("id,status,title").eq("user_id", currentUser.id).eq("upload_day", uploadDay).maybeSingle();
            if (existing.error) throw existing.error;

            if (existing.data && (String(existing.data.status || "").startsWith("processing") || existing.data.status === "ready")) {
                return res.status(409).json({ error: "Ya tienes subida.", id: Number(existing.data.id), status: existing.data.status });
            }

            if (existing.data && (existing.data.status === "error" || existing.data.status === "canceled")) {
                uploadId = Number(existing.data.id);
                await supabase.from("user_nasheeds").update({ title, audio_path: "", cover_path: null, subtitles: { __requested: translations }, status: "processing_0%", error_message: null }).eq("id", uploadId).eq("user_id", currentUser.id);
            }

            if (!uploadId) {
                const inserted = await supabase.from("user_nasheeds").insert({ user_id: currentUser.id, title, audio_path: "", cover_path: null, subtitles: { __requested: translations }, status: "processing_0%", error_message: null, upload_day: uploadDay }).select("id").single();
                uploadId = Number(inserted.data.id);
            }

            const prefix = `${currentUser.id}/${uploadDay}/${uploadId}-${rnd()}`;
            const audioPath = `${prefix}/audio.${ext(audio.type || "", audio.name)}`;
            const coverPath = cover ? `${prefix}/cover.${ext(cover.type || "", cover.name)}` : null;

            const audioSigned = await supabase.storage.from(BUCKET).createSignedUploadUrl(audioPath, { upsert: false });
            let coverSigned = null;
            if (coverPath) coverSigned = await supabase.storage.from(BUCKET).createSignedUploadUrl(coverPath, { upsert: false });

            await supabase.from("user_nasheeds").update({ audio_path: audioPath, cover_path: coverPath }).eq("id", uploadId).eq("user_id", currentUser.id);
            return res.json({ success: true, id: uploadId, audio: { path: audioPath, token: audioSigned.data.token }, cover: coverSigned ? { path: coverPath, token: coverSigned.data.token } : null });
        } catch (error) {
            if (uploadId) await supabase.from("user_nasheeds").update({ status: "error", error_message: "Error preparacion" }).eq("id", uploadId).eq("user_id", currentUser.id);
            return res.status(500).json({ error: "Fallo preparacion." });
        }
    });

    app.post("/api/user-nasheeds/:id/cancel", async (req, res) => {
        const currentUser = await getUser(req, supabase);
        if (!currentUser) return res.status(401).json({ error: "Inicia sesión." });
        await supabase.from("user_nasheeds").update({ status: "canceled", error_message: "Cancelado." }).eq("id", Number(req.params.id)).eq("user_id", currentUser.id);
        return res.json({ success: true, message: "Cancelado." });
    });

    app.post("/api/user-nasheeds/:id/process", async (req, res) => {
        const currentUser = await getUser(req, supabase);
        if (!currentUser) return res.status(401).json({ error: "Debes iniciar sesión." });
        const id = Number(req.params.id);

        try {
            await checkIfCanceled(supabase, id, currentUser.id);
            await updateProgress(supabase, id, currentUser.id, 15);

            const query = await supabase.from("user_nasheeds").select("*").eq("id", id).eq("user_id", currentUser.id).single();
            const row = query.data;
            if (!row || !row.audio_path) return res.status(400).json({ error: "Audio faltante." });

            const signedAudio = await supabase.storage.from(BUCKET).createSignedUrl(row.audio_path, 600);
            await updateProgress(supabase, id, currentUser.id, 30);

            const requested = normalizeLanguages(row.subtitles?.__requested);

            // LLAMADA PRINCIPAL A GEMINI
            const geminiResult = await processAudioWithGemini(signedAudio.data.signedUrl, requested, geminiApiKey);

            if (!geminiResult || !Array.isArray(geminiResult.arabic_segments)) {
                throw new Error("Gemini no devolvió segmentos árabes válidos.");
            }

            let arabicSegments = normalizeSegments(geminiResult.arabic_segments);
            await updateProgress(supabase, id, currentUser.id, 60);

            const prefix = row.audio_path.split("/").slice(0, -1).join("/");
            const subtitlePaths = {};

            /* =================================================
               1. ÁRABE
               ================================================= */
            const optimizedArabic = optimizeSegmentsProportional(arabicSegments, 4);
            const arabicPath = `${prefix}/subtitles/ar.vtt`;
            await supabase.storage.from(BUCKET).upload(arabicPath, Buffer.from("\uFEFF" + makeVTT(optimizedArabic), "utf8"), { contentType: "text/vtt; charset=utf-8", upsert: true });
            subtitlePaths.ar = arabicPath;

            /* =================================================
               2. IDIOMAS EXTRANJEROS (es, en, ru)
               ================================================= */
            await updateProgress(supabase, id, currentUser.id, 80);

            for (const language of requested) {
                try {
                    await checkIfCanceled(supabase, id, currentUser.id);
                    
                    const rawTranslations = geminiResult.translations?.[language];
                    if (Array.isArray(rawTranslations) && rawTranslations.length > 0) {
                        const translatedSegments = arabicSegments.map((seg, idx) => ({
                            start: seg.start,
                            end: seg.end,
                            text: cleanText(rawTranslations[idx] || "[Traducción no disponible]")
                        }));

                        const optimizedTranslation = optimizeSegmentsProportional(translatedSegments, 4);
                        const translationPath = `${prefix}/subtitles/${language}.vtt`;
                        
                        await supabase.storage.from(BUCKET).upload(translationPath, Buffer.from("\uFEFF" + makeVTT(optimizedTranslation), "utf8"), { contentType: "text/vtt; charset=utf-8", upsert: true });
                        subtitlePaths[language] = translationPath;
                    }
                } catch (error) {
                    console.error(`Error procesando subtítulo ${language}:`, error);
                }
            }

            await updateProgress(supabase, id, currentUser.id, 95);
            
            await supabase.from("user_nasheeds").update({ subtitles: subtitlePaths, status: "ready", error_message: null }).eq("id", id).eq("user_id", currentUser.id);
            return res.json({ success: true, id, title: row.title, status: "ready" });
        } catch (error) {
            try { await supabase.from("user_nasheeds").update({ status: "error", error_message: String(error?.message || "Error").slice(0, 500) }).eq("id", id).eq("user_id", currentUser.id); } catch (e) {}
            return res.status(500).json({ error: error?.message || "Fallo en servidor." });
        }
    });

    app.get("/api/nasheeds", async (req, res) => {
        try {
            const publicRows = await supabase.from("nasheeds").select("id,title,audio_url,cover_url,subtitles,warning_enabled,created_at").order("created_at", { ascending: false });
            const publicTracks = (publicRows.data || []).map((item) => ({ id: Number(item.id), title: item.title, file: item.audio_url, cover: item.cover_url || "", subtitles: item.subtitles || {}, warning: Boolean(item.warning_enabled), private: false }));

            const currentUser = await getUser(req, supabase);
            if (!currentUser) return res.json(publicTracks);

            const privateRows = await supabase.from("user_nasheeds").select("id,title,audio_path,cover_path,subtitles,status,created_at").eq("user_id", currentUser.id).eq("status", "ready").order("created_at", { ascending: false });
            const privateTracks = [];
            for (const row of privateRows.data || []) {
                if (!row.audio_path) continue;
                try { privateTracks.push(await privateTrack(supabase, row)); } catch (e) {}
            }
            return res.json([...privateTracks, ...publicTracks]);
        } catch (error) {
            return res.status(500).json({ error: "No se pudieron cargar." });
        }
    });
}

module.exports = { registerUserNasheedsRoutes: registerUserNasheedRoutes, registerUserNasheedRoutes };