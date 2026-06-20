import { Router, type IRouter } from "express";
import healthRouter from "./health";
import tripsRouter from "./trips";
import postsRouter from "./posts";
import followsRouter from "./follows";
import friendsRouter from "./friends";
import profileRouter from "./profile";
import passportRouter from "./passport";

const router: IRouter = Router();

router.use(healthRouter);
router.use(tripsRouter);
router.use(postsRouter);
router.use(followsRouter);
router.use(friendsRouter);
router.use(profileRouter);
router.use(passportRouter);

export default router;
