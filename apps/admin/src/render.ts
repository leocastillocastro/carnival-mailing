import type { FastifyReply, FastifyRequest } from "fastify";
import { campaignStatusLabel, contactStatusLabel, listOptinLabel, sendStatusLabel } from "./labels.js";
import { renderPage, type PageData } from "./view.js";

/** Every protected page needs `it.user` for the layout's nav/logout button,
 * and the enum-label helpers so a view can translate a raw status/optin
 * value without every route handler having to reshape its data — this folds
 * both in so route handlers don't have to repeat them. */
export function sendPage(request: FastifyRequest, reply: FastifyReply, view: string, data: PageData): void {
  reply.type("text/html").send(
    renderPage(view, {
      ...data,
      user: request.sessionUser,
      campaignStatusLabel,
      sendStatusLabel,
      listOptinLabel,
      contactStatusLabel,
    }),
  );
}
