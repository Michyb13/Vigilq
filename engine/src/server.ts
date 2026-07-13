import Fastify, { FastifyRequest, FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { verifyApiKey } from "./apiKey.js";
import {
  enqueue,
  claimJob,
  completeJob,
  failJob,
  renewLease,
  getJobById,
  listJobs,
  getPoolDepths,
  getStatusCounts,
  getJobAttempts,
  getTriageForJob,
} from "./queue.js";
import type { JobStatus } from "./db.js";

declare module "fastify" {
  interface FastifyRequest {
    tenantId: string;
  }
}

export function buildServer() {
  const app = Fastify({ logger: true });

  const dashboardDistPath =
    process.env.DASHBOARD_DIST_PATH ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dashboard", "out");

  // The dashboard's static files (HTML/JS/CSS) are served publicly —
  // there's no server-side session to check here, since the queue API key
  // is entered and verified client-side, in the browser, before any real
  // API call is made. Only the actual JSON endpoints below need the key.
  app.register(fastifyStatic, {
    root: dashboardDistPath,
    prefix: "/dashboard/",
    redirect: true, // GET /dashboard (no trailing slash) -> redirects to /dashboard/, which actually matches
  });

  // Every route except /health and /dashboard/* requires a valid API key.
  // The key resolves to a tenant, and every query from here on is scoped
  // to that tenant — this is the enforcement point for the tenant-isolation
  // fix we made earlier in claimJob()/getJobById().
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    // /favicon.ico: browsers probe this at the domain root automatically,
    // separate from the dashboard's own /dashboard/favicon.ico — excluded
    // so that harmless probe doesn't show up as a 401 in the logs.
    if (request.url === "/health" || request.url === "/favicon.ico" || request.url.startsWith("/dashboard")) return;

    const authHeader = request.headers.authorization;
    const rawKey = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;

    if (!rawKey) {
      return reply.code(401).send({ error: "Missing Authorization: Bearer <api key>" });
    }

    const result = await verifyApiKey(rawKey);
    if (!result) {
      return reply.code(401).send({ error: "Invalid or revoked API key" });
    }

    request.tenantId = result.tenantId;
  });

  app.get("/health", async () => ({ status: "ok" }));

  // --- enqueue ---
  const enqueueSchema = z.object({
    jobType: z.string().min(1),
    payload: z.unknown(),
    pool: z.string().optional(),
    priority: z.number().int().optional(),
    maxAttempts: z.number().int().positive().optional(),
    dedupeKey: z.string().optional(),
    runAfter: z.coerce.date().optional(),
  });

  app.post("/jobs", async (request, reply) => {
    const parsed = enqueueSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { jobType, payload, ...opts } = parsed.data;
    const job = await enqueue(request.tenantId, jobType, payload, opts);

    if (!job) {
      // dedupeKey collision — not an error, just "already exists"
      return reply.code(200).send({ enqueued: false, reason: "duplicate dedupeKey" });
    }
    return reply.code(201).send({ enqueued: true, job });
  });

  // --- list jobs ---
  const listQuerySchema = z.object({
    status: z.enum(["pending", "running", "completed", "failed", "dead_letter"]).optional(),
    pool: z.string().optional(),
    jobType: z.string().optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  });

  app.get("/jobs", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const jobs = await listJobs(request.tenantId, parsed.data as { status?: JobStatus; pool?: string; jobType?: string; limit?: number });
    return { jobs };
  });

  // --- get one job ---
  app.get("/jobs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await getJobById(request.tenantId, id);
    if (!job) return reply.code(404).send({ error: "Job not found" });
    return { job };
  });

  // --- claim ---
  const claimSchema = z.object({
    workerId: z.string().min(1),
    pool: z.string().optional(),
    jobTypes: z.array(z.string()).optional(),
    leaseSeconds: z.number().int().positive().optional(),
  });

  app.post("/jobs/claim", async (request, reply) => {
    const parsed = claimSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { workerId, ...opts } = parsed.data;
    const job = await claimJob(request.tenantId, workerId, opts);

    if (!job) return reply.code(204).send();
    return { job };
  });

  // --- renew lease ---
  const renewSchema = z.object({
    workerId: z.string().min(1),
    leaseSeconds: z.number().int().positive().optional(),
  });

  app.post("/jobs/:id/renew", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = renewSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const job = await getJobById(request.tenantId, id);
    if (!job) return reply.code(404).send({ error: "Job not found" });

    const renewed = await renewLease(id, parsed.data.workerId, parsed.data.leaseSeconds);
    if (!renewed) {
      return reply.code(409).send({ error: "Lease not renewed — job is not running or held by a different worker" });
    }
    return { renewed: true };
  });

  // --- complete ---
  const completeSchema = z.object({ workerId: z.string().min(1) });

  app.post("/jobs/:id/complete", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = completeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const job = await getJobById(request.tenantId, id);
    if (!job) return reply.code(404).send({ error: "Job not found" });

    await completeJob(job, parsed.data.workerId);
    return { completed: true };
  });

  // --- fail ---
  const failSchema = z.object({
    workerId: z.string().min(1),
    errorMessage: z.string().min(1),
    errorStack: z.string().optional(),
  });

  app.post("/jobs/:id/fail", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = failSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const job = await getJobById(request.tenantId, id);
    if (!job) return reply.code(404).send({ error: "Job not found" });

    const error = new Error(parsed.data.errorMessage);
    if (parsed.data.errorStack) error.stack = parsed.data.errorStack;

    const result = await failJob(job, parsed.data.workerId, error);
    return { ...result };
  });

  // --- pool depths (autoscaler polls this) ---
  app.get("/pools/depths", async (request) => {
    const depths = await getPoolDepths(request.tenantId);
    return { depths };
  });

  // --- status counts (dashboard overview tiles) ---
  app.get("/jobs/stats/status-counts", async (request) => {
    const counts = await getStatusCounts(request.tenantId);
    return { counts };
  });

  // --- attempt history for one job (dashboard job detail view) ---
  app.get("/jobs/:id/attempts", async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await getJobById(request.tenantId, id);
    if (!job) return reply.code(404).send({ error: "Job not found" });

    const attempts = await getJobAttempts(request.tenantId, id);
    return { attempts };
  });

  // --- Claude's triage result for a dead-lettered job (dashboard DLQ view) ---
  app.get("/jobs/:id/triage", async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await getJobById(request.tenantId, id);
    if (!job) return reply.code(404).send({ error: "Job not found" });

    const triage = await getTriageForJob(request.tenantId, id);
    if (!triage) return reply.code(404).send({ error: "No triage result yet for this job" });
    return { triage };
  });

  return app;
}
