/**
 * Validador de tipos MIME
 * Verifica magic bytes (firma binaria) de archivos
 */

/**
 * Magic bytes para tipos de archivo comunes
 * https://en.wikipedia.org/wiki/List_of_file_signatures
 */
const MAGIC_BYTES = {
  // Imágenes
  jpeg: [0xff, 0xd8, 0xff],
  png: [0x89, 0x50, 0x4e, 0x47],
  gif: [0x47, 0x49, 0x46],
  webp: [0x52, 0x49, 0x46, 0x46], // RIFF + WEBP
  bmp: [0x42, 0x4d],
  tiff_little: [0x49, 0x49, 0x2a, 0x00],
  tiff_big: [0x4d, 0x4d, 0x00, 0x2a],

  // Documentos
  pdf: [0x25, 0x50, 0x44, 0x46], // %PDF
  xlsx: [0x50, 0x4b, 0x03, 0x04], // ZIP
  xls_old: [0xd0, 0xcf, 0x11, 0xe0],
  docx: [0x50, 0x4b, 0x03, 0x04], // ZIP

  // Vídeos
  mp4: [0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70],
  mov: [0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70],
  avi: [0x52, 0x49, 0x46, 0x46], // RIFF

  // Audio
  mp3: [0xff, 0xfb], // MPEG
  wav: [0x52, 0x49, 0x46, 0x46], // RIFF
  m4a: [0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70],

  // Ejecutables (PROHIBIR)
  exe: [0x4d, 0x5a], // MZ
  dll: [0x4d, 0x5a], // MZ
  bat: [0x3a, 0x20],
  cmd: [0x3a, 0x20],
};

/**
 * MIME types permitidos para uploads de evidencia
 */
const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/tiff",
  "application/pdf",
  "video/mp4",
  "video/quicktime",
  "video/x-msvideo",
  "audio/mpeg",
  "audio/wav",
  "audio/m4a",
];

/**
 * Extensiones permitidas
 */
const ALLOWED_EXTENSIONS = [
  // Imágenes
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "bmp",
  "tif",
  "tiff",

  // Documentos
  "pdf",

  // Vídeos
  "mp4",
  "mov",
  "avi",

  // Audio
  "mp3",
  "wav",
  "m4a",
];

/**
 * Extensiones prohibidas explícitamente
 */
const BLOCKED_EXTENSIONS = [
  "exe",
  "dll",
  "bat",
  "cmd",
  "com",
  "pif",
  "scr",
  "vbs",
  "js",
  "jar",
  "zip",
  "rar",
  "7z",
];

/**
 * Valida un archivo por MIME type
 * @param {Buffer} buffer - Contenido del archivo
 * @param {string} mimeType - MIME type declarado
 * @param {string} [filename] - Nombre del archivo (para validar extensión)
 * @returns {Object} { valid: boolean, reason?: string, mimeType?: string }
 */
export function validateFileMimeType(buffer, mimeType, filename) {
  if (!buffer || buffer.length === 0) {
    return { valid: false, reason: "Archivo vacío" };
  }

  // Validar extensión si se proporciona filename
  if (filename) {
    const ext = filename.split(".").pop()?.toLowerCase();

    if (BLOCKED_EXTENSIONS.includes(ext)) {
      return {
        valid: false,
        reason: `Tipo de archivo no permitido: .${ext}`,
      };
    }

    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return {
        valid: false,
        reason: `Extensión no permitida: .${ext}`,
      };
    }
  }

  // Validar MIME type declarado
  if (mimeType && !ALLOWED_MIME_TYPES.includes(mimeType)) {
    return {
      valid: false,
      reason: `MIME type no permitido: ${mimeType}`,
    };
  }

  // Validar magic bytes
  const firstBytes = buffer.slice(0, 8);
  const isValidMagic = validateMagicBytes(firstBytes, mimeType);

  if (!isValidMagic) {
    return {
      valid: false,
      reason: `Firma de archivo inválida. El contenido no coincide con el tipo declarado: ${mimeType}`,
    };
  }

  return {
    valid: true,
    mimeType: mimeType || "application/octet-stream",
  };
}

/**
 * Valida magic bytes de un archivo
 */
function validateMagicBytes(buffer, declaredMimeType) {
  if (!buffer || buffer.length === 0) return false;

  const bytes = Array.from(buffer);

  // Verificar si es un ejecutable disfrazado
  if (isExecutable(bytes)) {
    return false;
  }

  // Si no hay MIME type declarado, permitir (confiamos en Cloudinary)
  if (!declaredMimeType) {
    return true;
  }

  // Mapear MIME type a magic bytes esperados
  const expectedMagic = getMagicBytesForMimeType(declaredMimeType);

  if (!expectedMagic || expectedMagic.length === 0) {
    // MIME type no conocido, permitir
    return true;
  }

  // Verificar si los primeros bytes coinciden con alguno esperado
  return expectedMagic.some((magic) => matchesBytes(bytes, magic));
}

/**
 * Obtiene los magic bytes esperados para un MIME type
 */
function getMagicBytesForMimeType(mimeType) {
  const mimeToMagic = {
    "image/jpeg": [MAGIC_BYTES.jpeg],
    "image/png": [MAGIC_BYTES.png],
    "image/gif": [MAGIC_BYTES.gif],
    "image/webp": [MAGIC_BYTES.webp],
    "image/bmp": [MAGIC_BYTES.bmp],
    "image/tiff": [MAGIC_BYTES.tiff_little, MAGIC_BYTES.tiff_big],
    "application/pdf": [MAGIC_BYTES.pdf],
    "video/mp4": [MAGIC_BYTES.mp4],
    "video/quicktime": [MAGIC_BYTES.mov],
    "video/x-msvideo": [MAGIC_BYTES.avi],
    "audio/mpeg": [MAGIC_BYTES.mp3],
    "audio/wav": [MAGIC_BYTES.wav],
    "audio/m4a": [MAGIC_BYTES.m4a],
  };

  return mimeToMagic[mimeType] || [];
}

/**
 * Verifica si los bytes coinciden con la firma esperada
 */
function matchesBytes(buffer, expectedMagic) {
  if (buffer.length < expectedMagic.length) return false;

  return expectedMagic.every((byte, index) => buffer[index] === byte);
}

/**
 * Detecta si un archivo es ejecutable
 */
function isExecutable(bytes) {
  const dangerous = [
    MAGIC_BYTES.exe, // MZ (exe, dll)
    MAGIC_BYTES.bat, // :  (batch)
  ];

  return dangerous.some((magic) => matchesBytes(bytes, magic));
}

/**
 * Obtiene una lista de MIME types permitidos (para documentación)
 */
export function getAllowedMimeTypes() {
  return ALLOWED_MIME_TYPES;
}

/**
 * Obtiene una lista de extensiones permitidas (para documentación)
 */
export function getAllowedExtensions() {
  return ALLOWED_EXTENSIONS;
}
