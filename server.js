const express = require('express');
const multer = require('multer');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

require('dotenv').config();

const app = express();

const PORT =
    process.env.PORT ||
    3000;


// =========================================================
// SESIONES
// =========================================================

app.use(
    session({

        secret:
            process.env.SESSION_SECRET ||
            'nushud-super-secret-key-change-it',

        resave:
            false,

        saveUninitialized:
            false,

        cookie: {

            secure:
                false,

            httpOnly:
                true,

            maxAge:
                1000 *
                60 *
                60 *
                2

        }

    })
);


// =========================================================
// MIDDLEWARE
// =========================================================

app.use(
    express.json()
);


app.use(
    express.urlencoded({
        extended:
            true
    })
);


// =========================================================
// ARCHIVOS PÚBLICOS
// =========================================================

app.use(
    express.static(
        path.join(
            __dirname,
            'public'
        )
    )
);


// =========================================================
// RUTA ADMIN
// =========================================================

const SECRET_ADMIN_PATH =
    process.env.ADMIN_PATH ||
    '/panel-oculto-propietario-xyz';


app.get(
    SECRET_ADMIN_PATH,
    (req, res) => {

        if (
            req.session &&
            req.session.isAdmin
        ) {

            return res.sendFile(
                path.join(
                    __dirname,
                    'public',
                    'admin.html'
                )
            );

        }


        return res.send(`
<!DOCTYPE html>
<html lang="es" class="dark">

<head>

    <meta charset="UTF-8">

    <meta
        name="viewport"
        content="width=device-width, initial-scale=1.0">

    <title>Acceso Restringido</title>

    <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>

    <style>

        body {

            font-family:
                sans-serif;

            background-color:
                #060608;

            color:
                #f4f4f5;

        }

    </style>

</head>


<body
    class="min-h-screen flex items-center justify-center p-6">


<div
    class="bg-zinc-900 border border-amber-500/30 p-8 rounded-3xl max-w-sm w-full space-y-4 shadow-2xl">


    <h1
        class="text-sm font-bold text-amber-400 uppercase tracking-wider text-center">

        Identificación Requerida

    </h1>


    <input
        type="password"
        id="pin-input"
        placeholder="Introduce tu PIN"
        class="w-full bg-zinc-950 border border-white/10 rounded-xl px-4 py-3 text-sm text-zinc-100 focus:outline-none focus:border-amber-500 text-center tracking-widest">


    <button
        onclick="loginAdmin()"
        class="w-full bg-amber-500 hover:bg-amber-400 text-zinc-950 font-bold py-3 rounded-xl text-xs cursor-pointer">

        Acceder al Panel

    </button>


    <p
        id="error-msg"
        class="text-xs text-red-400 text-center h-4">

    </p>


</div>


<script>

async function loginAdmin() {

    const pin =
        document
            .getElementById(
                'pin-input'
            )
            .value;


    try {

        const res =
            await fetch(
                '/api/login',
                {

                    method:
                        'POST',

                    headers: {

                        'Content-Type':
                            'application/json'

                    },

                    body:
                        JSON.stringify({
                            pin
                        })

                }
            );


        const data =
            await res.json();


        if (
            data.success
        ) {

            window.location.reload();

        } else {

            document
                .getElementById(
                    'error-msg'
                )
                .textContent =
                'PIN incorrecto';

        }

    } catch (error) {

        document
            .getElementById(
                'error-msg'
            )
            .textContent =
            'Error de conexión';

    }

}

</script>

</body>
</html>
        `);

    }
);


// =========================================================
// UPLOAD DIR
// =========================================================

const UPLOAD_DIR =
    path.join(
        __dirname,
        'public',
        'uploads'
    );


if (
    !fs.existsSync(
        UPLOAD_DIR
    )
) {

    fs.mkdirSync(
        UPLOAD_DIR,
        {
            recursive:
                true
        }
    );

}


// =========================================================
// MULTER STORAGE
// =========================================================

