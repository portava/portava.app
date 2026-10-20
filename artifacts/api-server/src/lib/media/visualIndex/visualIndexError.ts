import { MediaJobError } from "../jobs/queue.js";

export class VisualIndexError extends MediaJobError {
  constructor(code: string, message: string, retryable = false) {
    super(code, retryable);
    this.message = message;
  }
}
