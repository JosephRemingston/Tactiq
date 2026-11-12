import express from "express";
import { schemas, requestAnalysis, getJob } from "../controllers/jobs.controller.js";
import { authenticate, optionalAuth } from "../middlewares/auth.middleware.js";
import { strictLimit } from "../middlewares/rateLimit.middleware.js";
import { validate } from "../middlewares/validate.middleware.js";

var router = express.Router();

router.post("/matches/:matchId/analysis-jobs", authenticate, strictLimit("analysis-jobs", 10), validate({ params: schemas.matchIdParam }), requestAnalysis);
router.get("/jobs/:jobId", optionalAuth, validate({ params: schemas.jobIdParam }), getJob);

export default router;
