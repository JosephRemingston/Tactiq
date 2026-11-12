import express from "express";
import { health, ready } from "../controllers/health.controller.js";

var router = express.Router();

router.get("/healthz", health);
router.get("/readyz", ready);

export default router;