const storage =
    multer.diskStorage({

        destination:
            (req, file, cb) => {

                cb(
                    null,
                    UPLOAD_DIR
                );

            },


        filename:
            (req, file, cb) => {

                const uniqueSuffix =
                    Date.now() +
                    '-' +
                    Math.round(
                        Math.random() *
                        1E9
                    );


                let extension =
                    path
                        .extname(
                            file.originalname
                        )
                        .toLowerCase();


                if (
                    file.fieldname ===
                    'subtitles'
                ) {

                    extension =
                        '.vtt';

                }


                cb(
                    null,
                    uniqueSuffix +
                    extension
                );

            }

    });


// =========================================================
// FILE FILTER
// =========================================================

const upload =
    multer({

        storage:
            storage,

        limits: {

            fileSize:
                25 *
                1024 *
                1024

        },


        fileFilter:
            (req, file, cb) => {


                if (
                    file.fieldname ===
                    'audio'
                ) {

                    if (
                        file.mimetype &&
                        file.mimetype.startsWith(
                            'audio/'
                        )
                    ) {

                        return cb(
                            null,
                            true
                        );

                    }


                    return cb(
                        new Error(
                            'El archivo de audio no es válido.'
                        )
                    );

                }


                if (
                    file.fieldname ===
                    'cover'
                ) {

                    if (
                        file.mimetype &&
                        file.mimetype.startsWith(
                            'image/'
                        )
                    ) {

                        return cb(
                            null,
                            true
                        );

                    }


                    return cb(
                        new Error(
                            'La carátula debe ser una imagen.'
                        )
                    );

                }


                if (
                    file.fieldname ===
                    'subtitles'
                ) {

                    const extension =
                        path
                            .extname(
                                file.originalname
                            )
                            .toLowerCase();


                    if (
                        extension ===
                        '.vtt'
                    ) {

                        return cb(
                            null,
                            true
                        );

                    }


                    return cb(
                        new Error(
                            'Los subtítulos deben ser archivos .vtt'
                        )
                    );

                }


                return cb(
                    new Error(
                        'Campo de archivo no permitido.'
                    )
                );

            }

    });


// =========================================================
// BASE DE DATOS
// =========================================================

const DB_FILE =
    path.join(
        __dirname,
        'nasheeds.json'
    );


function getNasheeds() {

    if (
        !fs.existsSync(
            DB_FILE
        )
    ) {

        return [];

    }


    try {

        const data =
            fs.readFileSync(
                DB_FILE,
                'utf8'
            );


        const parsed =
            JSON.parse(
                data
            );


        if (
            !Array.isArray(
                parsed
            )
        ) {

            return [];

        }


        return parsed;

    } catch (error) {

        console.error(
            'Error leyendo nasheeds.json:',
            error
        );


        return [];

    }

}


function saveNasheeds(
    data
) {

    fs.writeFileSync(

        DB_FILE,

        JSON.stringify(
            data,
            null,
            2
        ),

        'utf8'

    );

}


// =========================================================
// ADMIN
// =========================================================

function requireAdmin(
    req,
    res,
    next
) {

    if (
        req.session &&
        req.session.isAdmin
    ) {

        return next();

    }


    return res
        .status(403)
        .json({

            error:
                'Acceso denegado. No autorizado.'

        });

}


// =========================================================
// API PÚBLICA
// =========================================================

app.get(
    '/api/nasheeds',
    (req, res) => {

        res.json(
            getNasheeds()
        );

    }
);


// =========================================================
// API ADMIN
// =========================================================

app.get(
    '/api/admin/nasheeds',
    requireAdmin,
    (req, res) => {

        res.json(
            getNasheeds()
        );

    }
);


// =========================================================
// CHECK SESSION
// =========================================================

app.get(
    '/api/check-session',
    (req, res) => {

        res.json({

            isAdmin:
                !!(
                    req.session &&
                    req.session.isAdmin
                )

        });

    }
);


// =========================================================
// LOGIN
// =========================================================

app.post(
    '/api/login',
    (req, res) => {

        const { pin } =
            req.body;


        const adminPin =
            process.env.ADMIN_PIN ||
            '7777';


        if (
            pin &&
            pin ===
            adminPin
        ) {

            req.session.isAdmin =
                true;


            return res.json({

                success:
                    true,

                redirect:
                    SECRET_ADMIN_PATH

            });

        }


        return res
            .status(401)
            .json({

                success:
                    false,

                error:
                    'PIN incorrecto'

            });

    }
);


// =========================================================
// LOGOUT
// =========================================================

