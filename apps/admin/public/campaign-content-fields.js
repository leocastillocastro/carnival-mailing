// Turns a template's {{campaign.*}} tags into a plain fill-in-the-blank form —
// so setting up a campaign is "escribí el título, el precio, el texto" instead
// of editing HTML. Field list comes from the server (/campaigns/template-fields,
// derived from extractCampaignFieldNames), which changes whenever the chosen
// template changes; values are kept here in `state` and serialized into the
// hidden #contentFieldsInput right before submit, same pattern segment-builder.js
// uses for its own dynamic definition field.

const FIELD_LABELS = {
  eyebrow: "Categoría / línea superior",
  titulo: "Título",
  precio: "Precio",
  preheader: "Vista previa en la bandeja de entrada (preheader)",
  imagen: "Foto del producto",
  texto: "Texto de la promo",
  fecha: "Fecha límite de la oferta",
  descuento: "Descuento (%)",
};

// Only the fields where getting it wrong is easy and costly enough to spell
// out — most fields (título, precio) are self-explanatory from the label.
const FIELD_HINTS = {
  preheader: "Es lo que se ve junto al asunto en la bandeja de entrada, antes de abrir el correo — sumá algo nuevo, no repitas el asunto.",
  imagen: "Mejor el plato ya preparado o el corte prolijo — evitá primeros planos con sangre visible o cortes muy crudos, pueden incomodar a algunos clientes.",
};

// Ideal character range per field, shown as a live counter next to its hint.
// Gmail/Outlook truncan el preheader bastante antes de los 90 — por debajo de
// 40 se ve como que falta texto (Gmail rellena con el resto del cuerpo del mail).
const FIELD_LENGTH_RANGES = {
  preheader: { min: 40, max: 90 },
};

function labelFor(name) {
  return FIELD_LABELS[name] || name.charAt(0).toUpperCase() + name.slice(1);
}

const templateSelect = document.getElementById("templateId");
const section = document.getElementById("contentFieldsSection");
const hiddenInput = document.getElementById("contentFieldsInput");
const dataEl = document.getElementById("campaign-content-fields-data");

let state = dataEl ? JSON.parse(dataEl.textContent) : {};

function buildFieldHint(field, input) {
  const range = FIELD_LENGTH_RANGES[field.name];
  const baseText = FIELD_HINTS[field.name];
  if (!baseText && !range) return null;

  const hint = document.createElement("p");
  hint.className = "field-hint";

  function render() {
    const length = input.value.length;
    let text = baseText || "";
    if (range) {
      const inRange = length >= range.min && length <= range.max;
      text += `${text ? " " : ""}(${length} caracteres — ideal: ${range.min}–${range.max})`;
      hint.style.color = length === 0 || inRange ? "" : "var(--accent)";
    }
    hint.textContent = text;
  }

  input.addEventListener("input", render);
  render();
  return hint;
}

function buildTextField(field) {
  const label = document.createElement("label");
  const span = document.createElement("span");
  span.textContent = labelFor(field.name);
  const input = document.createElement("input");
  input.type = "text";
  input.value = state[field.name] || "";
  input.addEventListener("input", () => {
    state[field.name] = input.value;
  });
  label.append(span, input);

  const wrapper = document.createDocumentFragment();
  wrapper.append(label);
  const hint = buildFieldHint(field, input);
  if (hint) wrapper.append(hint);
  return wrapper;
}

function buildTextareaField(field) {
  const label = document.createElement("label");
  const span = document.createElement("span");
  span.textContent = labelFor(field.name);
  const textarea = document.createElement("textarea");
  textarea.style.minHeight = "5rem";
  textarea.style.fontFamily = "inherit";
  textarea.value = state[field.name] || "";
  textarea.addEventListener("input", () => {
    state[field.name] = textarea.value;
  });
  label.append(span, textarea);
  return label;
}

function buildImageField(field) {
  const label = document.createElement("label");
  const span = document.createElement("span");
  span.textContent = labelFor(field.name);
  const row = document.createElement("div");
  row.style.cssText = "display:flex; gap:0.6rem; align-items:center;";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "URL de la foto";
  input.style.flex = "1";
  input.value = state[field.name] || "";
  const preview = document.createElement("img");
  preview.style.cssText = "width:2.5rem; height:2.5rem; object-fit:cover; border-radius:0.3rem; border:1px solid #e5e0d8; display:" + (input.value ? "block" : "none");
  preview.src = input.value;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary";
  button.textContent = "Elegir foto";
  function setValue(url) {
    input.value = url;
    state[field.name] = url;
    preview.src = url;
    preview.style.display = url ? "block" : "none";
  }
  input.addEventListener("input", () => setValue(input.value));
  button.addEventListener("click", () => openImagePicker(setValue));
  row.append(preview, input, button);
  label.append(span, row);

  const wrapper = document.createDocumentFragment();
  wrapper.append(label);
  const hint = buildFieldHint(field, input);
  if (hint) wrapper.append(hint);
  return wrapper;
}

