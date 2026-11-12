import express from "express";
import { schemas, listProducts, getSubscription, verifyGooglePlayPurchase, restorePurchases } from "../controllers/billing.controller.js";
import { authenticate, optionalAuth } from "../middlewares/auth.middleware.js";
import { strictLimit } from "../middlewares/rateLimit.middleware.js";
import { validate } from "../middlewares/validate.middleware.js";

var router = express.Router();

router.get("/products", optionalAuth, listProducts);
router.get("/subscription", authenticate, getSubscription);
router.post("/google-play/verify", authenticate, strictLimit("billing-verify", 20), validate({ body: schemas.verifyBody }), verifyGooglePlayPurchase);
router.post("/restore", authenticate, strictLimit("billing-restore", 10), restorePurchases);

export default router;