app.post(
    '/api/logout',
    (req, res) => {

        req.session.destroy(
            () => {

                res.json({

                    success:
                        true

                });

            }
        );

    }
);


// =========================================================
// SUBIR AUDIO + CARÁTULA + MÚLTIPLES VTT
// =========================================================

app.post(

    '/api/upload',

    requireAdmin,

    upload.fields([

        {
            name:
                'audio',

            maxCount:
                1

        },

        {
            name:
                'cover',

            maxCount:
                1

        },

        {
            name:
                'subtitles',

            maxCount:
                20

        }

    ]),


    (req, res) => {

        const title =
            String(
                req.body.title ||
                ''
            ).trim();


        const audioFile =
            req.files?.audio?.[0];


        const coverFile =
            req.files?.cover?.[0];


        const subtitleFiles =
            req.files?.subtitles ||
            [];


        /*
         * COMPROBAR BÁSICOS
         */

        if (
            !title ||
            !audioFile
        ) {

            cleanupFiles([
                audioFile,
                coverFile,
                ...subtitleFiles
            ]);


            return res
                .status(400)
                .json({

                    error:
                        'Faltan el título o el archivo de audio.'

                });

        }


        /*
         * LEER IDIOMAS
         */

        let subtitleLanguages;


        try {

            subtitleLanguages =
                JSON.parse(
                    req.body.subtitleLanguages ||
                    '[]'
                );

        } catch {

            cleanupFiles([
                audioFile,
                coverFile,
                ...subtitleFiles
            ]);


            return res
                .status(400)
                .json({

                    error:
                        'La información de idiomas no es válida.'

                });

        }


        if (
            !Array.isArray(
                subtitleLanguages
            )
        ) {

            cleanupFiles([
                audioFile,
                coverFile,
                ...subtitleFiles
            ]);


            return res
                .status(400)
                .json({

                    error:
                        'Los idiomas de subtítulos no son válidos.'

                });

        }


        /*
         * CANTIDAD
         */

        if (
            subtitleLanguages.length !==
            subtitleFiles.length
        ) {

            cleanupFiles([
                audioFile,
                coverFile,
                ...subtitleFiles
            ]);


            return res
                .status(400)
                .json({

                    error:
                        'No coinciden los idiomas con los archivos VTT.'

                });

        }


        /*
         * NORMALIZAR
         */

        subtitleLanguages =
            subtitleLanguages.map(
                language =>
                    String(
                        language || ''
                    )
                    .trim()
                    .toLowerCase()
            );


        /*
         * VALIDAR CÓDIGOS
         */

        for (
            const language
            of subtitleLanguages
        ) {

            if (
                !/^[a-z]{2,10}$/.test(
                    language
                )
            ) {

                cleanupFiles([
                    audioFile,
                    coverFile,
                    ...subtitleFiles
                ]);


                return res
                    .status(400)
                    .json({

                        error:
                            `Código de idioma inválido: ${language}`

                    });

            }

        }


        /*
         * EVITAR DUPLICADOS
         */

        if (
            new Set(
                subtitleLanguages
            ).size !==
            subtitleLanguages.length
        ) {

            cleanupFiles([
                audioFile,
                coverFile,
                ...subtitleFiles
            ]);


            return res
                .status(400)
                .json({

                    error:
                        'No puedes subir dos VTT del mismo idioma.'

                });

        }


        /*
         * ÁRABE OBLIGATORIO
         */

        if (
            !subtitleLanguages.includes(
                'ar'
            )
        ) {

            cleanupFiles([
                audioFile,
                coverFile,
                ...subtitleFiles
            ]);


            return res
                .status(400)
                .json({

                    error:
                        'El VTT árabe es obligatorio.'

                });

        }


        /*
         * CREAR NASHEED
         */

        const nasheeds =
            getNasheeds();


        const newTrack = {

            id:
                Date.now(),

            title:
                title,

            file:
                `/uploads/${audioFile.filename}`

        };


        /*
         * CARÁTULA
         */

        if (
            coverFile
        ) {

            newTrack.cover =
                `/uploads/${coverFile.filename}`;

        }


        /*
         * SUBTÍTULOS
         *
         * El orden de req.files y
         * subtitleLanguages es el mismo
         * porque FormData añade los
         * archivos en ese orden.
         */

        newTrack.subtitles =
            {};


        subtitleFiles.forEach(
            (file,index) => {

                const language =
                    subtitleLanguages[
                        index
                    ];


                newTrack.subtitles[
                    language
                ] =
                    `/uploads/${file.filename}`;

            }
        );


        /*
         * GUARDAR
         */

        nasheeds.push(
            newTrack
        );


        saveNasheeds(
            nasheeds
        );


        return res.json({

            success:
                true,

            track:
                newTrack

        });

    }

);