function renderFields(fields) {
  section.innerHTML = "";
  for (const field of fields) {
    if (field.kind === "textarea") section.appendChild(buildTextareaField(field));
    else if (field.kind === "image") section.appendChild(buildImageField(field));
    else section.appendChild(buildTextField(field));
  }
}

// Guards against an out-of-order response: if the user switches templates
// twice quickly, nothing guarantees the fetches resolve in the order they
// were sent — without this, the fields shown could belong to whichever
// template's request happened to respond last, not the one currently
// selected. Same pattern already used by updateAudienceCount (this eta's own
// inline script) and segment-builder.js's previewCount.
let loadRequestId = 0;

async function loadFieldsForTemplate(templateId) {
  const thisRequest = ++loadRequestId;
  if (!templateId) {
    section.innerHTML = "";
    return;
  }
  try {
    const res = await fetch(`/campaigns/template-fields?templateId=${encodeURIComponent(templateId)}`);
    const data = await res.json();
    if (thisRequest !== loadRequestId) return;
    renderFields(data.fields || []);
  } catch {
    if (thisRequest !== loadRequestId) return;
    section.innerHTML = "";
  }
}

templateSelect.addEventListener("change", () => loadFieldsForTemplate(templateSelect.value));
loadFieldsForTemplate(templateSelect.value);

const form = templateSelect.closest("form");
form.addEventListener("submit", () => {
  hiddenInput.value = JSON.stringify(state);
});

// Lightweight photo picker reusing the same WordPress gallery endpoint the
// GrapesJS template editor uses — a full copy of that editor's asset manager
// would be overkill for filling in one URL field.
let galleryItems = [];
let galleryPage = 1;
let galleryDone = false;

async function loadNextGalleryPage() {
  if (galleryDone) return;
  try {
    const res = await fetch(`/uploads/gallery?page=${galleryPage}`);
    if (!res.ok) throw new Error("gallery page failed");
    const data = await res.json();
    galleryItems = galleryItems.concat(data.items);
    galleryPage += 1;
    if (!data.hasMore) galleryDone = true;
  } catch {
    galleryDone = true;
  }
}

function openImagePicker(onSelect) {
  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed; inset:0; background:rgba(30,42,56,0.5); z-index:1000; display:flex; align-items:center; justify-content:center;";

  const modal = document.createElement("div");
  modal.style.cssText =
    "background:#fff; border-radius:0.5rem; width:min(40rem, 90vw); max-height:80vh; display:flex; flex-direction:column; padding:1rem;";

  const header = document.createElement("div");
  header.style.cssText = "display:flex; gap:0.5rem; margin-bottom:0.75rem;";
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Buscar por nombre…";
  search.style.flex = "1";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "secondary";
  closeBtn.textContent = "Cerrar";
  closeBtn.addEventListener("click", () => overlay.remove());
  header.append(search, closeBtn);

  const grid = document.createElement("div");
  grid.style.cssText = "overflow-y:auto; display:grid; grid-template-columns:repeat(auto-fill, minmax(6rem, 1fr)); gap:0.5rem; flex:1;";

  const moreBtn = document.createElement("button");
  moreBtn.type = "button";
  moreBtn.className = "secondary";
  moreBtn.textContent = "Cargar más fotos";
  moreBtn.style.marginTop = "0.75rem";

  function renderGrid() {
    const query = search.value.trim().toLowerCase();
    grid.innerHTML = "";
    for (const item of galleryItems) {
      if (query && !item.title.toLowerCase().includes(query)) continue;
      const thumb = document.createElement("img");
      thumb.src = item.thumbnailUrl || item.url;
      thumb.title = item.title;
      thumb.style.cssText = "width:100%; aspect-ratio:1; object-fit:cover; border-radius:0.3rem; cursor:pointer; border:1px solid #e5e0d8;";
      thumb.addEventListener("click", () => {
        onSelect(item.url);
        overlay.remove();
      });
      grid.appendChild(thumb);
    }
  }

  search.addEventListener("input", renderGrid);
  moreBtn.addEventListener("click", async () => {
    moreBtn.disabled = true;
    moreBtn.textContent = "Cargando…";
    await loadNextGalleryPage();
    renderGrid();
    moreBtn.disabled = false;
    moreBtn.textContent = "Cargar más fotos";
    if (galleryDone) moreBtn.remove();
  });

  modal.append(header, grid, moreBtn);
  overlay.appendChild(modal);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) overlay.remove();
  });
  document.body.appendChild(overlay);

  if (galleryItems.length === 0) {
    loadNextGalleryPage().then(renderGrid);
  } else {
    renderGrid();
  }
}
