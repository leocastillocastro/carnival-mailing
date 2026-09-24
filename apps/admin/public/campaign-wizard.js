// Splits the campaign form into two named, freely-navigable steps — purely a
// display concern, layered on top of the same single <form>/POST/validation
// campaigns.ts already had. Two steps, not more: Listmonk (name/subject/
// from/audience, then a separate content screen) and Keila (one continuous
// screen) both skip the multi-step wizard pattern entirely for this exact
// kind of broadcast-email flow — a forced linear sequence is Mautic's
// campaign-builder territory (multi-branch automations), and its own users
// report losing track of which step/campaign they're in. Steps here aren't
// gated in order either, for the same reason: editing an existing campaign
// often means jumping straight to one field, not re-walking the whole thing.

const form = document.querySelector("form[data-wizard]");

if (form) {
  const steps = Array.from(form.querySelectorAll(".wizard-step"));
  const tabs = Array.from(document.querySelectorAll(".wizard-tab"));
  const submitButton = form.querySelector('button[type="submit"]');

  function showStep(n) {
    for (const step of steps) {
      step.hidden = Number(step.dataset.step) !== n;
    }
    for (const tab of tabs) {
      tab.classList.toggle("active", Number(tab.dataset.stepLink) === n);
    }
  }

  for (const tab of tabs) {
    tab.addEventListener("click", () => showStep(Number(tab.dataset.stepLink)));
  }
  for (const button of form.querySelectorAll("[data-goto]")) {
    button.addEventListener("click", () => showStep(Number(button.dataset.goto)));
  }

  // Native constraint validation treats a required field inside a hidden
  // step as blocking "Guardar" with no visible error — the field can't be
  // pointed at if it's hidden (same gotcha the list/segment toggle above
  // already has to work around). Un-hiding every step right on the submit
  // button's click, before that native check runs, means validation lands
  // on the real, now-visible field instead — same behavior the form had
  // before it was split into steps.
  if (submitButton) {
    submitButton.addEventListener("click", () => {
      for (const step of steps) step.hidden = false;
      for (const tab of tabs) tab.classList.remove("active");
    });
  }

  // A validation error from step 2 (the per-template content fields) used
  // to reload the form sitting on step 1 regardless — the error banner
  // named the exact problem, but right next to fields that all looked
  // fine, with no hint the real issue was one tab over. The server knows
  // which step actually failed (see CampaignFormError in campaigns.ts) and
  // passes it through this data attribute.
  showStep(Number(form.dataset.initialStep) || 1);
}
