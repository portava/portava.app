import { Router, type IRouter } from "express";
import healthRouter from "./health";
import tripsRouter from "./trips";

const router: IRouter = Router();

router.use(healthRouter);
router.use(tripsRouter);

export default router;
