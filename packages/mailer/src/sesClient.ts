import { SESv2Client } from "@aws-sdk/client-sesv2";

const region = process.env.SES_REGION;
if (!region) {
  throw new Error("SES_REGION is not set");
}

export const sesClient = new SESv2Client({ region });
