import { createLogger } from './logger';

type DebugProbeData = Record<string, unknown>;

const log = createLogger('RestoreProbe');

function serializeProbeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    };
  }

  if (value instanceof Set) {
    return Array.from(value);
  }

  if (value instanceof Map) {
    return Object.fromEntries(value);
  }

  return value;
}

export function sendDebugProbe(
  location: string,
  message: string,
  data?: DebugProbeData
): void {
  const serializedData = data
    ? Object.fromEntries(
        Object.entries(data).map(([key, value]) => [key, serializeProbeValue(value)])
      )
    : undefined;

  log.info(message, {
    location,
    ...serializedData,
  });
}
