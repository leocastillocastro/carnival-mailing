// env.ts validates these via zod at import time — none of these are real, since
// @carnival/db (and @carnival/campaigns' enqueueCampaignSends) are mocked out
// in every route test, so no real DB/Redis connection ever happens.
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.PORT ??= "3001";
process.env.UPLOADS_PUBLIC_URL ??= "https://mailing.example.test";
process.env.WORDPRESS_URL ??= "https://example.test";
