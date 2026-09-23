import multer from "multer";
import { HttpError } from "./http.js";

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp|heic|heif|avif|gif|tiff)$/.test(file.mimetype)) cb(null, true);
    else cb(new HttpError(400, `Dateityp ${file.mimetype} wird nicht unterstützt`));
  },
});
