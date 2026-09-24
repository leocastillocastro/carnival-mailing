// Vanilla-JS island: turns the plain <textarea name="htmlContent"> into a
// GrapesJS block editor, so templates get built from content blocks instead
// of hand-written HTML. No build step here — GrapesJS itself is loaded from
// a CDN via <link>/<script> tags in templates/form.eta; this file just wires
// it up to the existing form and upload/gallery endpoints.
//
// The textarea is kept in the DOM (hidden once the editor loads) so its
// value still submits with the form, and so editing still works — as plain
// HTML — if the CDN scripts fail to load for any reason.

// Brand fonts from the client's own identity kit. Two different base URLs on
// purpose: the editor's canvas preview loads them same-origin from apps/admin
// itself (relative path) — the public domain below can't be reached from
// this same LAN/host (the router doesn't support NAT hairpinning), which
// would otherwise silently break font loading for anyone editing from the
// same network as the server. The final saved HTML (real sent emails) needs
// the public apps/api URL instead, since recipients aren't on this LAN.
const LOCAL_FONTS_BASE = "/fonts";
const PUBLIC_FONTS_BASE = "https://mailing.example.com/fonts";
const BRAND_FONTS = [
  { family: "Brothers Regular", file: "brothers-regular.otf", weight: "normal", style: "normal" },
  { family: "Autography", file: "autography.otf", weight: "normal", style: "normal" },
  { family: "Kievit Light", file: "kievit-light.ttf", weight: "normal", style: "normal" },
  { family: "Aharoni Bold", file: "aharoni-bold.ttf", weight: "normal", style: "normal" },
  { family: "Sans Merci", file: "sans-merci-regular.otf", weight: "normal", style: "normal" },
  { family: "Sans Merci", file: "sans-merci-bold.otf", weight: "bold", style: "normal" },
  { family: "Sans Merci", file: "sans-merci-italic.otf", weight: "normal", style: "italic" },
  { family: "Sans Merci", file: "sans-merci-bolditalic.otf", weight: "bold", style: "italic" },
];
// Custom fonts only render in email clients that honor @font-face at all
// (Apple Mail, iOS/macOS Mail, Thunderbird...) — most others (Outlook
// desktop, Gmail's Android app, many webmail clients) silently fall back to
// whatever comes next in the font stack, so every option below always
// includes a decent fallback.
const FONT_FAMILY_OPTIONS = [
  { id: "'Brothers Regular', Georgia, serif", label: "Brothers Regular" },
  { id: "'Autography', cursive", label: "Autography" },
  { id: "'Kievit Light', Helvetica, Arial, sans-serif", label: "Kievit Light" },
  { id: "'Aharoni Bold', Helvetica, Arial, sans-serif", label: "Aharoni Bold" },
  { id: "'Sans Merci', Helvetica, Arial, sans-serif", label: "Sans Merci" },
];

function buildFontFaceCss(baseUrl) {
  return BRAND_FONTS.map(
    (f) =>
      `@font-face { font-family: '${f.family}'; src: url('${baseUrl}/${f.file}'); font-weight: ${f.weight}; font-style: ${f.style}; font-display: swap; }`,
  ).join("\n");
}

const textarea = document.querySelector('textarea[name="htmlContent"]');
const form = textarea ? textarea.closest("form") : null;
const editorRoot = document.getElementById("template-editor-root");

// Warns before leaving with edits that were never saved — covers the plain
// "Nombre" field and (when GrapesJS fails to load) direct edits to the raw
// HTML fallback textarea via native form events; GrapesJS's own edits are
// wired up separately below, since those don't touch the textarea (and so
// don't fire input/change) until the moment the form actually submits.
if (form) {
  let dirty = false;
  form.addEventListener("input", () => {
    dirty = true;
  });
  form.addEventListener("submit", () => {
    dirty = false;
  });
  window.addEventListener("beforeunload", (event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });
  // Exposed so the GrapesJS block below can mark the form dirty too, without
  // duplicating the beforeunload wiring.
  form.markDirty = () => {
    dirty = true;
  };
}

