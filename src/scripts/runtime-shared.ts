export function formatUnknownRuntimeError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

export async function sendIpcResponse(message: unknown): Promise<void> {
  if (!process.send) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const send = process.send as unknown as (
      payload: unknown,
      callback?: (error: Error | null) => void,
    ) => unknown;
    send(message, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
