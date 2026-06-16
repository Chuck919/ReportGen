/**
 * pdfjs-dist (via pdf-parse) expects browser globals. Required on Vercel Node.js.
 * Import this module before `pdf-parse` in any server bundle.
 */
import "pdf-parse/worker";
import { DOMMatrix, Image, ImageData, Path2D } from "@napi-rs/canvas";

const g = globalThis as Record<string, unknown>;
g.DOMMatrix = DOMMatrix;
g.Path2D = Path2D;
g.ImageData = ImageData;
g.Image = Image;
