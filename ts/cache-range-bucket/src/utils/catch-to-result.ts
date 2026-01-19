import { AsyncResult, AsyncResultWrapper } from "ts-async-results";
import { Err, Ok, Result } from "ts-results";

export async function catchToResult<T, EOut, EInner = Error>(p: Promise<T>, errorMapper: (e: EInner) => EOut): Promise<Result<T, EOut>> {
  try {
    const d = await p
    return Ok(d)
  } catch (e) {
    return Err(errorMapper(e as EInner))
  }
}

export function toAsyncResult<T, EOut, EInner = Error>(fn: () => Promise<T>, errorMapper: (e: EInner) => EOut): AsyncResult<T, EOut> {
  const p = fn().then(v => Ok(v)).catch(e => Err(errorMapper(e as EInner)))
  return new AsyncResultWrapper(p)
}

// Helper: Takes a Result, runs an async function on the success value, 
// and returns a Promise<Result>
export async function andThenAsync<T, E, U>(
  result: Result<T, E>,
  asyncFn: (val: T) => Promise<Result<U, E>>
): Promise<Result<U, E>> {
  if (result.err) {
    return Err(result.val);
  }
  return await asyncFn(result.val);
}