"use strict";

const { Buffer } = require("buffer");

function registerUserNasheedRoutes({ app, supabase, groqApiKey }) {

    // 0. RUTA UNIFICADA PARA EL REPRODUCTOR PRINCIPAL (index.html)
    app.get("/api/nasheeds", async (req, res) => {
        try {
            // 1. Obtener nasheeds públicos de la tabla general del admin
            const { data: publicTracks, error: pubError } = await supabase
                .from("nasheeds")
                .select("id, title, audio_url, cover_url, subtitles, warning_enabled, created_at")
                .order("created_at", { ascending: false });

            if (pubError) console.error("[PUB NASHEEDS ERROR]", pubError);

            const formattedPublic = (publicTracks || []).map(item => ({
                id: Number(item.id),
                title: item.title,
                file: item.audio_url,
                cover: item.cover_url || "",
                subtitles: item.subtitles || {},
                warning: Boolean(item.warning_enabled),
                private: false,
                status: "ready",
                created_at: item.created_at
            }));

            // 2. Intentar ver si hay un usuario autenticado para añadir sus nasheeds privados
            let formattedPrivate = [];
            const authHeader = req.headers.authorization || "";
            if (authHeader.startsWith("Bearer ")) {
                const token = authHeader.slice(7).trim();
                const { data: { user } } = await supabase.auth.getUser(token);

                if (user) {
                    const { data: userTracks, error: userError } = await supabase
                        .from("user_nasheeds")
                        .select("*")
                        .eq("user_id", user.id)
                        .eq("status", "ready")
                        .order("created_at", { ascending: false });

                    if (!userError && userTracks) {
                        for (const item of userTracks) {
                            // Generar URLs públicas/firmadas para el audio del usuario
                            const { data: audioPublic } = supabase.storage
                                .from("UserNasheeds")
                                .getPublicUrl(item.audio_path);

                            let coverUrl = "";
                            if (item.cover_path) {
                                const { data: coverPublic } = supabase.storage
                                    .from("UserNasheeds")
                                    .getPublicUrl(item.cover_path);
                                coverUrl = coverPublic?.publicUrl || "";
                            }

                            // Mapear los subtítulos .vtt generados
                            const subs = {};
                            if (item.subtitles && typeof item.subtitles === "object") {
                                for (const [lang, vttContent] of Object.entries(item.subtitles)) {
                                    // Creamos una URL de Data URI base64 para que el reproductor los lea directamente sin fallos
                                    subs[lang] = `data:text/vtt;charset=utf-8,${encodeURIComponent(vttContent)}`;
                                }
                            }

                            formattedPrivate.push({
                                id: Number(item.id),
                                title: item.title,
                                file: audioPublic?.publicUrl || "",
                                cover: coverUrl,
                                subtitles: subs,
                                warning: false,
                                private: true,
                                status: "ready",
                                created_at: item.created_at
                            });
                        }
                    }
                }
            }

            // Devolver ambos combinados (los privados del usuario primero, luego los públicos)
            return res.status(200).json([...formattedPrivate, ...formattedPublic]);

        } catch (err) {
            console.error("[NASHEEDS API ERROR]", err);
            return res.status(500).json({ error: err.message });
        }
    });

    // 1. Obtener lista para el panel de subida del usuario
    app.get("/api/user-nasheeds", async (req, res) => {
        try {
            const authHeader = req.headers.authorization || "";
            if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ error: "No token provided" });
            const token = authHeader.slice(7).trim();

            const { data: { user }, error: userError } = await supabase.auth.getUser(token);
            if (userError || !user) return res.status(401).json({ error: "Unauthorized" });

            const { data: nasheeds, error } = await supabase
                .from("user_nasheeds")
                .select("*")
                .eq("user_id", user.id)
                .order("created_at", { ascending: false });

            if (error) throw error;
            return res.status(200).json({ nasheeds: nasheeds || [] });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    });

    // 2. Preparar subida (Valida límite diario de 1 subida y nombres limpios)
    app.post("/api/user-nasheeds/prepare", async (req, res) => {
        try {
            const authHeader = req.headers.authorization || "";
            if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ error: "No token provided" });
            const token = authHeader.slice(7).trim();

            const { data: { user }, error: userError } = await supabase.auth.getUser(token);
            if (userError || !user) return res.status(401).json({ error: "Unauthorized" });

            const { title, translations, audio, cover } = req.body;
            if (!title || !audio) return res.status(400).json({ error: "Título y audio requeridos" });

            const today = new Date().toISOString().slice(0, 10);

            const { data: existingUpload } = await supabase
                .from("user_nasheeds")
                .select("id")
                .eq("user_id", user.id)
                .eq("upload_day", today)
                .maybeSingle();

            if (existingUpload) {
                return res.status(400).json({ error: "Ya has realizado una subida hoy. Solo se permite una subida al día." });
            }

            const safeAudioName = audio.name.replace(/[^a-zA-Z0-9_.-]/g, "_");
            const audioPath = `${user.id}/${Date.now()}_${safeAudioName}`;

            const safeCoverName = cover ? cover.name.replace(/[^a-zA-Z0-9_.-]/g, "_") : null;
            const coverPath = cover ? `${user.id}/${Date.now()}_${safeCoverName}` : null;

            const { data: inserted, error: insertError } = await supabase
                .from("user_nasheeds")
                .insert({
                    user_id: user.id,
                    title,
                    status: "processing",
                    upload_day: today,
                    audio_path: audioPath,
                    cover_path: coverPath,
                    translations: translations || []
                })
                .select()
                .single();

            if (insertError) throw insertError;

            const { data: audioUploadData, error: audioSignError } = await supabase.storage
                .from("UserNasheeds")
                .createSignedUploadUrl(audioPath);

            if (audioSignError) throw audioSignError;

            let coverUploadData = null;
            if (cover && coverPath) {
                const { data: coverSignData, error: coverSignError } = await supabase.storage
                    .from("UserNasheeds")
                    .createSignedUploadUrl(coverPath);
                if (!coverSignError) coverUploadData = coverSignData;
            }

            return res.status(200).json({
                id: inserted.id,
                audio: { path: audioUploadData.path, token: audioUploadData.token },
                cover: coverUploadData ? { path: coverUploadData.path, token: coverUploadData.token } : null
            });
        } catch (err) {
            console.error("[PREPARE ERROR]", err);
            return res.status(500).json({ error: err.message });
        }
    });

    // 3. Procesar audio con Groq IA y generar subtítulos traducidos
    app.post("/api/user-nasheeds/:id/process", async (req, res) => {
        const { id } = req.params;

        try {
            const authHeader = req.headers.authorization || "";
            if (!authHeader.startsWith("Bearer ")) return res.status(401).json({ error: "No token provided" });
            const token = authHeader.slice(7).trim();

            const { data: { user }, error: userError } = await supabase.auth.getUser(token);
            if (userError || !user) return res.status(401).json({ error: "Unauthorized" });

            const { data: nasheed, error: fetchError } = await supabase
                .from("user_nasheeds")
                .select("*")
                .eq("id", id)
                .eq("user_id", user.id)
                .single();

            if (fetchError || !nasheed) return res.status(404).json({ error: "Nasheed no encontrado" });

            const { data: fileData, error: downloadError } = await supabase.storage
                .from("UserNasheeds")
                .download(nasheed.audio_path);

            if (downloadError) throw downloadError;

            const arrayBuffer = await fileData.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            const formData = new FormData();
            formData.append("file", new Blob([buffer]), "audio.mp3");
            formData.append("model", "whisper-large-v3-turbo");
            formData.append("response_format", "verbose_json");
            formData.append("prompt", "Nasheed islámico con voces claras y continuas en árabe.");

            const groqRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
                method: "POST",
                headers: { "Authorization": `Bearer ${groqApiKey}` },
                body: formData
            });

            const transcription = await groqRes.json();
            if (!transcription.segments || transcription.segments.length === 0) {
                throw new Error("La IA no pudo detectar segmentos de voz.");
            }

            const segments = transcription.segments;
            const requestedLangs = nasheed.translations || [];
            const allLangs = Array.from(new Set(["ar", ...requestedLangs]));
            const subtitlesMap = {};

            for (const lang of allLangs) {
                let processedSegments = JSON.parse(JSON.stringify(segments));

                if (lang !== "ar") {
                    const texts = segments.map(s => s.text.trim());
                    const prompt = `Traduce estrictamente los siguientes fragmentos de subtítulos de un nasheed al idioma '${lang}'. Devuelve ÚNICAMENTE un array JSON válido de strings traducidos en el mismo orden exacto, sin texto adicional: ${JSON.stringify(texts)}`;

                    try {
                        const llmRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                            method: "POST",
                            headers: {
                                "Authorization": `Bearer ${groqApiKey}`,
                                "Content-Type": "application/json"
                            },
                            body: JSON.stringify({
                                model: "llama-3.1-8b-instant",
                                messages: [{ role: "user", content: prompt }],
                                temperature: 0.1
                            })
                        });
                        const llmData = await llmRes.json();
                        const content = llmData.choices?.[0]?.message?.content || "";
                        const jsonMatch = content.match(/\[[\s\S]*\]/);
                        if (jsonMatch) {
                            const translatedTexts = JSON.parse(jsonMatch[0]);
                            if (Array.isArray(translatedTexts) && translatedTexts.length === segments.length) {
                                processedSegments = segments.map((seg, idx) => ({
                                    ...seg,
                                    text: translatedTexts[idx] || seg.text
                                }));
                            }
                        }
                    } catch (err) {
                        console.error(`[TRANSLATION ERROR ${lang}]`, err);
                    }
                }

                let vtt = "WEBVTT\n\n";
                processedSegments.forEach((seg, index) => {
                    let start = seg.start;
                    let end = seg.end;
                    let text = seg.text.trim();

                    if (!text) return;

                    if (index < processedSegments.length - 1) {
                        const nextStart = processedSegments[index + 1].start;
                        if (nextStart - end < 1.0 && nextStart > end) {
                            end = nextStart; 
                        }
                    }

                    vtt += `${index + 1}\n${formatVttTime(start)} --> ${formatVttTime(end)}\n${text}\n\n`;
                });

                subtitlesMap[lang] = vtt;
            }

            await supabase
                .from("user_nasheeds")
                .update({ status: "ready", subtitles: subtitlesMap })
                .eq("id", id);

            return res.status(200).json({ success: true });
        } catch (err) {
            console.error("[PROCESS ERROR]", err);
            await supabase
                .from("user_nasheeds")
                .update({ status: "error", error: err.message })
                .eq("id", id);

            return res.status(500).json({ error: err.message });
        }
    });
}

function formatVttTime(seconds) {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const millis = Math.floor((seconds % 1) * 1000);
    return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

module.exports = {
    registerUserNasheedRoutes
};