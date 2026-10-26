// Loaded on demand by the floating widget (dynamic import), so pages only pay for the PDF library when it's used.
import { renderPdf } from "./lib/templates.js";

export const cvPdfBlob = (md, tpl) => renderPdf(md, tpl).output("blob");
