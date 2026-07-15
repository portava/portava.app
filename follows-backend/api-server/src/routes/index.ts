import { Router, type IRouter } from "express";
import healthRouter from "./health";
import tripsRouter from "./trips";
import postsRouter from "./posts";
import followsRouter from "./follows";

const router: IRouter = Router();

router.use(healthRouter);
router.use(tripsRouter);
router.use(postsRouter);
router.use(followsRouter);

export default router;
