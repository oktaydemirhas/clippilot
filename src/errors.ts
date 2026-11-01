/**
 * An error whose message is safe to show to the person who uploaded the video.
 * Everything else (FFmpeg stderr, SDK errors) can contain server paths and is only logged.
 */
export class UserError extends Error {
  override readonly name = "UserError";
}
