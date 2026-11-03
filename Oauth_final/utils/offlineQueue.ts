/**
 * offlineQueue.ts — Durable offline action queue for Taken/Skipped events.
 *
 * When the backend is unreachable (network error or non-5xx), actions are
 * stored locally and replayed in FIFO order the next time the device is online.
 *
 * Guarantees:
 * - Each entry carries a client-generated idempotency key so the server can
 *   deduplicate if the same action is submitted more than once on retry.
 * - The queue is persisted to AsyncStorage so it survives app restarts.
 * - Queue entries that have been accepted by the server are removed.
 * - Server 4xx responses are treated as permanent errors (not retried).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { authHeaders } from '@/utils/authStorage';
import { randomUUID } from 'expo-crypto';

const QUEUE_KEY = '@synergy/offline_action_queue';
const API_URL = process.env.EXPO_PUBLIC_API_URL;

export interface QueuedAction {
  /** Stable client-generated key to deduplicate on the server. */
  idempotencyKey: string;
  medicationId: string;
  occurrenceId: string | null;
  action: 'taken' | 'skipped';
  queuedAt: string; // ISO-8601
  occurredAt: string; // original patient action time; used to bind to the correct dose
  attempts: number;
  needsReview?: boolean;
}

async function readQueue(): Promise<QueuedAction[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as QueuedAction[];
  } catch {
    return [];
  }
}

async function writeQueue(queue: QueuedAction[]): Promise<void> {
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

/**
 * Enqueue a dose action to be submitted (or retried) when the network is available.
 */
export async function enqueueAction(
  medicationId: string,
  action: 'taken' | 'skipped',
  occurrenceId: string | null = null,
  occurredAt = new Date().toISOString()
): Promise<string> {
  const queue = await readQueue();
  const idempotencyKey = randomUUID();
  queue.push({
    idempotencyKey,
    medicationId,
    occurrenceId,
    action,
    queuedAt: new Date().toISOString(),
    occurredAt,
    attempts: 0,
  });
  await writeQueue(queue);
  return idempotencyKey;
}

/**
 * Attempt to flush all queued actions to the server.
 * Call this on app foreground or after confirming network is available.
 * Returns the number of successfully submitted actions.
 */
export async function flushQueue(): Promise<number> {
  if (!API_URL) return 0;
  const queue = await readQueue();
  if (queue.length === 0) return 0;

  const remaining: QueuedAction[] = [];
  let successCount = 0;

  for (const entry of queue) {
    if (entry.needsReview) {
      remaining.push(entry);
      continue;
    }
    try {
      const headers = await authHeaders();
      const response = await fetch(
        `${API_URL}/medications/${entry.medicationId}/action`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            action: entry.action,
            occurrenceId: entry.occurrenceId,
            idempotencyKey: entry.idempotencyKey,
            occurredAt: entry.occurredAt,
          }),
          signal: AbortSignal.timeout(10000),
        }
      );

      if (response.ok) {
        successCount++;
        continue; // Remove from queue
      }

      if (response.status === 401) {
        remaining.push({ ...entry, attempts: entry.attempts + 1 });
        continue;
      }

      if (response.status >= 400 && response.status < 500) {
        // Preserve stale/conflicting actions for patient review instead of losing them.
        remaining.push({ ...entry, attempts: entry.attempts + 1, needsReview: true });
        continue;
      }

      // 5xx or network error: keep for retry
      remaining.push({ ...entry, attempts: entry.attempts + 1 });
    } catch {
      // Network unavailable: keep for retry (cap at 20 attempts to avoid infinite growth)
      remaining.push({
        ...entry,
        attempts: entry.attempts + 1,
        needsReview: entry.attempts >= 20,
      });
    }
  }

  await writeQueue(remaining);
  return successCount;
}

/** Return the current number of pending queued actions. */
export async function pendingCount(): Promise<number> {
  const queue = await readQueue();
  return queue.length;
}

export async function needsReviewCount(): Promise<number> {
  const queue = await readQueue();
  return queue.filter((entry) => entry.needsReview).length;
}
