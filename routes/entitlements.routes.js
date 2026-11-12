import express from "express";
import { listEntitlements } from "../controllers/entitlements.controller.js";
import { authenticate } from "../middlewares/auth.middleware.js";

var router = express.Router();

router.get("/entitlements", authenticate, listEntitlements);

export default router;