// =========================================================
// LIMPIAR ARCHIVOS
// =========================================================

function cleanupFiles(
    files
) {

    for (
        const file
        of files
    ) {

        if (
            !file ||
            !file.filename
        ) {

            continue;

        }


        const filePath =
            path.join(
                UPLOAD_DIR,
                file.filename
            );


        try {

            if (
                fs.existsSync(
                    filePath
                )
            ) {

                fs.unlinkSync(
                    filePath
                );

            }

        } catch (error) {

            console.error(
                'Error eliminando archivo:',
                error
            );

        }

    }

}


// =========================================================
// ELIMINAR NASHEED
// =========================================================

app.delete(

    '/api/nasheeds/:id',

    requireAdmin,

    (req, res) => {

        const id =
            Number(
                req.params.id
            );


        if (
            !Number.isFinite(id)
        ) {

            return res
                .status(400)
                .json({

                    error:
                        'ID no válido.'

                });

        }


        let nasheeds =
            getNasheeds();


        const track =
            nasheeds.find(
                item =>
                    Number(
                        item.id
                    ) ===
                    id
            );


        if (!track) {

            return res
                .status(404)
                .json({

                    error:
                        'Nasheed no encontrado.'

                });

        }


        /*
         * AUDIO
         */

        deleteUploadedFile(
            track.file,
            'audio'
        );


        /*
         * CARÁTULA
         */

        deleteUploadedFile(
            track.cover,
            'carátula'
        );


        /*
         * SUBTÍTULOS NUEVOS
         */

        if (
            track.subtitles &&
            typeof track.subtitles ===
                'object' &&
            !Array.isArray(
                track.subtitles
            )
        ) {

            Object.values(
                track.subtitles
            ).forEach(
                url => {

                    deleteUploadedFile(
                        url,
                        'subtítulo'
                    );

                }
            );

        }

        /*
         * SUBTÍTULOS ANTIGUOS
         */

        else {

            deleteUploadedFile(
                track.subtitles ||
                track.subtitle ||
                track.vtt ||
                track.vtt_url ||
                track.subtitle_url,

                'subtítulos'
            );

        }


        /*
         * BORRAR REGISTRO
         */

        nasheeds =
            nasheeds.filter(
                item =>
                    Number(
                        item.id
                    ) !==
                    id
            );


        saveNasheeds(
            nasheeds
        );


        return res.json({

            success:
                true

        });

    }

);


// =========================================================
// BORRAR ARCHIVO
// =========================================================

function deleteUploadedFile(
    fileUrl,
    label
) {

    if (
        !fileUrl ||
        typeof fileUrl !==
            'string'
    ) {

        return;

    }


    const filename =
        path.basename(
            fileUrl
        );


    const filePath =
        path.join(
            UPLOAD_DIR,
            filename
        );


    try {

        if (
            fs.existsSync(
                filePath
            )
        ) {

            fs.unlinkSync(
                filePath
            );

        }

    } catch (error) {

        console.error(
            `Error borrando ${label}:`,
            error
        );

    }

}


// =========================================================
// ERRORES MULTER
// =========================================================

app.use(
    (err, req, res, next) => {

        console.error(
            'Error:',
            err
        );


        if (
            err instanceof
            multer.MulterError
        ) {

            return res
                .status(400)
                .json({

                    error:
                        err.message ||
                        'Error al subir los archivos.'

                });

        }


        if (err) {

            return res
                .status(400)
                .json({

                    error:
                        err.message ||
                        'Error al procesar la petición.'

                });

        }


        next();

    }
);


// =========================================================
// INICIAR
// =========================================================

app.listen(
    PORT,
    () => {

        console.log(
            `Servidor Nushud activo en puerto ${PORT}`
        );

    }
);