if (textarea && form && editorRoot && typeof grapesjs !== "undefined") {
  const fallbackLabel = textarea.closest("label.html-fallback");

  function extractBody(html) {
    if (!html.trim()) return "";
    return new DOMParser().parseFromString(html, "text/html").body.innerHTML;
  }

  const STARTER_BODY = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafaf9;">
      <tr><td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background:#ffffff;">
          <tr><td style="padding:32px; font-family:Georgia, serif; color:#1c1917; font-size:16px;" data-gjs-type="text">
            Escribí tu contenido acá.
          </td></tr>
        </table>
      </td></tr>
    </table>
  `;

  const editor = grapesjs.init({
    container: "#template-editor-root",
    height: "70vh",
    fromElement: false,
    storageManager: false,
    plugins: ["grapesjs-preset-newsletter"],
    pluginsOpts: {
      "grapesjs-preset-newsletter": {},
    },
    assetManager: {
      assets: [],
      upload: false,
      uploadFile: async (event) => {
        const files = event.dataTransfer ? event.dataTransfer.files : event.target.files;
        for (const file of Array.from(files || [])) {
          try {
            const formData = new FormData();
            formData.append("file", file);
            const res = await fetch("/uploads", { method: "POST", body: formData });
            const data = await res.json();
            if (res.ok) {
              editor.AssetManager.add({ src: data.url, name: file.name });
            } else {
              window.alert(data.error || "Error al subir la imagen");
            }
          } catch {
            window.alert("Error al subir la imagen");
          }
        }
      },
    },
  });

  editor.setComponents(extractBody(textarea.value) || STARTER_BODY);

  // Attached after setComponents() above (not before) so populating the
  // starter block or the template's own saved content doesn't itself count
  // as an edit — only changes the person actually makes from here on do.
  editor.on("update", () => form.markDirty());

  // Both of these have to happen on "load", not right after init(): the
  // newsletter preset sets up its own Style Manager sectors (including this
  // same font-family property) during its own "load"-time setup, which runs
  // after this script's synchronous code and would otherwise wipe out
  // whatever we add here first.
  editor.on("load", () => {
    // Load the brand fonts into the canvas iframe itself, so text using them
    // previews in the real typeface while editing (not just at send time).
    const doc = editor.Canvas.getDocument();
    const style = doc.createElement("style");
    style.textContent = buildFontFaceCss(LOCAL_FONTS_BASE);
    doc.head.appendChild(style);

    // Add the brand fonts to the existing font-family dropdown in the Style
    // Manager, instead of making people type a font name by hand.
    const fontFamilyProp = editor.StyleManager.getProperty("typography", "font-family");
    if (fontFamilyProp) {
      fontFamilyProp.set("options", [...(fontFamilyProp.get("options") || []), ...FONT_FAMILY_OPTIONS]);
    }
  });

  // Blocks for the Handlebars merge tags this project supports — inserting
  // them as blocks means the user never has to type (or mistype) {{...}}.
  const blockManager = editor.BlockManager;
  blockManager.add("saludo-personalizado", {
    label: "Saludo con nombre",
    category: "Variables",
    // Every real template so far needed this exact fallback added by hand —
    // a contact with no first name on file would otherwise get "Hola ,".
    content:
      '<div data-gjs-type="text" style="font-family:Georgia, serif; font-size:18px; padding:0 0 12px;">{{#if contact.firstName}}Hola {{contact.firstName}}{{else}}Hola{{/if}},</div>',
  });
  blockManager.add("pie-de-baja", {
    label: "Pie: darse de baja",
    category: "Variables",
    content:
      '<div data-gjs-type="text" style="font-family:sans-serif; font-size:12px; color:#78716c; text-align:center; padding:24px 16px;">Si no querés recibir más estos correos, <a href="{{unsubscribeUrl}}" style="color:#78716c;">date de baja acá</a>.</div>',
  });
  // Mismo número de WhatsApp que ya usa example.com en su página de
  // contacto — las dudas de los clientes se resuelven ahí, no por el fijo.
  blockManager.add("dudas-whatsapp", {
    label: "Dudas: WhatsApp",
    category: "Variables",
    content:
      '<div data-gjs-type="text" style="font-family:sans-serif; font-size:12px; color:#8a8578; text-align:center; padding:0 0 24px;">¿Dudas con tu pedido? <a href="https://wa.me/34600000000" style="color:#1e2a38;">escribinos por WhatsApp</a></div>',
  });

  // Once GrapesJS is actually up, the raw-HTML fallback is no longer needed.
  // Also drop `required` from the now-hidden textarea: for a brand-new
  // template it starts empty, and the submit handler below only fills it in
  // once the "submit" event fires — but the browser's own required-field
  // check runs BEFORE that event, so it would silently block every first
  // save. Safe to drop because the handler always writes real content back
  // in, whether starting from the starter block or an existing template.
  if (fallbackLabel) fallbackLabel.hidden = true;
  textarea.required = false;

  // Pre-populate the asset manager with photos already on the website, so
  // "elegir una foto" doesn't require uploading anything new. Keeps fetching
  // pages until the gallery itself says there's no more (real total as of
  // writing: ~623 photos) — a fixed page count here previously made
  // everything past it permanently unreachable, with no error or indication
  // that more photos existed.
  //
  // WordPress can fatal-error on one specific page of results (a single
  // corrupted attachment) while every other page is fine — skip a failing
  // page and keep going instead of stopping the whole preload there, same
  // fix already applied to the gallery-picker's own "load more" button.
  let galleryIncomplete = false;
  (async () => {
    const MAX_PAGES = 50;
    const MAX_CONSECUTIVE_FAILURES = 5;
    let consecutiveFailures = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      try {
        const res = await fetch(`/uploads/gallery?page=${page}`);
        if (!res.ok) throw new Error(`gallery page ${page} failed`);
        const data = await res.json();
        editor.AssetManager.add(data.items.map((item) => ({ src: item.url, name: item.title })));
        consecutiveFailures = 0;
        if (!data.hasMore) return;
      } catch {
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
      }
    }
    // Loop ended without WordPress ever confirming hasMore:false — some
    // pages were skipped for good and the gallery is missing photos, with
    // no other indication of that anywhere in the UI otherwise.
    galleryIncomplete = true;
  })();

  // GrapesJS's default asset picker has no search/filter at all — with ~600
  // real photos and only a raw URL-paste field otherwise, finding one by
  // eye means scrolling through the entire, unfiltered list. Re-injected on
  // every open since the modal's contents get rebuilt each time.
  editor.on("asset:open", () => {
    requestAnimationFrame(() => {
      const header = document.querySelector(".gjs-am-assets-header");
      const assetsContainer = document.querySelector(".gjs-am-assets");
      if (!header || !assetsContainer) return;

      if (galleryIncomplete && !header.querySelector(".carnival-asset-warning")) {
        const warning = document.createElement("div");
        warning.className = "carnival-asset-warning";
        warning.style.cssText = "color:#92400e; background:#fffbeb; border:1px solid #fde68a; border-radius:4px; padding:6px 8px; margin-bottom:8px; font-size:12px;";
        warning.textContent = "No se pudieron cargar todas las fotos de la web — probá recargar la página.";
        header.insertBefore(warning, header.firstChild);
      }

      if (!header.querySelector(".carnival-asset-search")) {
        const search = document.createElement("input");
        search.type = "search";
        search.placeholder = "Buscar por nombre…";
        search.className = "carnival-asset-search";
        search.style.cssText = "width:100%; box-sizing:border-box; padding:6px; margin-bottom:8px;";
        search.addEventListener("input", () => {
          const query = search.value.trim().toLowerCase();
          assetsContainer.querySelectorAll(".gjs-am-asset").forEach((assetEl) => {
            const name = assetEl.querySelector(".gjs-am-name");
            const matches = !query || (name && name.textContent.toLowerCase().includes(query));
            assetEl.style.display = matches ? "" : "none";
          });
        });
        header.insertBefore(search, header.firstChild);
      }
    });
  });

  // Serialize the design into the hidden textarea right before the form's
  // normal (non-AJAX) POST — inlined styles, since that's what actually
  // survives real email clients.
  form.addEventListener("submit", () => {
    const inlinedBody = editor.runCommand("gjs-get-inlined-html");
    // @font-face can't be inlined onto an element the way other CSS is (it's
    // not scoped to one), so it has to survive as its own <style> block —
    // written in ourselves rather than trusting the inliner to keep it.
    textarea.value =
      '<!doctype html>\n<html lang="es">\n<head>\n<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      `<style>${buildFontFaceCss(PUBLIC_FONTS_BASE)}</style>\n</head>\n` +
      inlinedBody +
      "\n</html>";
  });
}
