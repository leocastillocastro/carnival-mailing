// env.ts validates these via zod at import time — none of these are real, since
// @carnival/db is mocked out in every route test, so no real DB/WC connection ever happens.
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.WC_URL ??= "https://example.test";
process.env.WC_CONSUMER_KEY ??= "test-consumer-key";
process.env.WC_CONSUMER_SECRET ??= "test-consumer-secret";
process.env.WC_WEBHOOK_SECRET ??= "test-webhook-secret";
process.env.SES_WEBHOOK_TOKEN ??= "test-ses-webhook-token-1234567890";
process.env.SES_SNS_TOPIC_ARN ??= "arn:aws:sns:eu-west-1:123456789012:test-topic";
process.env.SES_REGION ??= "eu-west-1"; // @carnival/mailer reads this at import time
process.env.PORT ??= "3000";
