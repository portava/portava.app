import type { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * Loose function type that accepts any async route handler.
 *
 * Using `any` for req/res avoids conflicts with Express 5's stricter
 * `ParamsDictionary` typing (`string | string[]`).  When a callback is
 * passed through asyncHandler the route-level type inference is lost, but
 * the runtime behaviour is identical and TypeScript still checks the handler
 * body's own explicit usages via the outer router.get/post/etc. overloads.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAsyncHandler = (req: any, res: any, next: NextFunction) => Promise<unknown> | unknown;

/**
 * Wraps an async route handler so that any thrown error or rejected Promise
 * is forwarded to Express's `next(err)` error pipeline.
 *
 * Express 5 already handles async rejections natively; this wrapper makes
 * the intent explicit and ensures the global error handler is always reached.
 */
export function asyncHandler(fn: AnyAsyncHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
