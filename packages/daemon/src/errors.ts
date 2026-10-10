/** An error that maps to an HTTP status. Thrown anywhere below the HTTP layer. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
