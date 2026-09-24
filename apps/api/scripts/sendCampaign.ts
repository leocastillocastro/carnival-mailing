// Must load before @carnival/db/@carnival/queue are imported below — they read
// DATABASE_URL/REDIS_URL from process.env at module-evaluation time.
import "dotenv/config";
import { enqueueCampaignSends } from "@carnival/campaigns";
import { finalizeCampaignIfDone, markCampaignSending, pool, revertCampaignStatus } from "@carnival/db";

const campaignId = Number(process.argv[2]);
if (!campaignId) {
  console.error("usage: pnpm sendCampaign -- <campaignId>");
  process.exit(1);
}

async function main() {
  // Same three-step sequence the admin's "Enviar ahora" button uses — without
  // markCampaignSending/finalizeCampaignIfDone here, a campaign sent through
  // this script never gets its status updated at all, and one with a
  // zero-contact audience (no worker event ever fires) stays wherever it was
  // forever.
  await markCampaignSending(campaignId);
  try {
    const { queuedCount, audienceSize } = await enqueueCampaignSends(campaignId);
    console.log(`enqueued ${queuedCount} sends for campaign ${campaignId} (${audienceSize} recipients matched)`);
    await finalizeCampaignIfDone(campaignId);
  } catch (err) {
    await revertCampaignStatus(campaignId, "draft");
    throw err;
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
