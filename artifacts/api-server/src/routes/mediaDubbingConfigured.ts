import { Router } from "express";
import { getServiceClient } from "../lib/supabase.js";
import { createConfiguredMediaDubbingRouter } from "../lib/media/dubbing/composition.js";

const router = Router();
router.use((request, response, next) => {
  if (!/^\/media\/[^/]+\/dubbing(?:\/|$)/.test(request.path)) { next(); return; }
  const client = getServiceClient();
  if (!client) { response.status(503).json({ error: "media_unavailable" }); return; }
  createConfiguredMediaDubbingRouter({ client })(request, response, next);
});
export default router;
