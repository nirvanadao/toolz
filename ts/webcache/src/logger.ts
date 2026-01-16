export interface ILogger {
  debug(message: string, data?: Record<string, unknown>): void
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, data?: Record<string, unknown>): void
  errorWithStack(message: string, error: Error, data?: Record<string, unknown>): void
}

/** A simple logger that logs to the console */
export class ConsoleLogger implements ILogger {
  debug(message: string, data?: Record<string, unknown>): void {
    console.debug(message, data)
  }
  info(message: string, data?: Record<string, unknown>): void {
    console.info(message, data)
  }
  warn(message: string, data?: Record<string, unknown>): void {
    console.warn(message, data)
  }
  error(message: string, data?: Record<string, unknown>): void {
    console.error(message, data)
  }
  errorWithStack(message: string, error: Error, data?: Record<string, unknown>): void {
    console.error(message, data, error)
  }
}
