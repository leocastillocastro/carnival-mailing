import { getMostRecentSentCampaign, getSentCampaignCount, getSubscribedContactCount } from "@carnival/db";
import type { FastifyInstance } from "fastify";
import { sendPage } from "../render.js";

export async function homeRoutes(app: FastifyInstance) {
  app.get("/", async (request, reply) => {
    const [subscriberCount, sentCampaignCount, lastCampaign] = await Promise.all([
      getSubscribedContactCount(),
      getSentCampaignCount(),
      getMostRecentSentCampaign(),
    ]);
    sendPage(request, reply, "home/index", {
      title: "Inicio",
      activeNav: "home",
      subscriberCount,
      sentCampaignCount,
      lastCampaign,
    });
  });
}
